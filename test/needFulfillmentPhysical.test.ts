/**
 * Fase 80 — Fatia 2 do ledger: efeito FÍSICO no estoque de correção e estorno.
 * Postgres real, sem mocks. Contrato: docs/LEDGER_CORRECOES_ESPECIFICACAO.md
 * (seções P, AA e AC). Um único `ajuste` pelo delta, na mesma transação do
 * ledger, vinculado a UMA linha (correction, ou reversal na retirada física).
 */
import { describe, it, expect } from "vitest";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { handle as getHistory } from "../src/endpoints/allocations-receipt-history_GET";
import { handle as postCorrect } from "../src/endpoints/allocations-receipt-correct_POST";
import { handle as postReverse } from "../src/endpoints/allocations-receipt-reverse_POST";
import { handle as postReceive } from "../src/endpoints/allocations-receive_POST";
import { handle as postDecide } from "../src/endpoints/approval-requests-decide_POST";
import { handle as postStock } from "../src/endpoints/stock-transactions_POST";
import { handle as getImpact } from "../src/endpoints/impact-report_GET";
import { getNeedFulfillmentBalance } from "../src/helpers/needFulfillment";
import { getItemStockBalance } from "../src/helpers/stockBalance";
import {
  createAuthenticatedUser,
  createTestOrganization,
  createTestSource,
  createTestOpportunityRegistry,
  createTestInventoryItem,
  addMembership,
  buildRequest,
  parseJson,
  type AuthenticatedTestUser,
} from "./helpers";
import type { OutputType as HistoryOutput } from "../src/endpoints/allocations-receipt-history_GET.schema";

interface Env {
  owner: AuthenticatedTestUser;
  operador: AuthenticatedTestUser;
  admin: AuthenticatedTestUser;
  orgId: number;
  itemId: number;
  needId: number;
}
interface Alloc {
  allocationId: number;
}

async function setupEnv(opts: { itemUnit?: string; needUnit?: string } = {}): Promise<Env> {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const operador = await createAuthenticatedUser();
  const admin = await createAuthenticatedUser();
  await addMembership(org.id, operador.userId, "operador");
  await addMembership(org.id, admin.userId, "administrador");
  const [need] = await db
    .insertInto("needs")
    .values({ organizationId: org.id, title: "Cestas", quantityNeeded: "500", unit: opts.needUnit ?? "kg", priority: "media", status: "aberta", createdByUserId: owner.userId })
    .returning(["id"])
    .execute();
  const item = await createTestInventoryItem(org.id, owner.userId, { unit: opts.itemUnit ?? "kg" });
  return { owner, operador, admin, orgId: org.id, itemId: item.id, needId: need.id };
}

async function receive(e: Env, quantity = 100): Promise<Alloc> {
  const platform = await createAuthenticatedUser();
  const source = await createTestSource(platform.userId);
  const opp = await createTestOpportunityRegistry(source.id, platform.userId, { unit: "kg", status: "reservada" });
  const [al] = await db
    .insertInto("opportunityAllocations")
    .values({ opportunityRegistryId: opp.id, organizationId: e.orgId, quantityAllocated: "100", status: "aceita", needId: e.needId })
    .returning(["id"])
    .execute();
  const res = await postReceive(
    buildRequest("allocations-receive", { method: "POST", cookie: e.owner.cookie, body: { organizationId: e.orgId, allocationId: al.id, itemId: e.itemId, quantityReceived: quantity } })
  );
  expect(res.status).toBe(200);
  return { allocationId: al.id };
}

const historyOf = async (e: Env, a: Alloc, user = e.owner) => {
  const res = await getHistory(buildRequest(`allocations-receipt-history?organizationId=${e.orgId}&allocationId=${a.allocationId}`, { cookie: user.cookie }));
  expect(res.status).toBe(200);
  return parseJson<HistoryOutput>(res);
};
const tok = async (e: Env, a: Alloc) => (await historyOf(e, a)).vigenteFulfillmentId as string;
const correct = (e: Env, a: Alloc, user: AuthenticatedTestUser, body: Record<string, unknown>) =>
  postCorrect(buildRequest("allocations-receipt-correct", { method: "POST", cookie: user.cookie, body: { organizationId: e.orgId, allocationId: a.allocationId, reason: "Conferência", ...body } }));
