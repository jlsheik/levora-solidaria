/**
 * Fase 96 — recebimento de doações locais (`donation_opportunities`) idempotente e seguro sob concorrência.
 * Defeito reproduzido na auditoria funcional: duas requisições simultâneas para a mesma oferta de 10 unidades responderam 200/200 e lançaram 20 unidades, porque
 * `opportunities-receive_POST` lia o status SEM travar a linha (a única trava era a do item) e `opportunities-status_POST` não travava nada.
 *
 * Concorrência REAL e determinística: o teste segura a trava das linhas dos itens numa transação própria, dispara as requisições (que ficam esperando no banco) e só
 * então solta — sem atrasos arbitrários. Falhas são injetadas no banco (gatilho na auditoria), não com mocks. O contrato HTTP existente é preservado: segunda
 * chamada = 409 "já foi recebida"; cancelada = 409; inexistente/outra organização = 404; sem permissão = 403.
 * FORA DO ESCOPO (decisão de produto pendente): `linked_need_id` continua sem efeito no ledger — nenhum teste aqui espera linha em need_fulfillments.
 */
import { describe, it, expect, afterAll } from "vitest";
import postgres from "postgres";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { handle as receiveHandle } from "../src/endpoints/opportunities-receive_POST";
import { handle as statusHandle } from "../src/endpoints/opportunities-status_POST";
import { getItemStockBalance } from "../src/helpers/stockBalance";
import { createAuthenticatedUser, createTestOrganization, createTestInventoryItem, addMembership, buildRequest, parseJson } from "./helpers";

async function setup() {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const itemA = await createTestInventoryItem(org.id, owner.userId, { name: "Arroz", unit: "kg" });
  const itemB = await createTestInventoryItem(org.id, owner.userId, { name: "Feijão", unit: "kg" });
  const [opp] = await db.insertInto("donationOpportunities").values({ organizationId: org.id, title: "Oferta de arroz", donorName: "Mercado Central", quantityOffered: "10", unit: "kg", createdByUserId: owner.userId }).returning("id").execute();
  return { owner, org, itemA, itemB, oppId: opp.id };
}
type S = Awaited<ReturnType<typeof setup>>;

const receive = (s: S, over: Record<string, unknown> = {}, cookie = s.owner.cookie) =>
  receiveHandle(buildRequest("opportunities-receive", { method: "POST", cookie, body: { organizationId: s.org.id, opportunityId: s.oppId, itemId: s.itemA.id, quantityReceived: 10, ...over } }));
const setStatus = (s: S, status: string, cookie = s.owner.cookie) =>
  statusHandle(buildRequest("opportunities-status", { method: "POST", cookie, body: { organizationId: s.org.id, opportunityId: s.oppId, status } }));

const entries = async () => db.selectFrom("stockTransactions").select(["itemId", "delta", "type"]).execute();
const totalDelta = async () => (await entries()).reduce((sum, t) => sum + Number(t.delta), 0);
const oppRow = async (id: number) => db.selectFrom("donationOpportunities").select(["status"]).where("id", "=", id).executeTakeFirstOrThrow();
const auditCount = async (action: string) => Number((await db.selectFrom("auditLog").select((eb) => eb.fn.countAll().as("n")).where("action", "=", action).executeTakeFirstOrThrow()).n);

/**
 * Conexão PRÓPRIA do teste (o pool da aplicação tem só 3 conexões: o titular da trava e a sondagem não podem disputá-las com as requisições).
 * Segura `FOR UPDATE` nas linhas dos itens enquanto `during` dispara as requisições; espera até `waiters` consultas ficarem bloqueadas no banco (Lock) e só então solta.
 */
const side = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
afterAll(async () => { await side.end({ timeout: 5 }); });

