/**
 * Fase 97 — uma organização que recusou ou cancelou, ela mesma, uma atribuição de uma oportunidade não volta a recebê-la automaticamente.
 * Reproduzido na auditoria funcional: a organização cancelava a logística de uma atribuição aceita e, na MESMA requisição, a reabertura rodava o matching e criava
 * outra atribuição `aceita` para a mesma organização. Regras testadas (docs/ROADMAP_ATUAL.md, Fase 97):
 *  A) recusa/cancelamento explícito exclui o par para sempre; B) só o par (outras oportunidades seguem elegíveis); C) expiração automática e cancelada sem evidência do
 *  ator NÃO são recusa; D) histórico preservado; E) pontuação/limiares intactos; F) a atribuição manual do admin é exceção explícita e deixa marca na auditoria.
 * Tudo com PostgreSQL real, pelos endpoints/tarefas reais; concorrência determinística por travas seguradas numa conexão própria do teste.
 */
import { describe, it, expect, afterAll } from "vitest";
import postgres from "postgres";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { runMatchingForOpportunity } from "../src/helpers/opportunityMatching";
import { runMatchingSweep } from "../src/helpers/runMatchingSweep";
import { expireReservations } from "../src/helpers/expireReservations";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { handle as decideHandle } from "../src/endpoints/allocations-decide_POST";
import { handle as logisticsHandle } from "../src/endpoints/allocations-logistics_POST";
import { handle as receiveHandle } from "../src/endpoints/allocations-receive_POST";
import { handle as manualAllocateHandle } from "../src/endpoints/opportunity-allocations_POST";
import { createAuthenticatedUser, createPlatformAdmin, createTestOrganization, createTestSource, createTestOpportunityRegistry, createTestInventoryItem, addMembership, buildRequest } from "./helpers";

const side = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
afterAll(async () => { await side.end({ timeout: 5 }); });

type Party = { owner: Awaited<ReturnType<typeof createAuthenticatedUser>>; org: Awaited<ReturnType<typeof createTestOrganization>> };

async function party(withNeed = true): Promise<Party & { needId: number | null }> {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  let needId: number | null = null;
  if (withNeed) needId = await addNeed(org.id, owner.userId);
  return { owner, org, needId };
}
async function addNeed(orgId: number, userId: number, title = "Cobertores de inverno") {
  const [n] = await db.insertInto("needs").values({ organizationId: orgId, title, quantityNeeded: "30", unit: "unidade", priority: "critica", status: "aberta", createdByUserId: userId }).returning("id").execute();
  return n.id;
}
async function admin() {
  const a = await createPlatformAdmin(); const source = await createTestSource(a.userId);
  return { ...a, sourceId: source.id };
}
async function makeOpp(a: { userId: number; sourceId: number }, title = "Doação de cobertores de inverno", status: "aguardando_destinacao" | "reservada" = "aguardando_destinacao", quantity = "30") {
  const o = await createTestOpportunityRegistry(a.sourceId, a.userId, { status });
  await db.updateTable("opportunityRegistry").set({ title, status, locationCity: "Belo Horizonte", locationState: "MG", quantity }).where("id", "=", o.id).execute();
  return o.id;
}
const allocsOf = (oppId: number, orgId?: number) => {
  let q = db.selectFrom("opportunityAllocations").select(["id", "organizationId", "status", "autoMatched", "decidedByUserId"]).where("opportunityRegistryId", "=", oppId).orderBy("id");
  if (orgId !== undefined) q = q.where("organizationId", "=", orgId);
  return q.execute();
};
const active = async (oppId: number, orgId: number) => (await allocsOf(oppId, orgId)).filter((a) => a.status !== "recusada" && a.status !== "cancelada");
const oppStatus = async (id: number) => (await db.selectFrom("opportunityRegistry").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
const auditCount = async (action: string, entityId?: number) => {
  let q = db.selectFrom("auditLog").select((eb) => eb.fn.countAll().as("n")).where("action", "=", action);
  if (entityId !== undefined) q = q.where("entityId", "=", String(entityId));
  return Number((await q.executeTakeFirstOrThrow()).n);
};
const evalCount = async () => Number((await db.selectFrom("matchEvaluations").select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow()).n);
async function proposal(oppId: number, orgId: number) {
  const [a] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: oppId, organizationId: orgId, status: "proposta", quantityAllocated: "30", autoMatched: true, reservedUntil: new Date(Date.now() + 1_800_000) }).returning("id").execute();
  return a.id;
}
const decide = (p: Party, allocationId: number, decision: "aceita" | "recusada", cookie = p.owner.cookie, organizationId = p.org.id) =>
  decideHandle(buildRequest("allocations-decide", { method: "POST", cookie, body: { organizationId, allocationId, decision } }));