const reverse = (e: Env, a: Alloc, user: AuthenticatedTestUser, body: Record<string, unknown>) =>
  postReverse(buildRequest("allocations-receipt-reverse", { method: "POST", cookie: user.cookie, body: { organizationId: e.orgId, allocationId: a.allocationId, reason: "Evento inválido", ...body } }));
const decide = (e: Env, user: AuthenticatedTestUser, requestId: number, decision: "aprovada" | "rejeitada" = "aprovada") =>
  postDecide(buildRequest("approval-requests-decide", { method: "POST", cookie: user.cookie, body: { organizationId: e.orgId, requestId, decision } }));

async function stock(itemId: number) {
  return db.transaction().execute((trx) => getItemStockBalance(trx, itemId));
}
async function movements(e: Env) {
  return db.selectFrom("stockTransactions").selectAll().where("organizationId", "=", e.orgId).orderBy("id", "asc").execute();
}
async function ledger(a: Alloc) {
  return db.selectFrom("needFulfillments").selectAll().where("allocationId", "=", a.allocationId).orderBy("id", "asc").execute();
}
async function pendingId(res: Response) {
  expect(res.status).toBe(202);
  return (await parseJson<{ approvalRequestId: number }>(res)).approvalRequestId;
}
async function auditOf(e: Env, action: string) {
  return db.selectFrom("auditLog").select(["metadata"]).where("organizationId", "=", e.orgId).where("action", "=", action).orderBy("id", "asc").execute();
}
const deltas = async (e: Env) => (await movements(e)).map((m) => [m.type, Number(m.delta)]);