async function waitBlocked(waiters: number) {
  let n = 0;
  for (let i = 0; i < 400 && n < waiters; i++) {
    n = (await side`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0].n;
    if (n < waiters) await new Promise((r) => setTimeout(r, 25));
  }
  return n;
}

async function withItemsHeld<T>(itemIds: number[], waiters: number, during: () => Promise<T>): Promise<T> {
  let release!: () => void; const held = new Promise<void>((r) => { release = r; });
  let started!: () => void; const locked = new Promise<void>((r) => { started = r; });
  const holder = side.begin(async (tx) => {
    await tx`SELECT id FROM inventory_items WHERE id = ANY(${itemIds}) ORDER BY id FOR UPDATE`;
    started(); await held;
  });
  await locked;
  const work = during();
  let n = 0;
  try {
    for (let i = 0; i < 400 && n < waiters; i++) { // limite de segurança: é só espera por um estado do banco, nunca "tempo para a corrida acontecer"
      n = (await side`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0].n;
      if (n < waiters) await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    release(); await holder; // sempre solta a trava, mesmo se a espera falhar
  }
  expect(n, "as requisições deveriam estar bloqueadas no banco").toBeGreaterThanOrEqual(waiters);
  return work;
}

async function installAuditFailure(action: string) {
  await sql.raw(`CREATE OR REPLACE FUNCTION test_fail_audit() RETURNS trigger AS $f$ BEGIN IF NEW.action = '${action}' THEN RAISE EXCEPTION 'falha injetada na auditoria'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`).execute(db);
  await sql.raw("CREATE TRIGGER test_fail_audit_trg BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_fail_audit()").execute(db);
}
async function removeAuditFailure() {
  await sql.raw("DROP TRIGGER IF EXISTS test_fail_audit_trg ON audit_log").execute(db);
  await sql.raw("DROP FUNCTION IF EXISTS test_fail_audit()").execute(db);
}

describe("recebimento de doação local: caminho normal", () => {
  it("uma entrada de estoque com a quantidade correta, oportunidade recebida e uma auditoria", async () => {
    const s = await setup();
    const res = await receive(s);
    expect(res.status).toBe(200);
    const body = await parseJson<{ opportunity: { status: string }; stockTransactionId: string; newStock: number }>(res);
    expect(body.opportunity.status).toBe("recebida");
    expect(body.newStock).toBe(10);
    expect(await entries()).toEqual([{ itemId: s.itemA.id, delta: "10.000", type: "entrada" }]);
    expect(await getItemStockBalance(db, s.itemA.id)).toBe(10);
    expect(await auditCount("oportunidade.recebida")).toBe(1);
    // fora do escopo (decisão de produto pendente): nada no ledger de necessidades
    expect(Number((await db.selectFrom("needFulfillments").select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow()).n)).toBe(0);
  });
});

describe("recebimento duplicado: concorrência, retry e payloads diferentes", () => {
  it("duas requisições SIMULTÂNEAS para a mesma oferta de 10: uma efetiva (200), a outra recebe 409; estoque 10, nunca 20", async () => {
    const s = await setup();
    const [r1, r2] = await withItemsHeld([s.itemA.id], 2, () => Promise.all([receive(s), receive(s)]));
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await totalDelta()).toBe(10);
    expect((await entries()).length).toBe(1);
    expect(await auditCount("oportunidade.recebida")).toBe(1);
    expect((await oppRow(s.oppId)).status).toBe("recebida");
  });

  it("duas requisições simultâneas com ITENS e quantidades diferentes: só a primeira a obter a trava vale; a outra não cria movimentação nem altera nada", async () => {
    const s = await setup();
    const [r1, r2] = await withItemsHeld([s.itemA.id, s.itemB.id], 2, () => Promise.all([receive(s, { itemId: s.itemA.id, quantityReceived: 10 }), receive(s, { itemId: s.itemB.id, quantityReceived: 7 })]));
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const all = await entries();
    expect(all).toHaveLength(1);
    const winner = r1.status === 200 ? { itemId: s.itemA.id, delta: 10 } : { itemId: s.itemB.id, delta: 7 };
    expect(all[0].itemId).toBe(winner.itemId);
    expect(Number(all[0].delta)).toBe(winner.delta);
    expect(await auditCount("oportunidade.recebida")).toBe(1);
    const loserItem = winner.itemId === s.itemA.id ? s.itemB.id : s.itemA.id;
    expect(await getItemStockBalance(db, loserItem)).toBe(0);
  });

  it("muitas requisições simultâneas (8): exatamente uma efetiva", async () => {
    const s = await setup();
    const rs = await withItemsHeld([s.itemA.id], 3, () => Promise.all(Array.from({ length: 8 }, () => receive(s))));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(7);
    expect(await totalDelta()).toBe(10);
    expect(await auditCount("oportunidade.recebida")).toBe(1);
  });

  it("retry depois de uma resposta perdida (mesma requisição de novo) e chamada posterior com outro payload: 409 e nenhum efeito novo", async () => {
    const s = await setup();
    expect((await receive(s)).status).toBe(200);
    const retry = await receive(s);
    expect(retry.status).toBe(409);
    expect((await parseJson<{ message: string }>(retry)).message).toMatch(/já foi recebida/);
    expect((await receive(s, { itemId: s.itemB.id, quantityReceived: 99 })).status).toBe(409);
    expect(await totalDelta()).toBe(10);
    expect((await entries()).length).toBe(1);
    expect(await auditCount("oportunidade.recebida")).toBe(1);
  });
});