const cancelLogistics = (p: Party, allocationId: number, cookie = p.owner.cookie, organizationId = p.org.id) =>
  logisticsHandle(buildRequest("allocations-logistics", { method: "POST", cookie, body: { organizationId, allocationId, eventType: "cancelado", notes: "não conseguimos buscar" } }));

async function waitBlocked(n: number) {
  let c = 0;
  for (let i = 0; i < 400 && c < n; i++) {
    c = (await side`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0].n;
    if (c < n) await new Promise((r) => setTimeout(r, 25));
  }
  return c;
}
async function installAuditFailure(action: string) {
  await sql.raw(`CREATE OR REPLACE FUNCTION test_fail_audit() RETURNS trigger AS $f$ BEGIN IF NEW.action = '${action}' THEN RAISE EXCEPTION 'falha injetada na auditoria'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`).execute(db);
  await sql.raw("CREATE TRIGGER test_fail_audit_trg BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_fail_audit()").execute(db);
}
async function removeAuditFailure() {
  await sql.raw("DROP TRIGGER IF EXISTS test_fail_audit_trg ON audit_log").execute(db);
  await sql.raw("DROP FUNCTION IF EXISTS test_fail_audit()").execute(db);
}

describe("recusa explícita pela organização (decisão 'recusada')", () => {
  it("a organização recusa a proposta: a reabertura e as varreduras seguintes NÃO a escolhem de novo; outra organização compatível a recebe", async () => {
    const a = await party(false); const ad = await admin();
    const opp = await makeOpp(ad, undefined, "reservada");
    await addNeed(a.org.id, a.owner.userId);
    const refused = await proposal(opp, a.org.id);
    expect((await decide(a, refused, "recusada")).status).toBe(200);

    expect(await oppStatus(opp)).toBe("aguardando_destinacao"); // reabriu, e o matching da própria reabertura não devolveu a A
    expect(await active(opp, a.org.id)).toEqual([]);
    for (let i = 0; i < 3; i++) { await db.deleteFrom("backgroundTaskRuns").execute(); await runMatchingSweep(); } // varreduras sucessivas (a trava de execução é liberada entre elas)
    expect(await active(opp, a.org.id)).toEqual([]);
    expect(await oppStatus(opp)).toBe("aguardando_destinacao");

    const b = await party(); // outra organização compatível passa a existir
    await runMatchingSweep();
    expect((await active(opp, b.org.id)).length).toBe(1);
    expect(await active(opp, a.org.id)).toEqual([]);
    // histórico preservado: a atribuição recusada continua lá, com o ator
    const old = (await allocsOf(opp, a.org.id)).find((x) => x.id === refused)!;
    expect(old.status).toBe("recusada"); expect(old.decidedByUserId).toBe(a.owner.userId);
  });

  it("a restrição vale só para o PAR: a mesma organização segue elegível para uma oportunidade diferente", async () => {
    const a = await party(false); const ad = await admin();
    const oppRefused = await makeOpp(ad, undefined, "reservada");
    await addNeed(a.org.id, a.owner.userId);
    expect((await decide(a, await proposal(oppRefused, a.org.id), "recusada")).status).toBe(200);
    const other = await makeOpp(ad);
    const r = await runMatchingForOpportunity(other, ad.userId);
    expect(r.allocationsCreated.map((x) => x.organizationId)).toEqual([a.org.id]);
    const again = await runMatchingForOpportunity(oppRefused, ad.userId);
    expect(again.allocationsCreated).toEqual([]);
  });
});

describe("cancelamento explícito pela organização (logística 'cancelado')", () => {
  it("o caso reproduzido na auditoria: cancelar a atribuição aceita não gera, na mesma requisição, outra atribuição para a mesma organização", async () => {
    const a = await party(); const ad = await admin();
    const opp = await makeOpp(ad);
    expect((await runMatchingForOpportunity(opp, ad.userId)).allocationsCreated).toHaveLength(1);
    const first = (await allocsOf(opp, a.org.id))[0];
    expect((await cancelLogistics(a, first.id)).status).toBe(200);

    const all = await allocsOf(opp, a.org.id);
    expect(all.map((x) => x.status)).toEqual(["cancelada"]); // nenhuma nova atribuição
    expect(await oppStatus(opp)).toBe("aguardando_destinacao");
    for (let i = 0; i < 3; i++) { await db.deleteFrom("backgroundTaskRuns").execute(); await runMatchingSweep(); }
    expect((await allocsOf(opp, a.org.id)).map((x) => x.status)).toEqual(["cancelada"]);
  });

  it("a oportunidade segue elegível para outra organização (pontuação e quantidade normais: atribuição aceita de 30)", async () => {
    const a = await party(); const ad = await admin();
    const opp = await makeOpp(ad);
    await runMatchingForOpportunity(opp, ad.userId);
    await cancelLogistics(a, (await allocsOf(opp, a.org.id))[0].id);
    const b = await party();
    await runMatchingSweep();
    const bAllocs = await active(opp, b.org.id);
    expect(bAllocs).toHaveLength(1);
    expect(bAllocs[0].status).toBe("aceita"); // nota alta: mesmo comportamento de sempre
    expect(await oppStatus(opp)).toBe("atribuida");
    const qty = await db.selectFrom("opportunityAllocations").select("quantityAllocated").where("id", "=", bAllocs[0].id).executeTakeFirstOrThrow();
    expect(Number(qty.quantityAllocated)).toBe(30);
  });

  it("fim a fim: A cancela, B recebe, a oportunidade conclui (estados legítimos de recebimento e conclusão preservados)", async () => {
    const a = await party(); const ad = await admin();
    const opp = await makeOpp(ad);
    await runMatchingForOpportunity(opp, ad.userId);
    await cancelLogistics(a, (await allocsOf(opp, a.org.id))[0].id);
    const b = await party(); await runMatchingSweep();
    const bAlloc = (await active(opp, b.org.id))[0];
    const item = await createTestInventoryItem(b.org.id, b.owner.userId, { name: "Cobertor", unit: "unidade" });
    const res = await receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: b.owner.cookie, body: { organizationId: b.org.id, allocationId: bAlloc.id, itemId: item.id, quantityReceived: 30 } }));
    expect(res.status).toBe(200);
    expect(await oppStatus(opp)).toBe("concluida");
  });
});

describe("o que NÃO é recusa explícita", () => {
  it("expiração automática da reserva: a organização continua elegível e pode ser proposta de novo", async () => {
    const a = await party(false); const ad = await admin();
    const opp = await makeOpp(ad, undefined, "reservada");
    await addNeed(a.org.id, a.owner.userId);
    const [exp] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: opp, organizationId: a.org.id, status: "proposta", quantityAllocated: "30", autoMatched: true, reservedUntil: new Date(Date.now() - 60_000) }).returning("id").execute();
    await expireReservations();
    expect((await allocsOf(opp, a.org.id)).find((x) => x.id === exp.id)!.status).toBe("cancelada");
    // a própria tarefa já reavaliou: a mesma organização recebeu uma nova atribuição (expirar não é recusar)
    expect((await active(opp, a.org.id)).length).toBe(1);
  });

  it("'cancelada' sem evidência do ator (sem evento de logística) não conta como recusa", async () => {
    const a = await party(); const ad = await admin();
    const opp = await makeOpp(ad);
    await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: opp, organizationId: a.org.id, status: "cancelada", quantityAllocated: "30", autoMatched: true }).execute();
    const r = await runMatchingForOpportunity(opp, ad.userId);
    expect(r.allocationsCreated.map((x) => x.organizationId)).toEqual([a.org.id]);
  });

  it("cancelamento com evento de logística de OUTRA atribuição não contamina o par: só o evento da própria atribuição vale", async () => {
    const a = await party(); const b = await party(); const ad = await admin();
    const oppX = await makeOpp(ad); const oppY = await makeOpp(ad);
    await runMatchingForOpportunity(oppX, ad.userId);
    const aX = (await allocsOf(oppX)).find((x) => x.organizationId === a.org.id) ?? (await allocsOf(oppX))[0];
    const owner = aX.organizationId === a.org.id ? a : b;
    await cancelLogistics(owner, aX.id);
    // a oportunidade Y nunca teve atribuição de ninguém: ambas seguem elegíveis (A ou B é escolhida)
    const r = await runMatchingForOpportunity(oppY, ad.userId);
    expect(r.allocationsCreated).toHaveLength(1);
  });
});

describe("atomicidade, autorização e isolamento", () => {
  it("falha REAL ao auditar a recusa: nada persiste (a atribuição segue proposta e a organização NÃO fica excluída); o retry funciona", async () => {
    const a = await party(false); const ad = await admin();
    const opp = await makeOpp(ad, undefined, "reservada");
    await addNeed(a.org.id, a.owner.userId);
    const alloc = await proposal(opp, a.org.id);
    await installAuditFailure("atribuicao.recusada");
    try {
      expect((await decide(a, alloc, "recusada")).status).toBe(500);
      expect((await allocsOf(opp, a.org.id)).find((x) => x.id === alloc)!.status).toBe("proposta");
      expect(await oppStatus(opp)).toBe("reservada");
    } finally { await removeAuditFailure(); }
    expect((await decide(a, alloc, "recusada")).status).toBe(200);
    expect((await allocsOf(opp, a.org.id)).find((x) => x.id === alloc)!.status).toBe("recusada");
  });

  it("outra organização não consegue registrar a recusa por ela (403/404), sem efeito no histórico; sem permissão também falha", async () => {
    const a = await party(false); const b = await party(false); const ad = await admin();
    const opp = await makeOpp(ad, undefined, "reservada");
    await addNeed(a.org.id, a.owner.userId);
    const alloc = await proposal(opp, a.org.id);
    expect((await decide(a, alloc, "recusada", b.owner.cookie)).status).toBe(403); // membro só da B, tentando agir pela A
    expect((await decide(b, alloc, "recusada")).status).toBe(404); // pela B: a atribuição não é da B
    const vol = await createAuthenticatedUser(); await addMembership(a.org.id, vol.userId, "voluntario", "ativo");
    expect((await decide(a, alloc, "recusada", vol.cookie)).status).toBe(403);
    expect((await cancelLogistics(b, alloc)).status).toBe(404);
    expect((await allocsOf(opp, a.org.id))[0].status).toBe("proposta");
    expect((await runMatchingForOpportunity(opp, ad.userId)).allocationsCreated).toEqual([]); // A está ativa, não excluída por engano de ninguém
  });
});

describe("concorrência entre a decisão da organização e o matching", () => {
  it("matching rodando com a oportunidade travada enquanto a recusa chega: a recusa espera, e o rematch posterior respeita a exclusão", async () => {
    const a = await party(false); const ad = await admin();
    const opp = await makeOpp(ad, undefined, "reservada");
    await addNeed(a.org.id, a.owner.userId);
    const alloc = await proposal(opp, a.org.id);
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    let started!: () => void; const locked = new Promise<void>((r) => { started = r; });
    const matcher = side.begin(async (tx) => { await tx`SELECT id FROM opportunity_registry WHERE id = ${opp} FOR UPDATE`; started(); await held; });
    await locked;
    const refusing = decide(a, alloc, "recusada"); // trava a atribuição e espera a trava da oportunidade (reabertura)
    expect(await waitBlocked(1)).toBeGreaterThanOrEqual(1);
    release(); await matcher;
    expect((await refusing).status).toBe(200);
    expect(await active(opp, a.org.id)).toEqual([]);
    expect((await allocsOf(opp, a.org.id)).map((x) => x.status)).toEqual(["recusada"]);
  });

  it("recusa ainda não confirmada: o matching vê a atribuição como ativa (não duplica); depois da confirmação, a exclusão passa a valer", async () => {
    const a = await party(false); const ad = await admin();
    const opp = await makeOpp(ad, undefined, "reservada");
    await addNeed(a.org.id, a.owner.userId);
    const alloc = await proposal(opp, a.org.id);
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    let started!: () => void; const locked = new Promise<void>((r) => { started = r; });
    const refusing = side.begin(async (tx) => { // a recusa no meio da transação: atribuição travada e já marcada, ainda sem confirmar
      await tx`SELECT id FROM opportunity_allocations WHERE id = ${alloc} FOR UPDATE`;
      await tx`UPDATE opportunity_allocations SET status = 'recusada' WHERE id = ${alloc}`;
      started(); await held;
    });
    await locked;
    const during = await runMatchingForOpportunity(opp, ad.userId); // estado confirmado: ainda ativa
    expect(during.allocationsCreated).toEqual([]);
    release(); await refusing;
    const after = await runMatchingForOpportunity(opp, ad.userId); // agora recusada: excluída
    expect(after.allocationsCreated).toEqual([]);
    expect((await allocsOf(opp, a.org.id)).map((x) => x.status)).toEqual(["recusada"]);
  });

  it("varreduras e matchings simultâneos depois da recusa: nenhuma atribuição inelegível; só a organização elegível recebe, uma vez", async () => {
    const a = await party(false); const ad = await admin();
    const opp = await makeOpp(ad, undefined, "reservada");
    await addNeed(a.org.id, a.owner.userId);
    await decide(a, await proposal(opp, a.org.id), "recusada");
    const b = await party();
    await Promise.all([runMatchingSweep(), runMatchingSweep(), runMatchingForOpportunity(opp, ad.userId), runMatchingForOpportunity(opp, null)]);
    expect(await active(opp, a.org.id)).toEqual([]);
    expect((await active(opp, b.org.id)).length).toBe(1);
  });
});

describe("histórico, auditoria e invariantes das fases anteriores", () => {
  it("avaliações e atribuições anteriores não são apagadas, a auditoria não cresce com varreduras repetidas e a cadeia continua íntegra", async () => {
    const a = await party(); const ad = await admin();
    const opp = await makeOpp(ad);
    await runMatchingForOpportunity(opp, ad.userId);
    const evalsBefore = await evalCount();
    await cancelLogistics(a, (await allocsOf(opp, a.org.id))[0].id);
    expect(await evalCount()).toBeGreaterThanOrEqual(evalsBefore); // nada foi removido
    await runMatchingSweep();
    const matchingAudit = await auditCount("matching.executado");
    const evalsAfter = await evalCount();
    for (let i = 0; i < 4; i++) { await db.deleteFrom("backgroundTaskRuns").execute(); await runMatchingSweep(); }
    expect(await auditCount("matching.executado")).toBe(matchingAudit); // sem mudança relevante: nada novo (Fase 95)
    expect(await evalCount()).toBe(evalsAfter);
    const exec = await db.selectFrom("auditLog").select("metadata").where("action", "=", "matching.executado").where("entityId", "=", String(opp)).orderBy("id", "desc").limit(1).executeTakeFirstOrThrow();
    expect((exec.metadata as { organizacoesExcluidasPorRecusa?: number[] }).organizacoesExcluidasPorRecusa).toEqual([a.org.id]); // explicável para quem audita
    const chain = await verifyAuditLogChain();
    expect(chain.integra).toBe(true);
  });

  it("atribuição MANUAL do admin continua permitida (exceção explícita, mesmas permissões) e deixa a marca de reatribuição após recusa na auditoria; sem recusa prévia não há marca", async () => {
    const a = await party(false); const ad = await admin();
    const opp = await makeOpp(ad, undefined, "reservada");
    const refused = await proposal(opp, a.org.id);
    await decide(a, refused, "recusada");
    const manual = (org: number, cookie = ad.cookie, confirm = true) => manualAllocateHandle(buildRequest("opportunity-allocations", { method: "POST", cookie, body: { opportunityId: opp, organizationId: org, quantityAllocated: 10, ...(confirm ? { confirmPriorRefusal: true } : {}) } })); // Fase 98: com recusa anterior o servidor exige a confirmação explícita
    expect((await manual(a.org.id, a.owner.cookie)).status).toBe(403); // continua só para admin da plataforma
    expect((await manual(a.org.id)).status).toBe(200);
    const audit = await db.selectFrom("auditLog").select("metadata").where("action", "=", "atribuicao.proposta").where("organizationId", "=", a.org.id).executeTakeFirstOrThrow();
    expect(audit.metadata).toMatchObject({ reatribuicaoAposRecusaExplicita: true, atribuicoesRecusadasAnteriores: [{ id: refused, status: "recusada" }] });
    const b = await party(false);
    expect((await manual(b.org.id)).status).toBe(200);
    const auditB = await db.selectFrom("auditLog").select("metadata").where("action", "=", "atribuicao.proposta").where("organizationId", "=", b.org.id).executeTakeFirstOrThrow();
    expect(auditB.metadata).not.toHaveProperty("reatribuicaoAposRecusaExplicita");
  });
});