describe("Fase 80 — correção física (um ajuste pelo delta)", () => {
  it("100 → 80: pendente sem tocar o estoque; aprovada = UM ajuste −20 ligado à correction (nunca saída 100 + entrada 80)", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const v1 = await tok(e, a);

    const id = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: v1, quantity: 80, reason: "Faltaram 20" }));
    expect(await stock(e.itemId)).toBe(100);
    expect(await deltas(e)).toEqual([["entrada", 100]]);

    const req = await db.selectFrom("approvalRequests").select(["payload"]).where("id", "=", id).executeTakeFirstOrThrow();
    expect(req.payload).toMatchObject({ efeitoEstoque: "ajuste", deltaFisicoPlanejado: -20, itemId: e.itemId, retiradaFisica: false, saldoFisicoAllocation: 100 });

    expect((await decide(e, e.admin, id)).status).toBe(200);
    expect(await deltas(e)).toEqual([["entrada", 100], ["ajuste", -20]]);
    expect(await stock(e.itemId)).toBe(80);

    const rows = await ledger(a);
    expect(rows.map((r) => r.entryType)).toEqual(["original", "reversal", "correction"]);
    expect(rows[1].stockTransactionId).toBeNull(); // a reversal do par é só contábil
    const mov = (await movements(e))[1];
    expect(String(rows[2].stockTransactionId)).toBe(String(mov.id)); // vínculo na correction
    expect(mov.organizationId).toBe(e.orgId);
    expect(mov.itemId).toBe(e.itemId);
    expect(mov.createdByUserId).toBe(e.operador.userId); // autor = solicitante (padrão do ajuste aprovado)
    expect(await getNeedFulfillmentBalance(db, e.needId)).toBe(80);

    const ev = (await auditOf(e, "atribuicao.recebimento_corrigido"))[0].metadata as Record<string, unknown>;
    expect(ev).toMatchObject({ efeitoEstoque: "ajuste", deltaFisico: -20, itemId: e.itemId, unidade: "kg", stockTransactionId: String(mov.id), saldoEstoqueAntes: 100, saldoEstoqueApos: 80, saldoFisicoAllocationAntes: 100, retiradaFisica: false });
    const dump = JSON.stringify(ev).toLowerCase();
    for (const u of [e.owner, e.operador, e.admin]) expect(dump).not.toContain(u.email.toLowerCase());
  });

  it("100 → 120: direto (aumento) = UM ajuste +20 ligado à correction; a reversal do par sem movimento; histórico mostra o delta", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const res = await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 120 });
    expect(res.status).toBe(200);
    const body = await parseJson<{ deltaFisico: number | null; stockTransactionId: string | null }>(res);
    expect(body.deltaFisico).toBe(20);
    expect(body.stockTransactionId).not.toBeNull();
    expect(await deltas(e)).toEqual([["entrada", 100], ["ajuste", 20]]);
    expect(await stock(e.itemId)).toBe(120);

    const h = await historyOf(e, a);
    expect(h.rows.map((r) => [r.entryType, r.physicalDelta])).toEqual([["original", 100], ["reversal", null], ["correction", 20]]);
    expect(h.physicalBalance).toBe(120);
    expect(h.item).toMatchObject({ id: e.itemId, unit: "kg", currentBalance: 120 });
  });

  it("100 → 100: sem operação — nenhuma linha de ledger e nenhum movimento", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const res = await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 100 });
    expect(res.status).toBe(422);
    expect(await ledger(a)).toHaveLength(1);
    expect(await deltas(e)).toEqual([["entrada", 100]]);
  });

  it("reentrada: 100 → 80 (−20, aprovado) e depois 80 → 120 (+40 direto) = +20 líquido sobre o original; saldo físico da allocation acompanha", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const id = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 80 }));
    await decide(e, e.admin, id);
    expect((await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 120 })).status).toBe(200);
    expect(await deltas(e)).toEqual([["entrada", 100], ["ajuste", -20], ["ajuste", 40]]);
    expect(await stock(e.itemId)).toBe(120);
    expect((await historyOf(e, a)).physicalBalance).toBe(120);
  });

  it("correção de unidade e correção de linha com unidade ≠ unidade do item NÃO movem estoque (sem conversão)", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    // contável → não contável (redução do efeito ⇒ aprovação) — só rótulo, sem movimento
    const id = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), unit: "litros" }));
    await decide(e, e.admin, id);
    expect(await deltas(e)).toEqual([["entrada", 100]]);
    // quantidade numa linha cuja unidade difere da do item: sem significado físico
    const res = await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 130 });
    expect(res.status).toBe(200);
    expect((await parseJson<{ stockTransactionId: string | null }>(res)).stockTransactionId).toBeNull();
    expect(await deltas(e)).toEqual([["entrada", 100]]);
    // retirada física nessa linha exigiria conversão: rejeitada
    const w = await reverse(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), withdrawStock: true });
    expect(w.status).toBe(422);
    expect((await parseJson<{ code: string }>(w)).code).toBe("unidade_incompativel");
    const item = await db.selectFrom("inventoryItems").select(["unit"]).where("id", "=", e.itemId).executeTakeFirstOrThrow();
    expect(item.unit).toBe("kg");
  });

  it("a prestação de contas existente enxerga o movimento (ajustes e netChange do período)", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const id = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 80 }));
    await decide(e, e.admin, id);
    const res = await getImpact(
      buildRequest(`impact-report?organizationId=${e.orgId}&startDate=${encodeURIComponent(new Date(Date.now() - 86400000).toISOString())}&endDate=${encodeURIComponent(new Date(Date.now() + 86400000).toISOString())}`, { cookie: e.owner.cookie })
    );
    expect(res.status).toBe(200);
    const body = await parseJson<{ itemMovements: Array<{ entradas: number; ajustes: number; netChange: number; currentStock: number }> }>(res);
    expect(body.itemMovements[0]).toMatchObject({ entradas: 100, ajustes: -20, netChange: 80, currentStock: 80 });
  });
});

