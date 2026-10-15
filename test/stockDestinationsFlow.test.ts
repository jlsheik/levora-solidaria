/**
 * Fase 99E — registro ATÔMICO de saída física + destinação (PostgreSQL real, banco `_test`). Prova: atomicidade (falhas injetadas), idempotência persistente, risco e segunda
 * aprovação, datas no fuso de negócio, as oito finalidades, autorização e isolamento, concorrência e que nenhuma rota cria saída sem destinação.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { getItemStockBalance } from "../src/helpers/stockBalance";
import { businessDateOf, checkEffectiveDate, civilDaysBetween, parseCivilDate } from "../src/helpers/businessDate";
import { DESTINATION_TYPES, evaluateDestinationRisk } from "../src/helpers/destinationRules";
import { handle as destHandle } from "../src/endpoints/stock-destinations_POST";
import { handle as stockHandle } from "../src/endpoints/stock-transactions_POST";
import { handle as decideHandle } from "../src/endpoints/approval-requests-decide_POST";
import { handle as needStatusHandle } from "../src/endpoints/needs-status_POST";
import { addMembership, buildRequest, createAuthenticatedUser, createTestInventoryItem, createTestOrganization, parseJson } from "./helpers";

type Auth = Awaited<ReturnType<typeof createAuthenticatedUser>>;
const post = (p: string, cookie: string, body: unknown) => buildRequest(p, { method: "POST", cookie, body });
const key = () => `k-${randomBytes(8).toString("hex")}`;
const today = () => businessDateOf(new Date());
const daysAgo = (n: number) => {
  const t = parseCivilDate(today())!;
  const d = new Date(Date.UTC(t.y, t.m - 1, t.d - n));
  return d.toISOString().slice(0, 10);
};

async function world(opts: { balance?: number; unit?: string } = {}) {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const admin = await createAuthenticatedUser();
  await addMembership(org.id, admin.userId, "administrador");
  const operator = await createAuthenticatedUser();
  await addMembership(org.id, operator.userId, "operador");
  const volunteer = await createAuthenticatedUser();
  await addMembership(org.id, volunteer.userId, "voluntario");
  const item = await createTestInventoryItem(org.id, owner.userId, { name: "Arroz", unit: opts.unit ?? "kg" });
  if ((opts.balance ?? 100) > 0) await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: item.id, type: "entrada", delta: String(opts.balance ?? 100), reason: "saldo inicial", createdByUserId: owner.userId }).execute();
  return { owner, admin, operator, volunteer, org, item };
}
type W = Awaited<ReturnType<typeof world>>;

const body = (w: W, over: Record<string, unknown> = {}) => ({
  organizationId: w.org.id,
  itemId: w.item.id,
  quantity: 5,
  destinationType: "distribuicao_familias",
  deliveredOn: today(),
  idempotencyKey: key(),
  ...over,
});
const dest = (w: W, over: Record<string, unknown> = {}, user: Auth = w.operator) => destHandle(post("stock-destinations", user.cookie, body(w, over)));
const stock = (w: W) => getItemStockBalance(db as never, w.item.id).catch(async () => Number((await db.selectFrom("stockTransactions").select(sql<string>`COALESCE(SUM(delta),0)`.as("t")).where("itemId", "=", w.item.id).executeTakeFirstOrThrow()).t));
const balance = async (w: W) => Number((await db.selectFrom("stockTransactions").select(sql<string>`COALESCE(SUM(delta),0)`.as("t")).where("itemId", "=", w.item.id).executeTakeFirstOrThrow()).t);
const exits = (w: W) => db.selectFrom("stockTransactions").selectAll().where("itemId", "=", w.item.id).where("type", "=", "saida").execute();
const dests = (w: W) => db.selectFrom("stockDestinations").selectAll().where("organizationId", "=", w.org.id).execute();
const audits = (action: string) => db.selectFrom("auditLog").select(["actorUserId", "metadata", "entityId"]).where("action", "=", action).execute();
const decide = (w: W, requestId: number, decision: "aprovada" | "rejeitada", user: Auth = w.admin) => decideHandle(post("approval-requests-decide", user.cookie, { organizationId: w.org.id, requestId, decision }));
void stock;

async function installFailure(table: "stock_destinations" | "audit_log", condition: string) {
  await sql.raw(`CREATE OR REPLACE FUNCTION test_fail_insert() RETURNS trigger AS $f$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'falha injetada'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`).execute(db);
  await sql.raw(`CREATE TRIGGER test_fail_insert_trg BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION test_fail_insert()`).execute(db);
}
async function removeFailure(table: "stock_destinations" | "audit_log") {
  await sql.raw(`DROP TRIGGER IF EXISTS test_fail_insert_trg ON ${table}`).execute(db);
  await sql.raw("DROP FUNCTION IF EXISTS test_fail_insert()").execute(db);
}

describe("A. registro atômico", () => {
  it("1/2/3: saída válida cria UMA movimentação e UMA destinação, com a mesma quantidade e a unidade canônica do item", async () => {
    const w = await world();
    const res = await dest(w, { quantity: 5, peopleServed: 12, peopleUnit: "familias", notes: "entrega no bairro" });
    expect(res.status).toBe(200);
    const out = await parseJson<{ requiresApproval: boolean; replayed: boolean; newStock: number; destination: { isCountable: boolean } }>(res);
    expect(out).toMatchObject({ requiresApproval: false, replayed: false, newStock: 95 });
    const e = await exits(w);
    const d = await dests(w);
    expect(e).toHaveLength(1);
    expect(d).toHaveLength(1);
    expect(Number(e[0].delta)).toBe(-5);
    expect(Number(d[0].quantity)).toBe(5);
    expect(d[0]).toMatchObject({ entryType: "original", unit: "kg", destinationType: "distribuicao_familias", peopleServed: 12, peopleUnit: "familias", createdByUserId: w.operator.userId });
    expect(String(d[0].stockTransactionId)).toBe(String(e[0].id));
    expect(await balance(w)).toBe(95);
    const [req] = await db.selectFrom("stockExitRequests").selectAll().where("organizationId", "=", w.org.id).execute();
    expect(req).toMatchObject({ status: "executada" });
    expect(String(req.stockDestinationId)).toBe(String(d[0].id));
    expect((await audits("destinacao.registrada")).length).toBe(1);
    expect((await audits("inventario.saida_registrada")).length).toBe(1);
  });

  it("4: falha ao criar a destinação reverte a saída; 5: falha na auditoria reverte saída e destinação; depois a mesma chave funciona", async () => {
    const w = await world();
    const k = key();
    await installFailure("stock_destinations", "NEW.notes = 'FALHA-DESTINO'");
    try {
      expect((await dest(w, { idempotencyKey: k, notes: "FALHA-DESTINO" })).status).toBeGreaterThanOrEqual(500);
    } finally { await removeFailure("stock_destinations"); }
    expect(await exits(w)).toHaveLength(0);
    expect(await dests(w)).toHaveLength(0);
    expect(await db.selectFrom("stockExitRequests").select("id").execute()).toHaveLength(0);
    expect(await balance(w)).toBe(100);

    await installFailure("audit_log", "NEW.action = 'destinacao.registrada'");
    try {
      expect((await dest(w, { idempotencyKey: k })).status).toBeGreaterThanOrEqual(500);
    } finally { await removeFailure("audit_log"); }
    expect(await exits(w)).toHaveLength(0);
    expect(await dests(w)).toHaveLength(0);
    expect(await balance(w)).toBe(100);

    expect((await dest(w, { idempotencyKey: k })).status).toBe(200); // a mesma chave, sem sobras do fracasso
    expect(await exits(w)).toHaveLength(1);
  });

  it("6/7/8: retry com a mesma chave não duplica; chave reutilizada com outro conteúdo é rejeitada; nova chave permite nova saída", async () => {
    const w = await world();
    const k = key();
    expect((await dest(w, { idempotencyKey: k })).status).toBe(200);
    const again = await dest(w, { idempotencyKey: k });
    expect(again.status).toBe(200);
    expect(await parseJson<{ replayed: boolean; newStock: number }>(again)).toMatchObject({ replayed: true, newStock: 95 });
    expect(await exits(w)).toHaveLength(1);
    const reuse = await dest(w, { idempotencyKey: k, quantity: 6 });
    expect(reuse.status).toBe(409);
    expect((await parseJson<{ code: string }>(reuse)).code).toBe("chave_reutilizada");
    expect((await dest(w, { idempotencyKey: k, deliveredOn: daysAgo(1) })).status).toBe(409);
    expect(await exits(w)).toHaveLength(1);
    expect((await dest(w, { idempotencyKey: key() })).status).toBe(200);
    expect(await exits(w)).toHaveLength(2);
    expect(await balance(w)).toBe(90);
  });

  it("9/48: duplo clique e requisições simultâneas com a mesma chave produzem UM resultado (uma saída, uma destinação)", async () => {
    const w = await world();
    const k = key();
    const rs = await Promise.all([dest(w, { idempotencyKey: k }), dest(w, { idempotencyKey: k }), dest(w, { idempotencyKey: k }), dest(w, { idempotencyKey: k }, w.admin)]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(await exits(w)).toHaveLength(1);
    expect(await dests(w)).toHaveLength(1);
    expect(await db.selectFrom("stockExitRequests").select("id").execute()).toHaveLength(1);
    const ids = new Set(await Promise.all(rs.map(async (r) => (await parseJson<{ destination: { id: string } }>(r)).destination.id)));
    expect(ids.size).toBe(1);
  });

  it("10/11: finalidade ausente ou inválida e chave inválida são rejeitadas (400) sem efeito", async () => {
    const w = await world();
    for (const over of [{ destinationType: undefined }, { destinationType: "venda" }, { destinationType: "ajuste" }, { idempotencyKey: "curta" }, { idempotencyKey: undefined }, { quantity: 0 }, { quantity: -1 }, { quantity: 1.2345 }, { deliveredOn: "15/10/2026" }]) {
      const res = await dest(w, over as never);
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(await res.text()).not.toMatch(/select |insert |sql|stack/i);
    }
    expect(await exits(w)).toHaveLength(0);
  });

  it("12/13/45: sem permissão é recusado; item de outra organização é 404; organizações ficam isoladas", async () => {
    const w = await world();
    const other = await world();
    expect((await dest(w, {}, w.volunteer)).status).toBe(403);
    const stranger = await createAuthenticatedUser();
    expect((await dest(w, {}, stranger)).status).toBe(403);
    expect((await destHandle(post("stock-destinations", other.owner.cookie, body(w)))).status).toBe(403); // dono de B tentando A
    expect((await destHandle(post("stock-destinations", other.owner.cookie, body(other, { itemId: w.item.id })))).status).toBe(404); // item de A informando a org de B
    expect((await destHandle(buildRequest("stock-destinations", { method: "POST", body: body(w) }))).status).toBe(401);
    expect(await exits(w)).toHaveLength(0);
    expect(await exits(other)).toHaveLength(0);
  });

  it("14: saldo insuficiente impede a operação; item com unidade não confiável é recusado (sem conversão)", async () => {
    const w = await world({ balance: 10 });
    const res = await dest(w, { quantity: 10.001 });
    expect(res.status).toBe(409);
    expect((await parseJson<{ code: string }>(res)).code).toBe("saldo_insuficiente");
    expect(await exits(w)).toHaveLength(0);
    const odd = await world({ unit: "cestas" });
    const r2 = await dest(odd, { quantity: 1 });
    expect(r2.status).toBe(422);
    expect((await parseJson<{ code: string }>(r2)).code).toBe("unidade_do_item_nao_confiavel");
    const alias = await world({ unit: "unidades" });
    expect((await dest(alias, { quantity: 1 })).status).toBe(422); // alias histórico: o banco só aceita o rótulo canônico
    expect(await dests(odd)).toHaveLength(0);
  });

  it("15/47: saídas concorrentes e ajustes concorrentes nunca deixam o saldo negativo", async () => {
    const w = await world({ balance: 100 });
    const rs = await Promise.all([
      dest(w, { quantity: 29 }),
      dest(w, { quantity: 29 }, w.admin),
      dest(w, { quantity: 29 }, w.owner),
      dest(w, { quantity: 29 }),
      stockHandle(post("stock-transactions", w.owner.cookie, { organizationId: w.org.id, itemId: w.item.id, type: "ajuste", quantity: -5, reason: "contagem de conferência" })),
    ]);
    expect(rs.every((r) => [200, 202, 409].includes(r.status))).toBe(true);
    expect(await balance(w)).toBeGreaterThanOrEqual(0);
    const done = (await exits(w)).length;
    expect(done).toBeGreaterThanOrEqual(1);
    expect((await dests(w)).length).toBe(done); // toda saída tem destinação
  });
});

describe("B. finalidades", () => {
  it("16: as oito finalidades são aceitas com os seus requisitos (as de risco ficam pendentes de aprovação)", async () => {
    for (const type of DESTINATION_TYPES) {
      const w = await world({ balance: 1000 });
      const needs = ["perda", "descarte", "uso_operacional_instituicao", "doacao_a_terceiro", "devolucao_ao_doador"].includes(type);
      const res = await dest(w, { destinationType: type, quantity: 5, ...(needs ? { notes: "descrição suficiente do motivo" } : {}) });
      if (type === "perda" || type === "descarte") {
        expect(res.status, type).toBe(202);
        expect(await dests(w)).toHaveLength(0);
      } else {
        expect(res.status, type).toBe(200);
        expect((await dests(w))[0].destinationType).toBe(type);
      }
    }
  });

  it("17/18/19/20: só as finalidades de atendimento vinculam necessidade; unidade incompatível não conta; pessoas atendidas é métrica separada", async () => {
    const w = await world();
    const mkNeed = async (unit = "kg", over: Record<string, unknown> = {}) =>
      (await db.insertInto("needs").values({ organizationId: w.org.id, title: "Cestas básicas", quantityNeeded: "50", unit, priority: "media", status: "aberta", createdByUserId: w.owner.userId, ...over } as never).returning("id").executeTakeFirstOrThrow()).id;
    const need = await mkNeed();
    for (const t of ["uso_operacional_instituicao", "doacao_a_terceiro", "devolucao_ao_doador", "perda", "descarte"]) {
      expect((await dest(w, { destinationType: t, needId: need, notes: "descrição suficiente do motivo" })).status, t).toBe(400);
      expect((await dest(w, { destinationType: t, peopleServed: 3, peopleUnit: "pessoas", notes: "descrição suficiente do motivo" })).status, t).toBe(400);
    }
    expect(await exits(w)).toHaveLength(0);
    for (const t of ["atendimento_coletivo", "distribuicao_familias", "entrega_instituicao_parceira"]) {
      const res = await dest(w, { destinationType: t, needId: need, quantity: 2, peopleServed: 7, peopleUnit: "pessoas" });
      expect(res.status, t).toBe(200);
      expect((await parseJson<{ destination: { isCountable: boolean } }>(res)).destination.isCountable).toBe(true);
    }
    const stored = await dests(w);
    expect(stored.every((d) => d.needId === need && d.isCountable === true && Number(d.quantity) === 2 && d.peopleServed === 7)).toBe(true); // pessoas ≠ quantidade física
    // 19: necessidade em OUTRA unidade -> saída registrada, mas NÃO contabilizável
    const litro = await mkNeed("litro", { title: "Água" });
    const res = await dest(w, { destinationType: "atendimento_coletivo", needId: litro, quantity: 1 });
    expect(res.status).toBe(200);
    const out = await parseJson<{ destination: { isCountable: boolean }; notice: string | null }>(res);
    expect(out.destination.isCountable).toBe(false);
    expect(out.notice).toContain("NÃO conta");
    // necessidade de outro item, de outra organização, cancelada e inexistente
    const otherItem = await createTestInventoryItem(w.org.id, w.owner.userId, { name: "Feijão", unit: "kg" });
    const bound = await mkNeed("kg", { itemId: otherItem.id, title: "Feijão" });
    expect((await dest(w, { destinationType: "atendimento_coletivo", needId: bound })).status).toBe(409);
    expect((await dest(w, { destinationType: "atendimento_coletivo", needId: await mkNeed("kg", { status: "cancelada" }) })).status).toBe(409);
    const foreign = await world();
    const foreignNeed = (await db.insertInto("needs").values({ organizationId: foreign.org.id, title: "Alheia", quantityNeeded: "5", unit: "kg", priority: "media", status: "aberta", createdByUserId: foreign.owner.userId }).returning("id").executeTakeFirstOrThrow()).id;
    expect((await dest(w, { destinationType: "atendimento_coletivo", needId: foreignNeed })).status).toBe(404);
    expect((await dest(w, { destinationType: "atendimento_coletivo", needId: 99999999 })).status).toBe(404);
  });

  it("21: perda e descarte exigem motivo (≥ 10 caracteres) e segunda validação", async () => {
    const w = await world();
    for (const t of ["perda", "descarte"]) {
      expect((await dest(w, { destinationType: t })).status).toBe(400);
      expect((await dest(w, { destinationType: t, notes: "curto" })).status).toBe(400);
      const ok = await dest(w, { destinationType: t, notes: "avaria por umidade no depósito" });
      expect(ok.status).toBe(202);
      expect((await parseJson<{ riskReasons: string[] }>(ok)).riskReasons).toContain("finalidade_perda_ou_descarte");
    }
    expect(await exits(w)).toHaveLength(0);
  });

  it("22/24: o ajuste de inventário continua no fluxo próprio, não cria saída nem destinação; saída pelo fluxo antigo é recusada", async () => {
    const w = await world();
    const adj = await stockHandle(post("stock-transactions", w.owner.cookie, { organizationId: w.org.id, itemId: w.item.id, type: "ajuste", quantity: -3, reason: "contagem de conferência" }));
    expect(adj.status).toBe(200);
    expect(await exits(w)).toHaveLength(0);
    expect(await dests(w)).toHaveLength(0);
    const old = await stockHandle(post("stock-transactions", w.owner.cookie, { organizationId: w.org.id, itemId: w.item.id, type: "saida", quantity: 3, reason: "distribuição" }));
    expect(old.status).toBe(400);
    expect(await old.text()).toContain("destinação");
    expect(await balance(w)).toBe(97);
  });

  it("23: devolução ao doador é uma FINALIDADE (saída física própria), não uma reversão", async () => {
    const w = await world();
    expect((await dest(w, { destinationType: "devolucao_ao_doador", notes: "devolvido ao doador original" })).status).toBe(200);
    const [d] = await dests(w);
    expect(d).toMatchObject({ entryType: "original", destinationType: "devolucao_ao_doador", reversalKind: null, reversesDestinationId: null });
  });

  it("25: nenhum comprovante é exigido nem exposto nesta fase (o registro não tem upload e o campo de arquivo não é aceito)", async () => {
    const w = await world();
    const res = await dest(w, { proofFileId: 1 });
    expect(res.status).toBe(200); // campo desconhecido é ignorado pelo schema
    expect((await dests(w))[0].proofFileId).toBeNull();
  });
});

describe("C. datas e fuso de negócio", () => {
  it("26/27/28/29: hoje, até 7 dias corridos atrás (inclusive) são aceitos; futura é rejeitada", async () => {
    const w = await world({ balance: 1000 });
    expect((await dest(w, { deliveredOn: today() })).status).toBe(200);
    expect((await dest(w, { deliveredOn: daysAgo(3) })).status).toBe(200);
    expect((await dest(w, { deliveredOn: daysAgo(7) })).status).toBe(200); // limite EXATO: hoje − 7 é aceito (documentado)
    const future = await dest(w, { deliveredOn: daysAgo(-1) });
    expect(future.status).toBe(422);
    expect((await parseJson<{ code: string }>(future)).code).toBe("data_futura");
    expect(await exits(w)).toHaveLength(3);
  });

  it("30: além do limite (8 dias) exige proprietário/administrador, justificativa e fica auditado com quem autorizou", async () => {
    const w = await world({ balance: 1000 });
    const date = daysAgo(8);
    const byOperator = await dest(w, { deliveredOn: date, lateRegistrationReason: "registro tardio por falta de internet" });
    expect(byOperator.status).toBe(403);
    expect((await parseJson<{ code: string }>(byOperator)).code).toBe("retroativa_exige_autorizacao");
    const noReason = await dest(w, { deliveredOn: date }, w.admin);
    expect(noReason.status).toBe(422);
    expect((await parseJson<{ code: string }>(noReason)).code).toBe("retroativa_exige_justificativa");
    expect((await dest(w, { deliveredOn: date, lateRegistrationReason: "curta" }, w.admin)).status).toBe(422);
    expect(await exits(w)).toHaveLength(0);
    const ok = await dest(w, { deliveredOn: date, lateRegistrationReason: "registro tardio por falta de internet" }, w.admin);
    expect(ok.status).toBe(200);
    const [d] = await dests(w);
    expect(d).toMatchObject({ lateRegistrationReason: "registro tardio por falta de internet", authorizedByUserId: w.admin.userId });
    expect((await audits("destinacao.registrada"))[0].metadata).toMatchObject({ retroativa: true, dataEfetiva: date });
  });

  it("31: datas inválidas são rejeitadas (formato, calendário, ano absurdo)", async () => {
    const w = await world();
    for (const v of ["2026-02-30", "2026-13-01", "2026-00-10", "1999-12-31", "2026-1-5", "2026-10-15T10:00:00Z", " 2026-10-15", ""]) {
      const res = await dest(w, { deliveredOn: v });
      expect([400, 422], v).toContain(res.status);
    }
    expect(await exits(w)).toHaveLength(0);
  });

  it("32: a virada do dia segue o fuso de negócio (America/Sao_Paulo), não o UTC nem a máquina", () => {
    // 2026-10-15T02:59:59Z = 23:59:59 do dia 14 em São Paulo; 03:00:00Z = 00:00:00 do dia 15
    expect(businessDateOf(new Date("2026-10-15T02:59:59Z"))).toBe("2026-10-14");
    expect(businessDateOf(new Date("2026-10-15T03:00:00Z"))).toBe("2026-10-15");
    // na noite local, o dia civil de negócio ainda é o anterior, mesmo que em UTC já seja o seguinte
    expect(checkEffectiveDate("2026-10-15", new Date("2026-10-15T02:59:59Z"))).toEqual({ ok: false, reason: "futura" });
    expect(checkEffectiveDate("2026-10-15", new Date("2026-10-15T03:00:00Z"))).toMatchObject({ ok: true, daysAgo: 0, retroactive: false });
    // limite de 7 dias é CIVIL: 23h59 ou 00h01, hoje − 7 é aceito e hoje − 8 é retroativo
    for (const instant of ["2026-10-15T03:00:00Z", "2026-10-16T02:59:59Z"]) {
      const today = businessDateOf(new Date(instant));
      const minus = (n: number) => { const p = parseCivilDate(today)!; return new Date(Date.UTC(p.y, p.m - 1, p.d - n)).toISOString().slice(0, 10); };
      expect(checkEffectiveDate(minus(7), new Date(instant))).toMatchObject({ ok: true, daysAgo: 7, retroactive: false });
      expect(checkEffectiveDate(minus(8), new Date(instant))).toMatchObject({ ok: true, daysAgo: 8, retroactive: true });
    }
    // diferença de data civil, não de 168 horas (virada de mês e de ano)
    expect(civilDaysBetween("2026-02-28", "2026-03-07")).toBe(7);
    expect(civilDaysBetween("2025-12-28", "2026-01-04")).toBe(7);
    expect(parseCivilDate("2026-02-29")).toBeNull();
    expect(parseCivilDate("2028-02-29")).not.toBeNull();
  });

  it("33/34: o registro é do servidor (a data do cliente não o altera) e uma correção de data é um evento novo que preserva o valor anterior", async () => {
    const w = await world();
    const before = Date.now();
    expect((await dest(w, { deliveredOn: daysAgo(2), createdAt: "2001-01-01T00:00:00Z", registeredAt: "2001-01-01T00:00:00Z" })).status).toBe(200);
    const [d] = await dests(w);
    expect(d.createdAt.getTime()).toBeGreaterThanOrEqual(before - 5000);
    expect(String(d.deliveredOn instanceof Date ? d.deliveredOn.toISOString().slice(0, 10) : d.deliveredOn)).toBe(daysAgo(2));
    // correção de data (evento do schema da 99D): o original NÃO é sobrescrito
    await db.insertInto("stockDestinations").values({ organizationId: w.org.id, entryType: "correction", itemId: w.item.id, reversesDestinationId: d.id, deliveredOn: daysAgo(3), reason: "data efetiva informada errada", createdByUserId: w.admin.userId } as never).execute();
    const rows = await dests(w);
    expect(rows).toHaveLength(2);
    const original = rows.find((r) => r.entryType === "original")!;
    expect(String(original.deliveredOn instanceof Date ? original.deliveredOn.toISOString().slice(0, 10) : original.deliveredOn)).toBe(daysAgo(2));
  });
});

describe("D. risco e segunda aprovação", () => {
  async function pending(w: W, over: Record<string, unknown> = {}, user: Auth = w.operator) {
    const res = await dest(w, { destinationType: "perda", notes: "avaria por umidade no depósito", ...over }, user);
    expect(res.status).toBe(202);
    return (await parseJson<{ approvalRequestId: number }>(res)).approvalRequestId;
  }

  it("35/36/37/38: perda e descarte exigem aprovação; ≥ 30% do SALDO exige; abaixo pode ser direta; nada é baixado antes da aprovação", async () => {
    const w = await world({ balance: 100 });
    await pending(w);
    await pending(w, { destinationType: "descarte" });
    expect((await dest(w, { quantity: 30 })).status).toBe(202); // exatamente 30% do saldo
    expect((await dest(w, { quantity: 29.999 })).status).toBe(200); // abaixo do limite
    expect(await exits(w)).toHaveLength(1);
    expect(await dests(w)).toHaveLength(1);
    expect(await balance(w)).toBeCloseTo(70.001, 3);
    // o limite é RELATIVO ao saldo na unidade do item: o mesmo "20" é pouco em 1000 kg e muito em 50
    expect(evaluateDestinationRisk({ destinationType: "distribuicao_familias", quantity: 20, balanceBefore: 1000 })).toEqual([]);
    expect(evaluateDestinationRisk({ destinationType: "distribuicao_familias", quantity: 20, balanceBefore: 50 })).toEqual(["saida_alcanca_30_por_cento_do_saldo"]);
    expect(evaluateDestinationRisk({ destinationType: "perda", quantity: 1, balanceBefore: 1000 })).toEqual(["finalidade_perda_ou_descarte"]);
    expect(evaluateDestinationRisk({ destinationType: "perda", quantity: 500, balanceBefore: 1000 })).toEqual(["finalidade_perda_ou_descarte", "saida_alcanca_30_por_cento_do_saldo"]);
    expect(evaluateDestinationRisk({ destinationType: "distribuicao_familias", quantity: 5, balanceBefore: 0 })).toEqual([]);
  });

  it("39/40/43/44: o autor não aprova a própria operação; rejeição não movimenta; aprovação cria saída+destinação UMA vez; falha reverte", async () => {
    const w = await world({ balance: 100 });
    const id = await pending(w, { quantity: 4 });
    expect((await decide(w, id, "aprovada", w.operator)).status).toBe(403); // operador não decide (permissão)
    const id2 = await pending(w, { quantity: 4 }, w.admin);
    expect((await decide(w, id2, "aprovada", w.admin)).status).toBe(403); // o autor
    expect(await exits(w)).toHaveLength(0);

    // rejeição: nada é baixado e o pedido idempotente é encerrado
    expect((await decide(w, id, "rejeitada", w.owner)).status).toBe(200);
    expect(await exits(w)).toHaveLength(0);
    expect((await db.selectFrom("stockExitRequests").select("status").where("approvalRequestId", "=", id).executeTakeFirstOrThrow()).status).toBe("rejeitada");

    // aprovação com falha de auditoria: tudo reverte e o pedido continua pendente
    await installFailure("audit_log", "NEW.action = 'destinacao.registrada'");
    try {
      expect((await decide(w, id2, "aprovada", w.owner)).status).toBeGreaterThanOrEqual(500);
    } finally { await removeFailure("audit_log"); }
    expect(await exits(w)).toHaveLength(0);
    expect(await dests(w)).toHaveLength(0);
    expect((await db.selectFrom("approvalRequests").select("status").where("id", "=", id2).executeTakeFirstOrThrow()).status).toBe("pendente");

    // tentativa seguinte funciona; aprovar de novo não cria outra saída
    expect((await decide(w, id2, "aprovada", w.owner)).status).toBe(200);
    expect((await decide(w, id2, "aprovada", w.owner)).status).toBe(409);
    const e = await exits(w);
    const d = await dests(w);
    expect(e).toHaveLength(1);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ destinationType: "perda", createdByUserId: w.admin.userId }); // o autor do pedido consta como criador
    expect(String(d[0].stockTransactionId)).toBe(String(e[0].id));
    expect((await audits("destinacao.registrada"))[0].metadata).toMatchObject({ solicitanteId: w.admin.userId, aprovadoPor: w.owner.userId });
    expect((await db.selectFrom("stockExitRequests").select("status").where("approvalRequestId", "=", id2).executeTakeFirstOrThrow()).status).toBe("executada");
  });

  it("41/42: a aprovação reavalia o estado ATUAL: se o saldo caiu abaixo da quantidade, é recusada sem efeito e o pedido segue pendente", async () => {
    const w = await world({ balance: 100 });
    const id = await pending(w, { quantity: 40, destinationType: "descarte" });
    await db.insertInto("stockTransactions").values({ organizationId: w.org.id, itemId: w.item.id, type: "ajuste", delta: "-70", reason: "contagem de conferência", createdByUserId: w.owner.userId }).execute();
    const res = await decide(w, id, "aprovada", w.owner);
    expect(res.status).toBe(409);
    expect((await parseJson<{ code: string }>(res)).code).toBe("saldo_insuficiente");
    expect(await exits(w)).toHaveLength(0);
    expect((await db.selectFrom("approvalRequests").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status).toBe("pendente");
    // com o saldo restabelecido, a mesma aprovação funciona (o risco foi reavaliado sobre o saldo de agora)
    await db.insertInto("stockTransactions").values({ organizationId: w.org.id, itemId: w.item.id, type: "entrada", delta: "100", reason: "reposição", createdByUserId: w.owner.userId }).execute();
    expect((await decide(w, id, "aprovada", w.owner)).status).toBe(200);
    expect((await audits("destinacao.registrada"))[0].metadata).toMatchObject({ saldoAnterior: 130, riscoAvaliado: ["finalidade_perda_ou_descarte", "saida_alcanca_30_por_cento_do_saldo"] }); // 40 de 130 = 30,8%
  });

  it("46: duas aprovações concorrentes não criam duas saídas; pedidos que juntos excedem o saldo não deixam o estoque negativo", async () => {
    const w = await world({ balance: 100 });
    const id = await pending(w, { quantity: 10 });
    const rs = await Promise.all([decide(w, id, "aprovada", w.owner), decide(w, id, "aprovada", w.admin === w.owner ? w.owner : w.owner)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await exits(w)).toHaveLength(1);
    expect(await dests(w)).toHaveLength(1);

    const x = await world({ balance: 100 });
    const a = await pending(x, { quantity: 80, destinationType: "descarte" });
    const b = await pending(x, { quantity: 80, destinationType: "descarte" });
    const both = await Promise.all([decide(x, a, "aprovada", x.owner), decide(x, b, "aprovada", x.owner)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await balance(x)).toBe(20);
    expect(await exits(x)).toHaveLength(1);
  });

  it("retry da mesma chave com pedido pendente devolve o MESMO pedido (sem novo pedido nem saída); após rejeição, o retry é recusado com explicação", async () => {
    const w = await world({ balance: 100 });
    const k = key();
    const first = await dest(w, { destinationType: "perda", notes: "avaria por umidade no depósito", idempotencyKey: k });
    const id = (await parseJson<{ approvalRequestId: number }>(first)).approvalRequestId;
    const again = await dest(w, { destinationType: "perda", notes: "avaria por umidade no depósito", idempotencyKey: k });
    expect(again.status).toBe(202);
    expect(await parseJson<{ approvalRequestId: number; replayed: boolean }>(again)).toMatchObject({ approvalRequestId: id, replayed: true });
    expect(await db.selectFrom("approvalRequests").select("id").where("organizationId", "=", w.org.id).execute()).toHaveLength(1);
    await decide(w, id, "rejeitada", w.owner);
    const closed = await dest(w, { destinationType: "perda", notes: "avaria por umidade no depósito", idempotencyKey: k });
    expect(closed.status).toBe(409);
    expect((await parseJson<{ code: string }>(closed)).code).toBe("pedido_encerrado");
    expect(await exits(w)).toHaveLength(0);
  });

  it("45: o dono de outra organização não decide nem enxerga o pedido", async () => {
    const w = await world();
    const other = await world();
    const id = await pending(w);
    expect((await decideHandle(post("approval-requests-decide", other.owner.cookie, { organizationId: other.org.id, requestId: id, decision: "aprovada" }))).status).toBe(404);
    expect((await decideHandle(post("approval-requests-decide", other.owner.cookie, { organizationId: w.org.id, requestId: id, decision: "aprovada" }))).status).toBe(403);
    expect(await exits(w)).toHaveLength(0);
  });

  it("aprovação com data retroativa só por quem pode autorizar; organização com um único administrador não tem exceção de auto-aprovação", async () => {
    const solo = await createAuthenticatedUser();
    const org = await createTestOrganization(solo.userId);
    const item = await createTestInventoryItem(org.id, solo.userId, { name: "Arroz", unit: "kg" });
    await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: item.id, type: "entrada", delta: "100", reason: "saldo", createdByUserId: solo.userId }).execute();
    const res = await destHandle(post("stock-destinations", solo.cookie, { organizationId: org.id, itemId: item.id, quantity: 2, destinationType: "perda", deliveredOn: today(), notes: "avaria por umidade no depósito", idempotencyKey: key() }));
    expect(res.status).toBe(202);
    const id = (await parseJson<{ approvalRequestId: number }>(res)).approvalRequestId;
    expect((await decideHandle(post("approval-requests-decide", solo.cookie, { organizationId: org.id, requestId: id, decision: "aprovada" }))).status).toBe(403);
    expect(await db.selectFrom("stockTransactions").select("id").where("itemId", "=", item.id).where("type", "=", "saida").execute()).toHaveLength(0);
  });
});

describe("E. nenhuma rota cria saída sem destinação", () => {
  it("49/50: a única escrita de movimento 'saida' no código é o núcleo da destinação; needs-status não baixa estoque e a resolução fica declarativa", async () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const writers = [...walk("src"), ...walk("scripts"), ...walk("db")].filter((f) => /\.(ts|tsx|mjs)$/.test(f)).filter((f) => {
      const t = readFileSync(f, "utf8");
      return /insertInto\("stockTransactions"\)/.test(t) && /type:\s*"saida"/.test(t);
    });
    expect(writers.map((f) => path.basename(f))).toEqual(["stockExit.tsx"]);

    const w = await world();
    const [need] = await db.insertInto("needs").values({ organizationId: w.org.id, itemId: w.item.id, title: "Cestas", quantityNeeded: "40", unit: "kg", priority: "media", status: "aberta", createdByUserId: w.owner.userId }).returning("id").execute();
    const before = await balance(w);
    const res = await needStatusHandle(post("needs-status", w.owner.cookie, { organizationId: w.org.id, needId: need.id, status: "atendida" }));
    expect(res.status).toBe(200);
    expect(await exits(w)).toHaveLength(0);
    expect(await balance(w)).toBe(before);
    const [resolution] = await db.selectFrom("needResolutions").selectAll().where("needId", "=", need.id).execute();
    expect(resolution.stockTransactionId).toBeNull();
    // reabrir e atender de novo nunca produz uma baixa
    await needStatusHandle(post("needs-status", w.owner.cookie, { organizationId: w.org.id, needId: need.id, status: "aberta" }));
    await needStatusHandle(post("needs-status", w.owner.cookie, { organizationId: w.org.id, needId: need.id, status: "atendida" }));
    expect(await exits(w)).toHaveLength(0);
  });

  it("toda saída nova tem exatamente uma destinação original e toda destinação normal aponta para uma saída real (invariante sobre o banco)", async () => {
    const w = await world({ balance: 500 });
    for (let i = 0; i < 4; i++) await dest(w, { quantity: 3 + i });
    const orphanExits = await sql<{ n: string }>`SELECT count(*) AS n FROM stock_transactions s WHERE s.item_id = ${w.item.id} AND s.type = 'saida' AND NOT EXISTS (SELECT 1 FROM stock_destinations d WHERE d.stock_transaction_id = s.id AND d.entry_type = 'original')`.execute(db);
    const orphanDestinations = await sql<{ n: string }>`SELECT count(*) AS n FROM stock_destinations d WHERE d.organization_id = ${w.org.id} AND d.entry_type = 'original' AND NOT EXISTS (SELECT 1 FROM stock_transactions s WHERE s.id = d.stock_transaction_id AND s.type = 'saida')`.execute(db);
    expect(Number(orphanExits.rows[0].n)).toBe(0);
    expect(Number(orphanDestinations.rows[0].n)).toBe(0);
  });
});