describe("recebimento × mudança de status (recebimento e cancelamento não se cruzam)", () => {
  it("cancelamento concorrente com o recebimento: o recebimento já em curso (com a oferta travada) vence e o cancelamento espera, vê 'recebida' e recebe 409; sem estoque ou auditoria incoerentes", async () => {
    const s = await setup();
    const [rcv, cancel] = await withItemsHeld([s.itemA.id], 2, async () => {
      const r = receive(s);
      expect(await waitBlocked(1)).toBeGreaterThanOrEqual(1); // o recebimento já travou a oferta e espera pelo item
      const c = setStatus(s, "cancelada"); // chega com a oferta travada: tem de esperar
      return Promise.all([r, c]);
    });
    expect(rcv.status).toBe(200); expect(cancel.status).toBe(409);
    expect((await oppRow(s.oppId)).status).toBe("recebida");
    expect(await totalDelta()).toBe(10);
    expect(await auditCount("oportunidade.recebida")).toBe(1);
    expect(await auditCount("oportunidade.atualizada")).toBe(0); // o cancelamento perdedor não deixou auditoria dizendo o contrário
  });

  it("cancelamento já em curso (oferta travada) vence o recebimento: o recebimento espera, vê 'cancelada' e recebe 409, sem estoque nem auditoria de recebimento", async () => {
    const s = await setup();
    // segura a LINHA DA OFERTA (como se um cancelamento estivesse no meio da transação), dispara o recebimento e só então confirma o cancelamento
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    let started!: () => void; const locked = new Promise<void>((r) => { started = r; });
    const canceller = side.begin(async (tx) => {
      await tx`SELECT id FROM donation_opportunities WHERE id = ${s.oppId} FOR UPDATE`;
      await tx`UPDATE donation_opportunities SET status = 'cancelada' WHERE id = ${s.oppId}`;
      started(); await held;
    });
    await locked;
    const rcv = receive(s);
    expect(await waitBlocked(1)).toBeGreaterThanOrEqual(1);
    release(); await canceller;
    const res = await rcv;
    expect(res.status).toBe(409);
    expect((await oppRow(s.oppId)).status).toBe("cancelada");
    expect((await entries()).length).toBe(0);
    expect(await auditCount("oportunidade.recebida")).toBe(0);
  });

  it("depois de cancelada, o recebimento é recusado (409) sem movimentação; depois de recebida, qualquer troca de status é recusada (409)", async () => {
    const s = await setup();
    expect((await setStatus(s, "cancelada")).status).toBe(200);
    expect((await receive(s)).status).toBe(409);
    expect((await entries()).length).toBe(0);

    const t = await setup();
    expect((await receive(t)).status).toBe(200);
    for (const st of ["cancelada", "confirmada", "registrada"]) expect((await setStatus(t, st)).status, st).toBe(409);
    expect((await oppRow(t.oppId)).status).toBe("recebida");
  });

  it("transições válidas preservadas: registrada → em_contato → confirmada → recebida; cancelada pode voltar a registrada e então ser recebida", async () => {
    const s = await setup();
    for (const st of ["em_contato", "confirmada"]) expect((await setStatus(s, st)).status, st).toBe(200);
    expect((await receive(s)).status).toBe(200);

    const t = await setup();
    expect((await setStatus(t, "cancelada")).status).toBe(200);
    expect((await setStatus(t, "registrada")).status).toBe(200);
    expect((await receive(t)).status).toBe(200);
  });

  it("duas trocas de status simultâneas não deixam estado ou auditoria incoerentes (cada uma audita o estado anterior real)", async () => {
    const s = await setup();
    const rs = await Promise.all([setStatus(s, "em_contato"), setStatus(s, "confirmada")]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    const audits = await db.selectFrom("auditLog").select("metadata").where("action", "=", "oportunidade.atualizada").orderBy("id").execute();
    expect(audits).toHaveLength(2);
    const chain = audits.map((a) => (a.metadata as { statusAnterior: string; statusNovo: string }));
    expect(chain[1].statusAnterior).toBe(chain[0].statusNovo); // a segunda parte do resultado da primeira (serializadas pela trava)
    expect((await oppRow(s.oppId)).status).toBe(chain[1].statusNovo);
  });
});

describe("atomicidade, validação, autorização e isolamento", () => {
  it("falha REAL ao gravar a auditoria: nada é confirmado (sem estoque, status intacto); sem a falha, o retry efetiva uma vez", async () => {
    const s = await setup();
    await installAuditFailure("oportunidade.recebida");
    try {
      const res = await receive(s);
      expect(res.status).toBe(500);
      expect((await entries()).length).toBe(0);
      expect((await oppRow(s.oppId)).status).toBe("registrada");
      expect(await auditCount("oportunidade.recebida")).toBe(0);
    } finally { await removeAuditFailure(); }
    expect((await receive(s)).status).toBe(200);
    expect(await totalDelta()).toBe(10);
    expect(await auditCount("oportunidade.recebida")).toBe(1);
  });

  it("validação (quantidade zero, negativa, item de outra organização/inexistente) e autorização (sem sessão, sem permissão, membro de outra organização): nenhuma movimentação", async () => {
    const s = await setup();
    expect((await receive(s, { quantityReceived: 0 })).status).toBe(400);
    expect((await receive(s, { quantityReceived: -5 })).status).toBe(400);
    expect((await receive(s, { itemId: 999999 })).status).toBe(404);

    const other = await createAuthenticatedUser(); const otherOrg = await createTestOrganization(other.userId);
    const foreignItem = await createTestInventoryItem(otherOrg.id, other.userId, { name: "Item alheio" });
    expect((await receive(s, { itemId: foreignItem.id })).status).toBe(404);

    expect((await receive(s, {}, "")).status).toBe(401);
    const volunteer = await createAuthenticatedUser(); await addMembership(s.org.id, volunteer.userId, "voluntario", "ativo");
    expect((await receive(s, {}, volunteer.cookie)).status).toBe(403);
    expect((await receive(s, {}, other.cookie)).status).toBe(403); // organização A, mas membro só da B
    expect((await entries()).length).toBe(0);
    expect((await oppRow(s.oppId)).status).toBe("registrada");
    expect(await auditCount("oportunidade.recebida")).toBe(0);
  });

  it("isolamento: a oferta da organização A não é visível pela B (404) e a B não consegue recebê-la nem mudar seu status", async () => {
    const s = await setup();
    const other = await createAuthenticatedUser(); const otherOrg = await createTestOrganization(other.userId);
    const otherItem = await createTestInventoryItem(otherOrg.id, other.userId, { name: "Estoque B" });
    const res = await receiveHandle(buildRequest("opportunities-receive", { method: "POST", cookie: other.cookie, body: { organizationId: otherOrg.id, opportunityId: s.oppId, itemId: otherItem.id, quantityReceived: 10 } }));
    expect(res.status).toBe(404);
    const st = await statusHandle(buildRequest("opportunities-status", { method: "POST", cookie: other.cookie, body: { organizationId: otherOrg.id, opportunityId: s.oppId, status: "cancelada" } }));
    expect(st.status).toBe(404);
    expect((await oppRow(s.oppId)).status).toBe("registrada");
    expect((await entries()).length).toBe(0);
  });

  it("recebimentos de ofertas DIFERENTES (mesma organização, mesmo item) continuam independentes e somam", async () => {
    const s = await setup();
    const [opp2] = await db.insertInto("donationOpportunities").values({ organizationId: s.org.id, title: "Outra oferta", donorName: "Padaria", unit: "kg", createdByUserId: s.owner.userId }).returning("id").execute();
    const [a, b] = await withItemsHeld([s.itemA.id], 2, () => Promise.all([receive(s, { quantityReceived: 10 }), receive(s, { opportunityId: opp2.id, quantityReceived: 4 })]));
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await getItemStockBalance(db, s.itemA.id)).toBe(14);
    expect(await auditCount("oportunidade.recebida")).toBe(2);
  });
});