describe("Fase 80 — estorno: contábil por padrão, retirada física opcional (saldo físico real)", () => {
  it("estorno contábil: ledger muda, estoque NÃO; histórico mostra que foi só estorno contábil (sem movimento)", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const id = await pendingId(await reverse(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a) }));
    expect((await decide(e, e.admin, id)).status).toBe(200);
    expect(await deltas(e)).toEqual([["entrada", 100]]);
    expect(await stock(e.itemId)).toBe(100);
    const h = await historyOf(e, a);
    expect(h.rows.map((r) => [r.entryType, r.physicalDelta])).toEqual([["original", 100], ["reversal", null]]);
    const ev = (await auditOf(e, "atribuicao.recebimento_estornado"))[0].metadata as Record<string, unknown>;
    expect(ev).toMatchObject({ efeitoEstoque: "nenhum" });
    expect(ev.stockTransactionId).toBeUndefined();
  });

  it("estorno com retirada física: um ajuste −saldo físico ligado à REVERSAL; saldo do item e da allocation zeram", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const id = await pendingId(await reverse(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), withdrawStock: true }));
    const req = await db.selectFrom("approvalRequests").select(["payload"]).where("id", "=", id).executeTakeFirstOrThrow();
    expect(req.payload).toMatchObject({ efeitoEstoque: "ajuste", retiradaFisica: true, deltaFisicoPlanejado: -100, saldoFisicoAllocation: 100, itemId: e.itemId });
    expect(await stock(e.itemId)).toBe(100); // pedido pendente não move nada

    expect((await decide(e, e.admin, id)).status).toBe(200);
    expect(await deltas(e)).toEqual([["entrada", 100], ["ajuste", -100]]);
    const rows = await ledger(a);
    expect(rows.map((r) => r.entryType)).toEqual(["original", "reversal"]);
    expect(String(rows[1].stockTransactionId)).toBe(String((await movements(e))[1].id));
    expect(await stock(e.itemId)).toBe(0);
    const h = await historyOf(e, a);
    expect(h.physicalBalance).toBe(0);
    expect(h.rows[1].physicalDelta).toBe(-100);
    expect(await getNeedFulfillmentBalance(db, e.needId)).toBe(0);
  });

  it("retirada usa o saldo físico REAL: 100 → 80 (−20) e depois estorno físico retira 80, não 100 nem a quantidade do original; outro estoque do item intacto", async () => {
    const e = await setupEnv();
    // estoque próprio do item, de outra origem (não pertence à allocation)
    await db.insertInto("stockTransactions").values({ organizationId: e.orgId, itemId: e.itemId, type: "entrada", delta: "50", createdByUserId: e.owner.userId }).execute();
    const a = await receive(e);
    const c = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 80 }));
    await decide(e, e.admin, c);
    expect(await stock(e.itemId)).toBe(130);

    const r = await pendingId(await reverse(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), withdrawStock: true }));
    const payload = (await db.selectFrom("approvalRequests").select(["payload"]).where("id", "=", r).executeTakeFirstOrThrow()).payload as { deltaFisicoPlanejado: number; saldoFisicoAllocation: number };
    expect(payload.deltaFisicoPlanejado).toBe(-80);
    expect(payload.saldoFisicoAllocation).toBe(80);
    await decide(e, e.admin, r);
    expect(await stock(e.itemId)).toBe(50); // só o estoque da allocation saiu
    expect((await movements(e)).map((m) => Number(m.delta))).toEqual([50, 100, -20, -80]);
  });

  it("original 100 → 120 (+20) e estorno físico: retira 120 = saldo físico real da allocation", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 120 });
    const r = await pendingId(await reverse(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), withdrawStock: true }));
    await decide(e, e.admin, r);
    expect(await stock(e.itemId)).toBe(0);
    expect((await movements(e)).map((m) => Number(m.delta))).toEqual([100, 20, -120]);
  });

  it("estorno contábil + reativação: 'desfazer' parte do saldo físico que ficou (100 → 150 = +50)", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const r = await pendingId(await reverse(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a) }));
    await decide(e, e.admin, r);
    const res = await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 150 });
    expect(res.status).toBe(200);
    expect((await movements(e)).map((m) => Number(m.delta))).toEqual([100, 50]);
  });

  it("sem_saldo_fisico é alcançável por estados LEGÍTIMOS: retirada física → reativar só trocando a unidade (sem estoque) → voltar a unidade do item → nova retirada física", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    // 1) estorno COM retirada física: saldo físico da allocation = 0
    const r1 = await pendingId(await reverse(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), withdrawStock: true }));
    await decide(e, e.admin, r1);
    expect((await historyOf(e, a)).physicalBalance).toBe(0);
    // 2) "desfazer estorno" só como reclassificação de unidade: reativa SEM mover estoque
    expect((await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), unit: "litros" })).status).toBe(200);
    // 3) volta a unidade para a do item (reclassificação, sem estoque): a cadeia fica ativa, contando 100, com saldo físico 0
    expect((await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), unit: "kg" })).status).toBe(200);
    const h = await historyOf(e, a);
    expect(h.chainState).toBe("ativa");
    expect(h.physicalBalance).toBe(0);
    expect(await deltas(e)).toEqual([["entrada", 100], ["ajuste", -100]]);
    // 4) retirada física sem nada físico para retirar: 422, nada criado
    const before = (await ledger(a)).length;
    const res = await reverse(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), withdrawStock: true });
    expect(res.status).toBe(422);
    expect((await parseJson<{ code: string }>(res)).code).toBe("sem_saldo_fisico");
    expect((await ledger(a)).length).toBe(before);
    expect(await db.selectFrom("approvalRequests").select(["id"]).where("status", "=", "pendente").execute()).toHaveLength(0);
    // o estorno contábil continua possível
    expect((await reverse(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a) })).status).toBe(202);
  });

  it("reativar para MENOS que o saldo físico (reduz o físico) exige segunda pessoa", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const r = await pendingId(await reverse(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a) }));
    await decide(e, e.admin, r);
    const res = await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 70 });
    expect(res.status).toBe(202);
    expect(await deltas(e)).toEqual([["entrada", 100]]);
  });
});

describe("Fase 80 — estoque insuficiente e atomicidade", () => {
  it("solicitação: saída que não cabe ⇒ 409 insufficient_stock; nenhum pedido, ledger ou movimento criado", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    await db.insertInto("stockTransactions").values({ organizationId: e.orgId, itemId: e.itemId, type: "saida", delta: "-90", createdByUserId: e.owner.userId }).execute();
    const v1 = await tok(e, a);
    const res = await correct(e, a, e.operador, { expectedVigenteFulfillmentId: v1, quantity: 80 });
    expect(res.status).toBe(409);
    expect((await parseJson<{ code: string }>(res)).code).toBe("insufficient_stock");
    const w = await reverse(e, a, e.operador, { expectedVigenteFulfillmentId: v1, withdrawStock: true });
    expect(w.status).toBe(409);
    expect(await ledger(a)).toHaveLength(1);
    expect(await db.selectFrom("approvalRequests").select(["id"]).execute()).toHaveLength(0);
    expect(await stock(e.itemId)).toBe(10);
  });

  it("decisão: o estoque caiu depois do pedido ⇒ 409, NADA executa (ledger, estoque) e o pedido continua pendente (e rejeitável)", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const id = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 80 }));
    await db.insertInto("stockTransactions").values({ organizationId: e.orgId, itemId: e.itemId, type: "saida", delta: "-90", createdByUserId: e.owner.userId }).execute();
    const res = await decide(e, e.admin, id);
    expect(res.status).toBe(409);
    expect((await parseJson<{ message: string }>(res)).message).toContain("negativo");
    expect(await ledger(a)).toHaveLength(1);
    expect(await stock(e.itemId)).toBe(10);
    expect((await db.selectFrom("approvalRequests").select(["status"]).where("id", "=", id).executeTakeFirstOrThrow()).status).toBe("pendente");
    expect((await auditOf(e, "atribuicao.recebimento_corrigido"))).toHaveLength(0);
    expect((await decide(e, e.admin, id, "rejeitada")).status).toBe(200);
  });

  async function withTrigger(name: string, table: string, whenClause: string, fn: () => Promise<void>) {
    await sql.raw(`CREATE OR REPLACE FUNCTION ${name}_fn() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'falha injetada pelo teste'; END; $$ LANGUAGE plpgsql`).execute(db);
    await sql.raw(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW WHEN (${whenClause}) EXECUTE FUNCTION ${name}_fn()`).execute(db);
    try {
      await fn();
    } finally {
      await sql.raw(`DROP TRIGGER IF EXISTS ${name} ON ${table}`).execute(db);
      await sql.raw(`DROP FUNCTION IF EXISTS ${name}_fn()`).execute(db);
    }
  }

  it("rollback A: o ledger falha DEPOIS do movimento ⇒ nenhum movimento, nenhuma linha, aprovação segue pendente", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const id = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 80 }));
    await withTrigger("f80_fail_ledger", "need_fulfillments", "NEW.entry_type = 'correction'", async () => {
      const res = await decide(e, e.admin, id);
      expect(res.status).toBe(500);
    });
    expect(await deltas(e)).toEqual([["entrada", 100]]);
    expect(await ledger(a)).toHaveLength(1);
    expect((await db.selectFrom("approvalRequests").select(["status", "decidedByUserId"]).where("id", "=", id).executeTakeFirstOrThrow())).toEqual({ status: "pendente", decidedByUserId: null });
    // e depois do reparo a mesma aprovação funciona (nada ficou "meio feito")
    expect((await decide(e, e.admin, id)).status).toBe(200);
    expect(await deltas(e)).toEqual([["entrada", 100], ["ajuste", -20]]);
  });

  it("rollback B: a auditoria (último passo) falha ⇒ ledger + movimento desfeitos juntos (correção direta +20)", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const v1 = await tok(e, a);
    await withTrigger("f80_fail_audit", "audit_log", "NEW.action = 'atribuicao.recebimento_corrigido'", async () => {
      const res = await correct(e, a, e.operador, { expectedVigenteFulfillmentId: v1, quantity: 120 });
      expect(res.status).toBe(500);
    });
    expect(await deltas(e)).toEqual([["entrada", 100]]);
    expect(await ledger(a)).toHaveLength(1);
    expect(await stock(e.itemId)).toBe(100);
    expect((await correct(e, a, e.operador, { expectedVigenteFulfillmentId: v1, quantity: 120 })).status).toBe(200);
  });

  it("o movimento físico nunca vem do cliente: payload adulterado (delta/item) ⇒ pedido_obsoleto, nada executa; item de outra organização não é usado", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const id = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 80 }));
    await db.updateTable("approvalRequests").set({ payload: sql`jsonb_set(payload, '{deltaFisicoPlanejado}', '-50')` }).where("id", "=", id).execute();
    const r1 = await decide(e, e.admin, id);
    expect(r1.status).toBe(409);
    expect((await parseJson<{ code: string }>(r1)).code).toBe("pedido_obsoleto");

    const other = await setupEnv();
    await db.updateTable("approvalRequests").set({ payload: sql`jsonb_set(jsonb_set(payload, '{deltaFisicoPlanejado}', '-20'), '{itemId}', to_jsonb(${other.itemId}::int))` }).where("id", "=", id).execute();
    const r2 = await decide(e, e.admin, id);
    expect(r2.status).toBe(409);
    expect(await deltas(e)).toEqual([["entrada", 100]]);
    expect((await db.selectFrom("stockTransactions").select(["id"]).where("organizationId", "=", other.orgId).execute())).toHaveLength(0);
    expect(await ledger(a)).toHaveLength(1);
  });

  it("pedido da Fatia 1 (efeitoEstoque 'nenhum') aprovado agora executa SÓ o contábil, como foi autorizado", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const id = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 80 }));
    await db.updateTable("approvalRequests").set({ payload: sql`jsonb_set(payload, '{efeitoEstoque}', '"nenhum"')` }).where("id", "=", id).execute();
    expect((await decide(e, e.admin, id)).status).toBe(200);
    expect(await deltas(e)).toEqual([["entrada", 100]]);
    expect(await getNeedFulfillmentBalance(db, e.needId)).toBe(80);
  });

  it("retry depois da execução ⇒ 409 e nenhum segundo movimento nem segundo evento", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const v1 = await tok(e, a);
    expect((await correct(e, a, e.operador, { expectedVigenteFulfillmentId: v1, quantity: 120 })).status).toBe(200);
    expect((await correct(e, a, e.operador, { expectedVigenteFulfillmentId: v1, quantity: 120 })).status).toBe(409);
    expect(await deltas(e)).toEqual([["entrada", 100], ["ajuste", 20]]);
    expect(await auditOf(e, "atribuicao.recebimento_corrigido")).toHaveLength(1);
  });
});

describe("Fase 80 — concorrência física (Postgres real, Promise.all)", () => {
  async function twoAllocationsSharingItem() {
    const e = await setupEnv();
    const a1 = await receive(e, 50);
    const a2 = await receive(e, 50);
    // consumo: 100 → 30 em estoque
    await db.insertInto("stockTransactions").values({ organizationId: e.orgId, itemId: e.itemId, type: "saida", delta: "-70", createdByUserId: e.owner.userId }).execute();
    return { e, a1, a2 };
  }

  it("caso 1: duas correções físicas negativas (alocações do mesmo item) aprovadas ao mesmo tempo — só cabe uma; nunca saldo negativo", async () => {
    const { e, a1, a2 } = await twoAllocationsSharingItem();
    const r1 = await pendingId(await correct(e, a1, e.operador, { expectedVigenteFulfillmentId: await tok(e, a1), quantity: 30 })); // −20
    const r2 = await pendingId(await correct(e, a2, e.operador, { expectedVigenteFulfillmentId: await tok(e, a2), quantity: 30 })); // −20
    const results = await Promise.all([decide(e, e.admin, r1), decide(e, e.owner, r2)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await stock(e.itemId)).toBe(10);
    const adjustments = (await movements(e)).filter((m) => m.type === "ajuste");
    expect(adjustments).toHaveLength(1);
    expect((await db.selectFrom("approvalRequests").select(["status"]).execute()).map((r) => r.status).sort()).toEqual(["aprovada", "pendente"]);
  });

  it("caso 2/7: aprovação física negativa + outro ajuste/saída de estoque simultâneos — exatamente um vence, sem saldo negativo", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const id = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 80 })); // −20
    const [dec, saida] = await Promise.all([
      decide(e, e.admin, id),
      postStock(buildRequest("stock-transactions", { method: "POST", cookie: e.owner.cookie, body: { organizationId: e.orgId, itemId: e.itemId, type: "saida", quantity: 90, reason: "Distribuição" } })),
    ]);
    expect([dec.status, saida.status].sort()).toEqual([200, 409]);
    expect(await stock(e.itemId)).toBeGreaterThanOrEqual(0);
    expect(await stock(e.itemId)).toBe(dec.status === 200 ? 100 - 20 : 100 - 90);
  });

  it("caso 3: retirada física + outro consumo do mesmo estoque — exatamente um vence", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const id = await pendingId(await reverse(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), withdrawStock: true })); // −100
    const [dec, saida] = await Promise.all([
      decide(e, e.admin, id),
      postStock(buildRequest("stock-transactions", { method: "POST", cookie: e.owner.cookie, body: { organizationId: e.orgId, itemId: e.itemId, type: "saida", quantity: 60, reason: "Distribuição" } })),
    ]);
    expect([dec.status, saida.status].sort()).toEqual([200, 409]);
    expect(await stock(e.itemId)).toBe(dec.status === 200 ? 0 : 40);
    if (dec.status !== 200) expect(await ledger(a)).toHaveLength(1);
  });

  it("caso 4: duas reversals físicas concorrentes — um pedido só; decisões concorrentes executam uma vez", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const v1 = await tok(e, a);
    // Quem pede NUNCA aprova (autoaprovação = 403). Para o resultado não depender de quem ganha a corrida do pedido, os dois
    // que disputam o pedido são operadores (sem aprovacoes.decida) e os dois decisores são o administrador e o proprietário,
    // que não podem ser o solicitante em nenhuma ordem.
    const operador2 = await createAuthenticatedUser();
    await addMembership(e.orgId, operador2.userId, "operador");
    const [r1, r2] = await Promise.all([reverse(e, a, e.operador, { expectedVigenteFulfillmentId: v1, withdrawStock: true }), reverse(e, a, operador2, { expectedVigenteFulfillmentId: v1, withdrawStock: true })]);
    expect([r1.status, r2.status].sort()).toEqual([202, 409]);
    const pending = await db.selectFrom("approvalRequests").select(["id", "requestedByUserId"]).where("status", "=", "pendente").execute();
    expect(pending).toHaveLength(1);
    expect([e.operador.userId, operador2.userId]).toContain(pending[0].requestedByUserId);
    const [d1, d2] = await Promise.all([decide(e, e.admin, pending[0].id), decide(e, e.owner, pending[0].id)]);
    expect([d1.status, d2.status].sort()).toEqual([200, 409]);
    expect((await movements(e)).filter((m) => Number(m.delta) < 0)).toHaveLength(1);
    expect(await stock(e.itemId)).toBe(0);
  });

  it("caso 5: aprovação física + recebimento de OUTRA allocation do mesmo item simultâneos — sem deadlock, ambos concluem", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const id = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 80 }));
    const platform = await createAuthenticatedUser();
    const source = await createTestSource(platform.userId);
    const opp = await createTestOpportunityRegistry(source.id, platform.userId, { unit: "kg", status: "reservada" });
    const [al2] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: opp.id, organizationId: e.orgId, quantityAllocated: "30", status: "aceita", needId: e.needId }).returning(["id"]).execute();
    const [dec, rec] = await Promise.all([
      decide(e, e.admin, id),
      postReceive(buildRequest("allocations-receive", { method: "POST", cookie: e.owner.cookie, body: { organizationId: e.orgId, allocationId: al2.id, itemId: e.itemId, quantityReceived: 30 } })),
    ]);
    expect(dec.status).toBe(200);
    expect(rec.status).toBe(200);
    expect(await stock(e.itemId)).toBe(100 - 20 + 30);
  });

  it("caso 6: aprovação física + varredura do matching simultâneas — sem erro; matching segue 1.4", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const id = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 80 }));
    const { runMatchingSweep } = await import("../src/helpers/runMatchingSweep");
    const { ALGORITHM_VERSION } = await import("../src/helpers/opportunityMatching");
    const [dec] = await Promise.all([decide(e, e.admin, id), runMatchingSweep()]);
    expect(dec.status).toBe(200);
    expect(ALGORITHM_VERSION).toBe("1.4");
    expect(await stock(e.itemId)).toBe(80);
  });

  it("regressão do deadlock (achado da Fase 80): a decisão física NÃO conflita com quem segura a need em FOR KEY SHARE (FK do recebimento) — não espera", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const id = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 80 }));
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const acquired = new Promise<void>((r) => (held = r));
    const holder = db.transaction().execute(async (trx) => {
      await trx.selectFrom("needs").select(["id"]).where("id", "=", e.needId).forKeyShare().execute();
      held();
      await released;
    });
    await acquired;
    const res = await Promise.race([decide(e, e.admin, id), new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
    release();
    await holder;
    expect(res).not.toBeNull();
    expect((res as Response).status).toBe(200);
  });

  it("caso 5 (rajada): 6 rodadas de aprovação física × recebimento do mesmo item — nenhum deadlock", async () => {
    for (let i = 0; i < 6; i++) {
      const e = await setupEnv();
      const a = await receive(e);
      const id = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 80 }));
      const platform = await createAuthenticatedUser();
      const source = await createTestSource(platform.userId);
      const opp = await createTestOpportunityRegistry(source.id, platform.userId, { unit: "kg", status: "reservada" });
      const [al2] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: opp.id, organizationId: e.orgId, quantityAllocated: "30", status: "aceita", needId: e.needId }).returning(["id"]).execute();
      const [dec, rec] = await Promise.all([
        decide(e, e.admin, id),
        postReceive(buildRequest("allocations-receive", { method: "POST", cookie: e.owner.cookie, body: { organizationId: e.orgId, allocationId: al2.id, itemId: e.itemId, quantityReceived: 30 } })),
      ]);
      expect([dec.status, rec.status]).toEqual([200, 200]);
    }
  });

  it("prova determinística do lock do ITEM: a decisão física espera uma transação externa que segura o item (FOR NO KEY UPDATE) e só então executa", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const id = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 80 }));

    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const acquired = new Promise<void>((r) => (held = r));
    const holder = db.transaction().execute(async (trx) => {
      await trx.selectFrom("inventoryItems").select(["id"]).where("id", "=", e.itemId).forNoKeyUpdate().execute();
      held();
      await released;
    });
    await acquired;
    let finished = false;
    const pending = decide(e, e.admin, id).then((r) => {
      finished = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(finished).toBe(false);
    expect(await deltas(e)).toEqual([["entrada", 100]]);
    release();
    await holder;
    expect((await pending).status).toBe(200);
    expect(await deltas(e)).toEqual([["entrada", 100], ["ajuste", -20]]);
  });
});

describe("Fase 80 — segurança (RBAC / isolamento)", () => {
  it("quem não pode solicitar não pede retirada física (voluntário 403); autoaprovação 403; outra organização não decide", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const vol = await createAuthenticatedUser();
    await addMembership(e.orgId, vol.userId, "voluntario");
    expect((await reverse(e, a, vol, { expectedVigenteFulfillmentId: await tok(e, a), withdrawStock: true })).status).toBe(403);
    const id = await pendingId(await reverse(e, a, e.admin, { expectedVigenteFulfillmentId: await tok(e, a), withdrawStock: true }));
    expect((await decide(e, e.admin, id)).status).toBe(403);
    const other = await setupEnv();
    const cross = await postDecide(buildRequest("approval-requests-decide", { method: "POST", cookie: other.owner.cookie, body: { organizationId: other.orgId, requestId: id, decision: "aprovada" } }));
    expect(cross.status).toBe(404);
    expect(await deltas(e)).toEqual([["entrada", 100]]);
    expect(await stock(e.itemId)).toBe(100);
  });

  it("estoque de outra organização nunca é tocado por uma operação (movimentos só da própria org)", async () => {
    const e = await setupEnv();
    const other = await setupEnv();
    const oa = await receive(other);
    const a = await receive(e);
    await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 150 });
    expect(await stock(other.itemId)).toBe(100);
    expect(await ledger(oa)).toHaveLength(1);
    expect((await movements(other)).map((m) => Number(m.delta))).toEqual([100]);
  });
});
