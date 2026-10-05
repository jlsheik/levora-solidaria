/**
 * Fase 78 — Fatia 1 do ciclo de correção/estorno do ledger: histórico,
 * correção, estorno (SÓ contábeis), dupla autorização, precondição
 * otimista, locks, auditoria e isolamento. Postgres real, sem mocks.
 * Contrato: docs/LEDGER_CORRECOES_ESPECIFICACAO.md.
 */
import { describe, it, expect } from "vitest";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { handle as getHistory } from "../src/endpoints/allocations-receipt-history_GET";
import { handle as postCorrect } from "../src/endpoints/allocations-receipt-correct_POST";
import { handle as postReverse } from "../src/endpoints/allocations-receipt-reverse_POST";
import { handle as postReceive } from "../src/endpoints/allocations-receive_POST";
import { handle as postDecide } from "../src/endpoints/approval-requests-decide_POST";
import { handle as postNeedClosure } from "../src/endpoints/need-closure_POST";
import { expireApprovalRequests } from "../src/helpers/expireApprovalRequests";
import { getNeedFulfillmentBalance } from "../src/helpers/needFulfillment";
import { resolveLedgerChain, type LedgerRow } from "../src/helpers/needFulfillmentCorrections";
import { ALGORITHM_VERSION } from "../src/helpers/opportunityMatching";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import {
  createAuthenticatedUser,
  createTestOrganization,
  createTestSource,
  createTestOpportunityRegistry,
  createTestInventoryItem,
  addMembership,
  createPlatformAdmin,
  buildRequest,
  parseJson,
  type AuthenticatedTestUser,
} from "./helpers";
import type { OutputType as HistoryOutput } from "../src/endpoints/allocations-receipt-history_GET.schema";

interface Scenario {
  owner: AuthenticatedTestUser;
  operador: AuthenticatedTestUser;
  admin: AuthenticatedTestUser;
  voluntario: AuthenticatedTestUser;
  orgId: number;
  needId: number | null;
  allocationId: number;
  itemId: number;
}

async function setup(opts: { received?: number; needQuantity?: number; needUnit?: string; withNeed?: boolean; itemUnit?: string; receive?: boolean } = {}): Promise<Scenario> {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const operador = await createAuthenticatedUser();
  const admin = await createAuthenticatedUser();
  const voluntario = await createAuthenticatedUser();
  await addMembership(org.id, operador.userId, "operador");
  await addMembership(org.id, admin.userId, "administrador");
  await addMembership(org.id, voluntario.userId, "voluntario");

  let needId: number | null = null;
  if (opts.withNeed !== false) {
    const [need] = await db
      .insertInto("needs")
      .values({ organizationId: org.id, title: "Cobertores", quantityNeeded: String(opts.needQuantity ?? 500), unit: opts.needUnit ?? "kg", priority: "media", status: "aberta", createdByUserId: owner.userId })
      .returning(["id"])
      .execute();
    needId = need.id;
  }

  const item = await createTestInventoryItem(org.id, owner.userId, { unit: opts.itemUnit ?? "kg" });
  const platform = await createAuthenticatedUser();
  const source = await createTestSource(platform.userId);
  const opportunity = await createTestOpportunityRegistry(source.id, platform.userId, { unit: "kg", status: "reservada" });
  const [allocation] = await db
    .insertInto("opportunityAllocations")
    .values({ opportunityRegistryId: opportunity.id, organizationId: org.id, quantityAllocated: "100", status: "aceita", needId })
    .returning(["id"])
    .execute();

  const scenario: Scenario = { owner, operador, admin, voluntario, orgId: org.id, needId, allocationId: allocation.id, itemId: item.id };
  if (opts.receive !== false) {
    const res = await postReceive(
      buildRequest("allocations-receive", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: org.id, allocationId: allocation.id, itemId: item.id, quantityReceived: opts.received ?? 100 },
      })
    );
    expect(res.status).toBe(200);
  }
  return scenario;
}

async function history(s: Scenario, user: AuthenticatedTestUser, orgId = s.orgId, allocationId = s.allocationId) {
  const res = await getHistory(buildRequest(`allocations-receipt-history?organizationId=${orgId}&allocationId=${allocationId}`, { cookie: user.cookie }));
  return res;
}
async function historyData(s: Scenario, user: AuthenticatedTestUser = s.owner) {
  const res = await history(s, user);
  expect(res.status).toBe(200);
  return parseJson<HistoryOutput>(res);
}

async function correct(s: Scenario, user: AuthenticatedTestUser, body: Record<string, unknown>) {
  return postCorrect(buildRequest("allocations-receipt-correct", { method: "POST", cookie: user.cookie, body: { organizationId: s.orgId, allocationId: s.allocationId, reason: "Conferência", ...body } }));
}
async function reverse(s: Scenario, user: AuthenticatedTestUser, body: Record<string, unknown>) {
  return postReverse(buildRequest("allocations-receipt-reverse", { method: "POST", cookie: user.cookie, body: { organizationId: s.orgId, allocationId: s.allocationId, reason: "Evento inválido", ...body } }));
}
async function decide(s: Scenario, user: AuthenticatedTestUser, requestId: number, decision: "aprovada" | "rejeitada" = "aprovada", orgId = s.orgId) {
  return postDecide(buildRequest("approval-requests-decide", { method: "POST", cookie: user.cookie, body: { organizationId: orgId, requestId, decision } }));
}

async function vigente(s: Scenario) {
  return (await historyData(s)).vigenteFulfillmentId as string;
}
async function ledger(s: Scenario) {
  return db.selectFrom("needFulfillments").selectAll().where("allocationId", "=", s.allocationId).orderBy("id", "asc").execute();
}
async function stockCount() {
  const row = await db.selectFrom("stockTransactions").select([(eb) => eb.fn.countAll().as("n"), (eb) => eb.fn.sum("delta").as("total")]).executeTakeFirstOrThrow();
  return { n: Number(row.n), total: Number(row.total ?? 0) };
}
async function balance(s: Scenario) {
  return getNeedFulfillmentBalance(db, s.needId as number);
}
async function auditActions(s: Scenario) {
  const rows = await db.selectFrom("auditLog").select(["action", "metadata"]).where("organizationId", "=", s.orgId).orderBy("id", "asc").execute();
  return rows;
}

describe("Fase 78 — histórico do ledger", () => {
  it("lista o original (e só ele) com need, saldo, token de precondição e permissões do viewer", async () => {
    const s = await setup();
    const data = await historyData(s, s.voluntario);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({ entryType: "original", quantity: 100, unit: "kg", isCountable: true, state: "vigente", countedEffect: 100, reversesFulfillmentId: null });
    expect(data.rows[0].createdByDisplayName).toBeTruthy();
    expect(data.chainState).toBe("ativa");
    expect(data.vigenteFulfillmentId).toBe(data.rows[0].id);
    expect(data.need).toMatchObject({ unit: "kg", quantityNeeded: 500 });
    expect(data.progress).toEqual({ fulfilled: 100, requiredRemaining: 400, surplus: 0 });
    expect(data.pendingRequest).toBeNull();
    expect(data.viewer).toMatchObject({ canRequest: false, canDecide: false });
    expect((await historyData(s, s.operador)).viewer).toMatchObject({ canRequest: true, canDecide: false });
    expect((await historyData(s, s.admin)).viewer).toMatchObject({ canRequest: true, canDecide: true });
  });

  it("mantém o original visível e mostra a cadeia (par, estados, motivo, autor) depois de correções", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    expect((await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 120, reason: "Contagem refeita" })).status).toBe(200);
    const data = await historyData(s);
    expect(data.rows.map((r) => [r.entryType, r.quantity, r.state])).toEqual([
      ["original", 100, "substituida"],
      ["reversal", 100, "estorno"],
      ["correction", 120, "vigente"],
    ]);
    expect(data.rows[1].pairedWithCorrection).toBe(true);
    expect(data.rows[1].reason).toBe("Contagem refeita");
    expect(data.rows[2].reason).toBe("Contagem refeita");
    expect(data.rows[0].reason).toBeNull();
    expect(data.rows[1].reversesFulfillmentId).toBe(data.rows[0].id);
    expect(data.rows[2].reversesFulfillmentId).toBe(data.rows[0].id);
    expect(data.vigenteFulfillmentId).toBe(data.rows[2].id);
    expect(data.netCountedEffect).toBe(120);
    expect(data.progress?.fulfilled).toBe(120);
  });

  it("segurança: não-membro 403; membro inativo 403; allocation de outra organização 404; org errada 403", async () => {
    const s = await setup();
    const stranger = await createAuthenticatedUser();
    expect((await history(s, stranger)).status).toBe(403);

    const inactive = await createAuthenticatedUser();
    await addMembership(s.orgId, inactive.userId, "administrador", "inativo");
    expect((await history(s, inactive)).status).toBe(403);

    const other = await setup({ receive: true });
    // membro da organização B pedindo a allocation da organização A
    expect((await history(s, other.owner, other.orgId, s.allocationId)).status).toBe(404);
    // membro da organização B pedindo a organização A
    expect((await history(s, other.owner, s.orgId, s.allocationId)).status).toBe(403);
  });

  it("allocation sem recebimento: histórico vazio, sem token de precondição", async () => {
    const s = await setup({ receive: false });
    const data = await historyData(s);
    expect(data.rows).toEqual([]);
    expect(data.vigenteFulfillmentId).toBeNull();
    expect(data.chainState).toBeNull();
  });
});

describe("Fase 78 — correção contábil (par reversal + correction)", () => {
  it("100 → 120: executa direto (aumento), cria reversal 100 + correction 120, saldo 120, UM ajuste físico +20", async () => {
    const s = await setup();
    const stockBefore = await stockCount();
    const v1 = await vigente(s);

    const res = await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 120, reason: "Contagem refeita" });
    expect(res.status).toBe(200);
    const out = await parseJson<{ status: string; reversalFulfillmentId: string | null; fulfillmentId: string; progress: { fulfilled: number; surplus: number } }>(res);
    expect(out.status).toBe("executada");
    expect(out.reversalFulfillmentId).not.toBeNull();
    expect(out.progress.fulfilled).toBe(120);

    const rows = await ledger(s);
    expect(rows.map((r) => [r.entryType, Number(r.quantity), r.isCountable, r.stockTransactionId === null ? "sem-estoque" : "com-estoque"])).toEqual([
      ["original", 100, true, "com-estoque"],
      ["reversal", 100, true, "sem-estoque"],
      ["correction", 120, true, "com-estoque"],
    ]);
    expect(rows[1].reversesFulfillmentId).toBe(rows[0].id);
    expect(rows[2].reversesFulfillmentId).toBe(rows[0].id);
    expect(await balance(s)).toBe(120);
    expect(await stockCount()).toEqual({ n: stockBefore.n + 1, total: stockBefore.total + 20 });

    const events = (await auditActions(s)).filter((e) => e.action.startsWith("atribuicao.recebimento_"));
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("atribuicao.recebimento_corrigido");
    expect(events[0].metadata).toMatchObject({ quantidadeAnterior: 100, quantidadeNova: 120, efeitoEstoque: "ajuste", deltaFisico: 20, motivo: "Contagem refeita", allocationId: s.allocationId });
  });

  it("100 → 80: é redução ⇒ 202 pendente, ledger intacto até a aprovação; payload completo e imutável", async () => {
    const s = await setup();
    const stockBefore = await stockCount();
    const v1 = await vigente(s);

    const res = await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 80, reason: "Faltaram 20" });
    expect(res.status).toBe(202);
    const { approvalRequestId, status } = await parseJson<{ approvalRequestId: number; status: string }>(res);
    expect(status).toBe("pendente_aprovacao");

    expect(await ledger(s)).toHaveLength(1);
    expect(await balance(s)).toBe(100);

    const req = await db.selectFrom("approvalRequests").selectAll().where("id", "=", approvalRequestId).executeTakeFirstOrThrow();
    expect(req.status).toBe("pendente");
    expect(req.actionType).toBe("correcao_recebimento");
    expect(req.organizationId).toBe(s.orgId);
    expect(req.requestedByUserId).toBe(s.operador.userId);
    expect(req.payload).toMatchObject({
      organizationId: s.orgId,
      allocationId: s.allocationId,
      operacao: "correcao",
      targetFulfillmentId: v1,
      quantidadeAnterior: 100,
      quantidadeNova: 80,
      unidadeAnterior: "kg",
      unidadeNova: "kg",
      efeitoEstoque: "ajuste",
      retiradaFisica: false,
      saldoFisicoAllocation: 100,
      deltaFisicoPlanejado: -20,
      itemId: s.itemId,
      motivo: "Faltaram 20",
    });
    expect((req.payload as { solicitadoEm: string }).solicitadoEm).toBeTruthy();

    const pendingEvent = (await auditActions(s)).filter((e) => e.action === "atribuicao.recebimento_pendente_aprovacao");
    expect(pendingEvent).toHaveLength(1);
    expect(await stockCount()).toEqual(stockBefore);

    // Nenhuma transação ficou aberta esperando a decisão humana.
    const idle = await sql<{ n: string }>`SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`.execute(db);
    expect(Number(idle.rows[0].n)).toBe(0);

    // O pedido é exibido no histórico.
    expect((await historyData(s)).pendingRequest).toMatchObject({ id: approvalRequestId, actionType: "correcao_recebimento" });

    // Aprovação por OUTRA pessoa executa o par; saldo 80; estoque intacto.
    const approve = await decide(s, s.admin, approvalRequestId);
    expect(approve.status).toBe(200);
    const rows = await ledger(s);
    expect(rows.map((r) => [r.entryType, Number(r.quantity)])).toEqual([["original", 100], ["reversal", 100], ["correction", 80]]);
    expect(await balance(s)).toBe(80);
    // UM ajuste −20 (nunca saída 100 + entrada 80), vinculado à correction; a reversal do par não tem movimento
    expect(await stockCount()).toEqual({ n: stockBefore.n + 1, total: stockBefore.total - 20 });
    expect(rows[1].stockTransactionId).toBeNull();
    expect(rows[2].stockTransactionId).not.toBeNull();
    // autor das linhas = solicitante
    expect(rows[1].createdByUserId).toBe(s.operador.userId);

    const decided = await db.selectFrom("approvalRequests").select(["status", "decidedByUserId"]).where("id", "=", approvalRequestId).executeTakeFirstOrThrow();
    expect(decided).toEqual({ status: "aprovada", decidedByUserId: s.admin.userId });

    const events = (await auditActions(s)).filter((e) => e.action === "atribuicao.recebimento_corrigido");
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ approvalRequestId, solicitanteUserId: s.operador.userId, quantidadeNova: 80, motivo: "Faltaram 20" });
    expect((await historyData(s)).pendingRequest).toBeNull();
  });

  it("100 → 100: 422 sem_alteracao e nenhuma linha criada", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    const res = await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 100 });
    expect(res.status).toBe(422);
    expect((await parseJson<{ code: string }>(res)).code).toBe("sem_alteracao");
    // mesma unidade, só grafia diferente: continua sem alteração
    const res2 = await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, unit: " KG " });
    expect(res2.status).toBe(422);
    expect(await ledger(s)).toHaveLength(1);
    expect((await auditActions(s)).filter((e) => e.action.startsWith("atribuicao.recebimento_"))).toHaveLength(0);
  });

  it("quantidade e unidade juntas (ambas mudam) ⇒ 422 com código estável, nada criado", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    const res = await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 90, unit: "litros" });
    expect(res.status).toBe(422);
    expect((await parseJson<{ code: string }>(res)).code).toBe("quantidade_e_unidade_juntas");
    expect(await ledger(s)).toHaveLength(1);
  });

  it("validação de entrada: sem quantity/unit, motivo curto/longo, id malformado ⇒ 400", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    expect((await correct(s, s.operador, { expectedVigenteFulfillmentId: v1 })).status).toBe(400);
    expect((await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 110, reason: "x" })).status).toBe(400);
    expect((await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 110, reason: "a".repeat(201) })).status).toBe(400);
    expect((await correct(s, s.operador, { expectedVigenteFulfillmentId: "1 OR 1=1", quantity: 110 })).status).toBe(400);
    expect((await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: -5 })).status).toBe(400);
    expect((await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 1.2345 })).status).toBe(400);
    expect(await ledger(s)).toHaveLength(1);
  });

  it("cadeia: correction de correction (120 direto, depois 90 com aprovação) preserva todo o passado", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    expect((await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 120 })).status).toBe(200);
    const v2 = await vigente(s);
    expect(v2).not.toBe(v1);

    const res = await correct(s, s.operador, { expectedVigenteFulfillmentId: v2, quantity: 90 });
    expect(res.status).toBe(202);
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(res);
    expect((await decide(s, s.admin, approvalRequestId)).status).toBe(200);

    const data = await historyData(s);
    expect(data.rows.map((r) => [r.entryType, r.quantity, r.state])).toEqual([
      ["original", 100, "substituida"],
      ["reversal", 100, "estorno"],
      ["correction", 120, "substituida"],
      ["reversal", 120, "estorno"],
      ["correction", 90, "vigente"],
    ]);
    expect(await balance(s)).toBe(90);
    // nada do passado foi alterado (append-only): ids/valores originais seguem iguais
    const rows = await ledger(s);
    expect(rows[0].id.toString()).toBe(v1);
    expect(Number(rows[0].quantity)).toBe(100);
  });

  it("unidade: contável→não contável (redução ⇒ aprovação), depois não contável→contável (direto, sem reversal), sem conversão", async () => {
    const s = await setup({ needUnit: "kg", itemUnit: "kg" });
    const itemBefore = await db.selectFrom("inventoryItems").select(["unit"]).where("id", "=", s.itemId).executeTakeFirstOrThrow();
    const v1 = await vigente(s);

    const res = await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, unit: "litros", reason: "Era líquido" });
    expect(res.status).toBe(202);
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(res);
    expect((await decide(s, s.owner, approvalRequestId)).status).toBe(200);

    let rows = await ledger(s);
    expect(rows.map((r) => [r.entryType, Number(r.quantity), r.unit, r.isCountable])).toEqual([
      ["original", 100, "kg", true],
      ["reversal", 100, "kg", true],
      ["correction", 100, "litros", false],
    ]);
    expect(rows[2].unitMismatchNote).toContain("is_countable=false");
    expect(await balance(s)).toBe(0);

    const v2 = await vigente(s);
    const back = await correct(s, s.operador, { expectedVigenteFulfillmentId: v2, unit: "KG", reason: "Era kg mesmo" });
    expect(back.status).toBe(200);
    rows = await ledger(s);
    expect(rows).toHaveLength(4); // só UMA correction, sem reversal (linha anterior não contava)
    expect(rows[3]).toMatchObject({ entryType: "correction", unit: "KG", isCountable: true });
    expect(Number(rows[3].quantity)).toBe(100);
    expect(await balance(s)).toBe(100);

    // não contável → não contável (rótulo administrativo): só correction, sem efeito
    const v3 = await vigente(s);
    const toMl = await correct(s, s.operador, { expectedVigenteFulfillmentId: v3, unit: "ml" });
    expect(toMl.status).toBe(202); // contável→não contável: redução de efeito
    const { approvalRequestId: r2 } = await parseJson<{ approvalRequestId: number }>(toMl);
    expect((await decide(s, s.admin, r2)).status).toBe(200);
    const v4 = await vigente(s);
    const adminRename = await correct(s, s.operador, { expectedVigenteFulfillmentId: v4, unit: "galões" });
    expect(adminRename.status).toBe(200); // não contável → não contável: sem efeito
    expect(await balance(s)).toBe(0);

    // sem conversão: o item de inventário não foi tocado
    expect(await db.selectFrom("inventoryItems").select(["unit"]).where("id", "=", s.itemId).executeTakeFirstOrThrow()).toEqual(itemBefore);
  });

  it("alocação sem necessidade: corrige o registro sem afetar nenhuma necessidade", async () => {
    const s = await setup({ withNeed: false });
    const v1 = await vigente(s);
    const res = await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 130 });
    expect(res.status).toBe(200);
    expect((await parseJson<{ progress: unknown }>(res)).progress).toBeNull();
    const rows = await ledger(s);
    expect(rows).toHaveLength(2); // original + correction (reversal omitida: a linha não conta para nenhuma necessidade)
    expect(rows.every((r) => r.needId === null)).toBe(true);
  });

  it("excedente (P-L1/P-L2): correção positiva acima da necessidade é permitida e registrada; estorno o reduz; needs.status não muda", async () => {
    const s = await setup({ needQuantity: 500, received: 450 });
    const v1 = await vigente(s);
    const res = await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 650, reason: "Chegou mais" });
    expect(res.status).toBe(200);
    expect((await parseJson<{ progress: { fulfilled: number; requiredRemaining: number; surplus: number } }>(res)).progress).toEqual({ fulfilled: 650, requiredRemaining: 0, surplus: 150 });
    const ev = (await auditActions(s)).filter((e) => e.action === "atribuicao.recebimento_corrigido");
    expect(ev[0].metadata).toMatchObject({ excedente: 150, excedenteAnterior: 0 });

    await db.updateTable("needs").set({ status: "atendida" }).where("id", "=", s.needId as number).execute();
    const v2 = await vigente(s);
    const rev = await reverse(s, s.operador, { expectedVigenteFulfillmentId: v2 });
    expect(rev.status).toBe(202);
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(rev);
    expect((await decide(s, s.admin, approvalRequestId)).status).toBe(200);

    const data = await historyData(s);
    expect(data.progress).toEqual({ fulfilled: 0, requiredRemaining: 500, surplus: 0 });
    // status administrativo independente do ledger
    const need = await db.selectFrom("needs").select(["status"]).where("id", "=", s.needId as number).executeTakeFirstOrThrow();
    expect(need.status).toBe("atendida");
  });
});

describe("Fase 78 — estorno contábil e cadeias", () => {
  it("estorno: sempre dupla autorização; original 100 → reversal 100; saldo 0; original continua; nada físico", async () => {
    const s = await setup();
    const stockBefore = await stockCount();
    const v1 = await vigente(s);

    const res = await reverse(s, s.operador, { expectedVigenteFulfillmentId: v1, reason: "Doação duplicada" });
    expect(res.status).toBe(202);
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(res);
    expect(await ledger(s)).toHaveLength(1);
    expect((await db.selectFrom("approvalRequests").select(["actionType"]).where("id", "=", approvalRequestId).executeTakeFirstOrThrow()).actionType).toBe("estorno_recebimento");

    expect((await decide(s, s.admin, approvalRequestId)).status).toBe(200);
    const rows = await ledger(s);
    expect(rows.map((r) => [r.entryType, Number(r.quantity), r.stockTransactionId])).toEqual([["original", 100, rows[0].stockTransactionId], ["reversal", 100, null]]);
    expect(rows[1].reversesFulfillmentId).toBe(rows[0].id);
    expect(await balance(s)).toBe(0);
    expect(await stockCount()).toEqual(stockBefore);

    const data = await historyData(s);
    expect(data.chainState).toBe("estornada");
    expect(data.rows.map((r) => r.state)).toEqual(["estornada", "estorno"]);
    expect(data.rows[1].pairedWithCorrection).toBe(false);
    expect(data.vigenteFulfillmentId).toBe(data.rows[1].id); // token muda quando o estado muda
    expect(data.netCountedEffect).toBe(0);

    const ev = (await auditActions(s)).filter((e) => e.action === "atribuicao.recebimento_estornado");
    expect(ev).toHaveLength(1);
    expect(ev[0].metadata).toMatchObject({ approvalRequestId, motivo: "Doação duplicada", efeitoEstoque: "nenhum", quantidadeAnterior: 100 });
  });

  it("estorno duplicado é recusado (já estornado) e o token antigo é obsoleto; reversal de reversal impossível", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(await reverse(s, s.operador, { expectedVigenteFulfillmentId: v1 }));
    await decide(s, s.admin, approvalRequestId);

    // token antigo (a linha que o cliente viu antes do estorno)
    const stale = await reverse(s, s.operador, { expectedVigenteFulfillmentId: v1 });
    expect(stale.status).toBe(409);
    expect((await parseJson<{ code: string }>(stale)).code).toBe("recebimento_alterado");

    // token atual (a reversal): ainda assim já está estornada
    const v2 = await vigente(s);
    const again = await reverse(s, s.operador, { expectedVigenteFulfillmentId: v2 });
    expect(again.status).toBe(409);
    expect((await parseJson<{ code: string }>(again)).code).toBe("ja_estornado");

    // o banco continua barrando reversal → reversal diretamente
    const rows = await ledger(s);
    await expect(
      db
        .insertInto("needFulfillments")
        .values({ organizationId: s.orgId, needId: s.needId, allocationId: s.allocationId, stockTransactionId: null, quantity: "100", unit: "kg", entryType: "reversal", reversesFulfillmentId: rows[1].id })
        .execute()
    ).rejects.toThrow(/reversal/);
    expect(await ledger(s)).toHaveLength(2);
  });

  it("desfazer um estorno = nova correction na linha estornada (aumento ⇒ direto, sem reversal); depois é possível estornar de novo", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(await reverse(s, s.operador, { expectedVigenteFulfillmentId: v1 }));
    await decide(s, s.admin, approvalRequestId);

    const v2 = await vigente(s);
    const react = await correct(s, s.operador, { expectedVigenteFulfillmentId: v2, quantity: 100, reason: "Estorno foi engano" });
    expect(react.status).toBe(200);
    const rows = await ledger(s);
    expect(rows.map((r) => r.entryType)).toEqual(["original", "reversal", "correction"]);
    expect(rows[2].reversesFulfillmentId).toBe(rows[0].id);
    expect(await balance(s)).toBe(100);
    const data = await historyData(s);
    expect(data.chainState).toBe("ativa");
    expect(data.rows.map((r) => r.state)).toEqual(["substituida", "estorno", "vigente"]);

    const v3 = await vigente(s);
    const again = await reverse(s, s.operador, { expectedVigenteFulfillmentId: v3 });
    expect(again.status).toBe(202);
  });

  it("resolveLedgerChain (helper canônico): par com mesmo timestamp, estornada, reativada", () => {
    const t = new Date("2026-01-01T00:00:00Z");
    const row = (id: number, entryType: LedgerRow["entryType"], reverses: number | null, quantity = 100): LedgerRow => ({
      id: String(id), entryType, needId: 1, quantity, unit: "kg", isCountable: true, reversesFulfillmentId: reverses === null ? null : String(reverses), createdByUserId: null, createdAt: t, stockTransactionId: null,
    });
    const active = resolveLedgerChain([row(1, "original", null), row(2, "reversal", 1), row(3, "correction", 1, 80)]);
    expect(active.head?.id).toBe("3");
    expect(active.headState).toBe("ativa");
    expect(active.vigenteFulfillmentId).toBe("3");
    const reversed = resolveLedgerChain([row(1, "original", null), row(2, "reversal", 1)]);
    expect(reversed.head?.id).toBe("1");
    expect(reversed.headState).toBe("estornada");
    expect(reversed.vigenteFulfillmentId).toBe("2");
    const reactivated = resolveLedgerChain([row(1, "original", null), row(2, "reversal", 1), row(3, "correction", 1, 100)]);
    expect(reactivated.head?.id).toBe("3");
    expect(reactivated.headState).toBe("ativa");
    // ids grandes (BIGINT) comparam numericamente, não por texto
    const big = resolveLedgerChain([row(9, "original", null), row(10, "correction", 9, 70)]);
    expect(big.head?.id).toBe("10");
    expect(resolveLedgerChain([]).head).toBeNull();
  });
});

describe("Fase 78 — precondição otimista e pedido obsoleto", () => {
  it("expectedVigenteFulfillmentId desatualizado na solicitação ⇒ 409 recebimento_alterado com o token atual", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    expect((await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 120 })).status).toBe(200);
    const v2 = await vigente(s);

    const retry = await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 120 });
    expect(retry.status).toBe(409);
    const body = await parseJson<{ code: string; currentVigenteFulfillmentId: string }>(retry);
    expect(body.code).toBe("recebimento_alterado");
    expect(body.currentVigenteFulfillmentId).toBe(v2);
    expect(await ledger(s)).toHaveLength(3); // o retry NÃO duplicou nada
  });

  it("token inventado ou de outra allocation é recusado (409), sem escrever", async () => {
    const s = await setup();
    const other = await setup();
    const otherToken = await vigente(other);
    expect((await correct(s, s.operador, { expectedVigenteFulfillmentId: otherToken, quantity: 120 })).status).toBe(409);
    expect((await correct(s, s.operador, { expectedVigenteFulfillmentId: "999999999", quantity: 120 })).status).toBe(409);
    expect(await ledger(s)).toHaveLength(1);
    expect(await ledger(other)).toHaveLength(1);
  });

  it("pedido obsoleto: a vigente mudou entre a solicitação e a aprovação ⇒ 409 pedido_obsoleto, nada executa, pedido segue pendente e ainda pode ser rejeitado", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 80 }));
    // outra operação muda a vigente (aumento direto)
    expect((await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 150 })).status).toBe(200);
    const rowsBefore = await ledger(s);

    const res = await decide(s, s.admin, approvalRequestId);
    expect(res.status).toBe(409);
    expect((await parseJson<{ code: string }>(res)).code).toBe("pedido_obsoleto");
    expect(await ledger(s)).toHaveLength(rowsBefore.length);
    expect(await balance(s)).toBe(150);
    expect((await db.selectFrom("approvalRequests").select(["status"]).where("id", "=", approvalRequestId).executeTakeFirstOrThrow()).status).toBe("pendente");
    expect((await auditActions(s)).filter((e) => e.action === "atribuicao.recebimento_corrigido")).toHaveLength(1); // só a correção direta

    // rejeitar continua possível e não revalida
    expect((await decide(s, s.admin, approvalRequestId, "rejeitada")).status).toBe(200);
  });

  it("enquanto há um pedido pendente, um estorno concorrente na mesma allocation é recusado (pedido_pendente)", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    const { approvalRequestId: reduceId } = await parseJson<{ approvalRequestId: number }>(await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 70 }));
    // não dá para criar um 2º pedido pendente na mesma allocation: o estorno concorre por outra via
    const second = await reverse(s, s.operador, { expectedVigenteFulfillmentId: v1 });
    expect(second.status).toBe(409);
    expect((await parseJson<{ code: string }>(second)).code).toBe("pedido_pendente");
    expect((await decide(s, s.admin, reduceId, "rejeitada")).status).toBe(200);
    expect(await ledger(s)).toHaveLength(1);
  });

  it("um único pedido pendente por allocation: o segundo recebe 409 pedido_pendente", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    const a = await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 80 });
    expect(a.status).toBe(202);
    const b = await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 70 });
    expect(b.status).toBe(409);
    const body = await parseJson<{ code: string; approvalRequestId: number }>(b);
    expect(body.code).toBe("pedido_pendente");
    expect(body.approvalRequestId).toBe((await parseJson<{ approvalRequestId: number }>(a)).approvalRequestId);
    expect(await db.selectFrom("approvalRequests").select(["id"]).where("status", "=", "pendente").execute()).toHaveLength(1);
  });
});

describe("Fase 78 — dupla autorização: segurança", () => {
  async function pendingReduction() {
    const s = await setup();
    const v1 = await vigente(s);
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 80 }));
    return { s, approvalRequestId, v1 };
  }

  it("autoaprovação ⇒ 403 mesmo sendo proprietário/administrador; nada executa; pedido segue pendente", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    // proprietário solicita
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(await correct(s, s.owner, { expectedVigenteFulfillmentId: v1, quantity: 80 }));
    const self = await decide(s, s.owner, approvalRequestId);
    expect(self.status).toBe(403);
    expect(await ledger(s)).toHaveLength(1);
    // administrador também não aprova o próprio pedido
    await decide(s, s.admin, approvalRequestId, "rejeitada");
    const { approvalRequestId: adminReq } = await parseJson<{ approvalRequestId: number }>(await correct(s, s.admin, { expectedVigenteFulfillmentId: v1, quantity: 60 }));
    expect((await decide(s, s.admin, adminReq)).status).toBe(403);
    expect((await db.selectFrom("approvalRequests").select(["status"]).where("id", "=", adminReq).executeTakeFirstOrThrow()).status).toBe("pendente");
    // e outra pessoa pode
    expect((await decide(s, s.owner, adminReq)).status).toBe(200);
    expect(await balance(s)).toBe(60);
  });

  it("quem não tem aprovacoes.decida (operador/voluntário) recebe 403; não-membro 403; membro inativo 403", async () => {
    const { s, approvalRequestId } = await pendingReduction();
    expect((await decide(s, s.operador, approvalRequestId)).status).toBe(403);
    expect((await decide(s, s.voluntario, approvalRequestId)).status).toBe(403);
    const stranger = await createAuthenticatedUser();
    expect((await decide(s, stranger, approvalRequestId)).status).toBe(403);
    const inactive = await createAuthenticatedUser();
    await addMembership(s.orgId, inactive.userId, "administrador", "inativo");
    expect((await decide(s, inactive, approvalRequestId)).status).toBe(403);
    expect(await ledger(s)).toHaveLength(1);
  });

  it("IDOR: administrador de OUTRA organização não decide (404 com o próprio orgId; 403 com o orgId alheio); administrador da plataforma sem membership também não", async () => {
    const { s, approvalRequestId } = await pendingReduction();
    const other = await setup();
    expect((await decide(s, other.owner, approvalRequestId, "aprovada", other.orgId)).status).toBe(404);
    expect((await decide(s, other.owner, approvalRequestId, "aprovada", s.orgId)).status).toBe(403);
    const platform = await createPlatformAdmin(); // Fase 90: titular de plataforma tem MFA e sessão com MFA concluído
    expect((await decide(s, platform, approvalRequestId, "aprovada", s.orgId)).status).toBe(403);
    expect(await ledger(s)).toHaveLength(1);
    expect(await ledger(other)).toHaveLength(1);
  });

  it("solicitar: voluntário e não-membro ⇒ 403; membro inativo ⇒ 403; allocation de outra organização ⇒ 404; nada é gravado", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    expect((await correct(s, s.voluntario, { expectedVigenteFulfillmentId: v1, quantity: 120 })).status).toBe(403);
    expect((await reverse(s, s.voluntario, { expectedVigenteFulfillmentId: v1 })).status).toBe(403);
    const stranger = await createAuthenticatedUser();
    expect((await correct(s, stranger, { expectedVigenteFulfillmentId: v1, quantity: 120 })).status).toBe(403);
    const inactive = await createAuthenticatedUser();
    await addMembership(s.orgId, inactive.userId, "operador", "inativo");
    expect((await correct(s, inactive, { expectedVigenteFulfillmentId: v1, quantity: 120 })).status).toBe(403);

    const other = await setup();
    const crossed = await postCorrect(
      buildRequest("allocations-receipt-correct", { method: "POST", cookie: other.owner.cookie, body: { organizationId: other.orgId, allocationId: s.allocationId, expectedVigenteFulfillmentId: v1, quantity: 120, reason: "IDOR" } })
    );
    expect(crossed.status).toBe(404);
    expect(await ledger(s)).toHaveLength(1);
    expect(await db.selectFrom("approvalRequests").select(["id"]).execute()).toHaveLength(0);
    expect((await db.selectFrom("auditLog").select(["id"]).where("action", "like", "atribuicao.recebimento_%").execute())).toHaveLength(0);
  });

  it("aprovação duplicada (sequencial) ⇒ segunda 409; o ledger tem uma única execução", async () => {
    const { s, approvalRequestId } = await pendingReduction();
    expect((await decide(s, s.admin, approvalRequestId)).status).toBe(200);
    expect((await decide(s, s.owner, approvalRequestId)).status).toBe(409);
    expect(await ledger(s)).toHaveLength(3);
    expect(await balance(s)).toBe(80);
  });

  it("rejeição: ledger e estoque intactos, só o estado do pedido muda, auditoria aprovacao.rejeitada e nenhum evento corrigido/estornado", async () => {
    const { s, approvalRequestId } = await pendingReduction();
    const stockBefore = await stockCount();
    expect((await decide(s, s.admin, approvalRequestId, "rejeitada")).status).toBe(200);
    expect(await ledger(s)).toHaveLength(1);
    expect(await stockCount()).toEqual(stockBefore);
    const row = await db.selectFrom("approvalRequests").select(["status", "decidedByUserId"]).where("id", "=", approvalRequestId).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "rejeitada", decidedByUserId: s.admin.userId });
    const actions = (await auditActions(s)).map((e) => e.action);
    expect(actions).toContain("aprovacao.rejeitada");
    expect(actions).not.toContain("atribuicao.recebimento_corrigido");
    expect(actions).not.toContain("atribuicao.recebimento_estornado");
    // depois de rejeitado, não pode ser aprovado
    expect((await decide(s, s.owner, approvalRequestId)).status).toBe(409);
  });

  it("expiração: pedido expirado (pela tarefa existente) não pode ser aprovado e não altera o ledger; pedido velho ainda não varrido também não", async () => {
    const { s, approvalRequestId } = await pendingReduction();
    // envelhece o pedido (8 dias) sem a varredura ter rodado ainda
    await db.updateTable("approvalRequests").set({ createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) }).where("id", "=", approvalRequestId).execute();
    const early = await decide(s, s.admin, approvalRequestId);
    expect(early.status).toBe(409);
    expect((await parseJson<{ code: string }>(early)).code).toBe("pedido_expirado");
    expect(await ledger(s)).toHaveLength(1);

    await expireApprovalRequests();
    expect((await db.selectFrom("approvalRequests").select(["status"]).where("id", "=", approvalRequestId).executeTakeFirstOrThrow()).status).toBe("expirada");
    expect((await auditActions(s)).map((e) => e.action)).toContain("aprovacao.expirada");
    expect((await decide(s, s.admin, approvalRequestId)).status).toBe(409);
    expect(await ledger(s)).toHaveLength(1);
    expect(await balance(s)).toBe(100);
    // pedido expirado libera a allocation para um novo pedido
    const v1 = await vigente(s);
    expect((await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 90 })).status).toBe(202);
  });

  it("o payload do pedido é a única fonte: o corpo da decisão não carrega quantidade/alvo; um payload adulterado no banco é recusado", async () => {
    const { s, approvalRequestId } = await pendingReduction();
    await db
      .updateTable("approvalRequests")
      .set({ payload: sql`jsonb_set(payload, '{organizationId}', to_jsonb(999999))` })
      .where("id", "=", approvalRequestId)
      .execute();
    const res = await decide(s, s.admin, approvalRequestId);
    expect(res.status).toBe(409);
    const body = await parseJson<Record<string, unknown>>(res);
    // contrato inalterado (409, corpo só com message); mensagem do domínio do ledger, sem vazar o payload
    expect(Object.keys(body)).toEqual(["message"]);
    expect(body.message).toContain("correção ou do estorno");
    expect(String(body.message)).not.toMatch(/item de inventário|999999|payload|organizationId/i);
    expect(await ledger(s)).toHaveLength(1);
    expect((await db.selectFrom("approvalRequests").select(["status"]).where("id", "=", approvalRequestId).executeTakeFirstOrThrow()).status).toBe("pendente");
  });

  it("auditoria: nada de e-mail/senha/token na metadata; cadeia de hash íntegra; um evento por operação", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 120, reason: "Contagem" });
    const v2 = await vigente(s);
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(await reverse(s, s.operador, { expectedVigenteFulfillmentId: v2, reason: "Duplicada" }));
    await decide(s, s.admin, approvalRequestId);

    const events = (await auditActions(s)).filter((e) => e.action.startsWith("atribuicao.recebimento_"));
    expect(events.map((e) => e.action)).toEqual([
      "atribuicao.recebimento_corrigido",
      "atribuicao.recebimento_pendente_aprovacao",
      "atribuicao.recebimento_estornado",
    ]);
    const dump = JSON.stringify(events.map((e) => e.metadata)).toLowerCase();
    for (const u of [s.owner, s.operador, s.admin]) expect(dump).not.toContain(u.email.toLowerCase());
    expect(dump).not.toMatch(/senha|password|token|jwt|cookie|@/);
    const chain = await verifyAuditLogChain();
    expect(chain.integra).toBe(true);
  });
});

describe("Fase 78 — concorrência (Postgres real, Promise.all)", () => {
  it("caso 1: duas correções simultâneas com a mesma precondição ⇒ uma vence (200), a outra 409; ledger sem duplicar", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    const results = await Promise.all([
      correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 120 }),
      correct(s, s.admin, { expectedVigenteFulfillmentId: v1, quantity: 130 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const rows = await ledger(s);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.entryType === "reversal")).toHaveLength(1);
    expect([120, 130]).toContain(await balance(s));
  });

  it("caso 1b: várias correções simultâneas (rajada) ⇒ exatamente uma aplica, sem 5xx", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 110 + i })));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((x) => x === 200)).toHaveLength(1);
    expect(statuses.filter((x) => x === 409)).toHaveLength(5);
    expect(await ledger(s)).toHaveLength(3);
  });

  it("caso 2: correction + estorno simultâneos ⇒ sem 5xx, sem deadlock, cadeia coerente; o pedido do estorno fica obsoleto se a correção venceu", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    const [c, r] = await Promise.all([
      correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 120 }),
      reverse(s, s.admin, { expectedVigenteFulfillmentId: v1 }),
    ]);
    expect([200]).toContain(c.status); // a correção direta nunca é bloqueada por um pedido
    expect([202, 409]).toContain(r.status);
    if (r.status === 202) {
      // o pedido foi criado ANTES da correção: ao aprovar, está obsoleto
      const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(r);
      const res = await decide(s, s.owner, approvalRequestId);
      expect(res.status).toBe(409);
      expect((await parseJson<{ code: string }>(res)).code).toBe("pedido_obsoleto");
    }
    expect(await balance(s)).toBe(120);
    expect((await ledger(s)).filter((x) => x.entryType === "reversal")).toHaveLength(1);
  });

  it("caso 3: recebimento + correção simultâneos ⇒ sem 5xx; sem original a correção é recusada (409)", async () => {
    const s = await setup({ receive: false });
    const [receive, corr] = await Promise.all([
      postReceive(
        buildRequest("allocations-receive", {
          method: "POST",
          cookie: s.owner.cookie,
          body: { organizationId: s.orgId, allocationId: s.allocationId, itemId: s.itemId, quantityReceived: 100 },
        })
      ),
      correct(s, s.operador, { expectedVigenteFulfillmentId: "999999999999", quantity: 120 }),
    ]);
    expect(receive.status).toBe(200);
    expect([409]).toContain(corr.status);
    const rows = await ledger(s);
    expect(rows.filter((r) => r.entryType === "original")).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it("caso 4: estorno aprovado + varredura de matching simultâneos ⇒ sem erro; a necessidade volta a ter saldo faltante; matching continua 1.4", async () => {
    expect(ALGORITHM_VERSION).toBe("1.4");
    const s = await setup({ needQuantity: 100, received: 100 });
    const v1 = await vigente(s);
    expect((await historyData(s)).progress?.requiredRemaining).toBe(0);
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(await reverse(s, s.operador, { expectedVigenteFulfillmentId: v1 }));
    const { runMatchingSweep } = await import("../src/helpers/runMatchingSweep");
    const [dec] = await Promise.all([decide(s, s.admin, approvalRequestId), runMatchingSweep()]);
    expect(dec.status).toBe(200);
    expect((await historyData(s)).progress).toEqual({ fulfilled: 0, requiredRemaining: 100, surplus: 0 });
    const need = await db.selectFrom("needs").select(["status"]).where("id", "=", s.needId as number).executeTakeFirstOrThrow();
    expect(need.status).toBe("aberta"); // o lifecycle/status administrativo não é tocado pelo ledger
    const opp = await db.selectFrom("opportunityAllocations").select(["status"]).where("id", "=", s.allocationId).executeTakeFirstOrThrow();
    expect(opp.status).toBe("recebida"); // lifecycle da allocation não reabre
  });

  it("caso 5: correção + atualização de status da necessidade simultâneas ⇒ ambas aplicam, sem deadlock, independentes", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    const [c, st] = await Promise.all([
      correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 140 }),
      postNeedClosure(buildRequest("need-closure", { method: "POST", cookie: s.owner.cookie, body: { action: "encerrar", organizationId: s.orgId, needId: s.needId, reasonCode: "duplicidade" } })),
    ]);
    expect(c.status).toBe(200);
    expect(st.status).toBe(200);
    expect(await balance(s)).toBe(140);
    expect((await db.selectFrom("needs").select(["status"]).where("id", "=", s.needId as number).executeTakeFirstOrThrow()).status).toBe("cancelada"); // Fase 99F: o encerramento é o caminho de cancelamento
  });

  it("caso 6: dois usuários aprovam o mesmo pedido ⇒ só uma decisão vence; uma única execução no ledger", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 80 }));
    const results = await Promise.all([decide(s, s.admin, approvalRequestId), decide(s, s.owner, approvalRequestId)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await ledger(s)).toHaveLength(3);
    expect(await balance(s)).toBe(80);
    expect((await auditActions(s)).filter((e) => e.action === "atribuicao.recebimento_corrigido")).toHaveLength(1);
  });

  it("caso 6b: aprovar e rejeitar o mesmo pedido ao mesmo tempo ⇒ uma decisão só", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 80 }));
    const results = await Promise.all([decide(s, s.admin, approvalRequestId, "aprovada"), decide(s, s.owner, approvalRequestId, "rejeitada")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const status = (await db.selectFrom("approvalRequests").select(["status"]).where("id", "=", approvalRequestId).executeTakeFirstOrThrow()).status;
    expect(await ledger(s)).toHaveLength(status === "aprovada" ? 3 : 1);
  });

  it("caso 7: aprovação concorrendo com uma nova correção direta ⇒ nunca executa sobre alvo diferente do solicitado", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 80 }));
    const [dec, direct] = await Promise.all([decide(s, s.admin, approvalRequestId), correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 150 })]);
    const rows = await ledger(s);
    if (dec.status === 200) {
      // a aprovação venceu: a correção direta ficou com a precondição velha
      expect(direct.status).toBe(409);
      expect(await balance(s)).toBe(80);
    } else {
      // a correção direta venceu: o pedido ficou obsoleto
      expect(dec.status).toBe(409);
      expect(direct.status).toBe(200);
      expect(await balance(s)).toBe(150);
    }
    expect(rows).toHaveLength(3);
    // nunca duas cadeias de reversal sobre o mesmo alvo
    expect(rows.filter((r) => r.entryType === "reversal")).toHaveLength(1);
  });

  it("prova determinística do lock da allocation: a correção ESPERA uma transação externa que segura a allocation e só então executa", async () => {
    const s = await setup();
    const v1 = await vigente(s);

    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => (releaseHolder = resolve));
    let holderHasLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => (holderHasLock = resolve));

    const holder = db.transaction().execute(async (trx) => {
      await trx.selectFrom("opportunityAllocations").select(["id"]).where("id", "=", s.allocationId).forNoKeyUpdate().execute();
      holderHasLock();
      await holderReleased;
    });
    await lockAcquired;

    let finished = false;
    const pending = correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 120 }).then((r) => {
      finished = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(finished).toBe(false); // bloqueada no lock da allocation
    expect(await ledger(s)).toHaveLength(1);

    releaseHolder();
    await holder;
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await ledger(s)).toHaveLength(3);
  });

  it("prova determinística: a decisão também espera o lock da allocation (sem executar fora da ordem)", async () => {
    const s = await setup();
    const v1 = await vigente(s);
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(await correct(s, s.operador, { expectedVigenteFulfillmentId: v1, quantity: 80 }));

    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => (releaseHolder = resolve));
    let holderHasLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => (holderHasLock = resolve));
    const holder = db.transaction().execute(async (trx) => {
      await trx.selectFrom("opportunityAllocations").select(["id"]).where("id", "=", s.allocationId).forNoKeyUpdate().execute();
      holderHasLock();
      await holderReleased;
    });
    await lockAcquired;

    let finished = false;
    const pending = decide(s, s.admin, approvalRequestId).then((r) => {
      finished = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(finished).toBe(false);
    expect(await ledger(s)).toHaveLength(1);
    releaseHolder();
    await holder;
    expect((await pending).status).toBe(200);
    expect(await ledger(s)).toHaveLength(3);
  });
});

describe("Fase 78 — invariantes finais", () => {
  it("cadeia física de reentrada: 100→140 (+40), →60 (−80), estorno contábil (0), reativar 100 (+40); total físico = soma dos movimentos vinculados", async () => {
    const s = await setup();
    const before = await stockCount();
    let v = await vigente(s);
    await correct(s, s.operador, { expectedVigenteFulfillmentId: v, quantity: 140 });
    expect((await stockCount()).total).toBe(before.total + 40);
    v = await vigente(s);
    const a = await parseJson<{ approvalRequestId: number }>(await correct(s, s.operador, { expectedVigenteFulfillmentId: v, quantity: 60 }));
    await decide(s, s.admin, a.approvalRequestId);
    expect((await stockCount()).total).toBe(before.total - 40);
    v = await vigente(s);
    const b = await parseJson<{ approvalRequestId: number }>(await reverse(s, s.operador, { expectedVigenteFulfillmentId: v }));
    await decide(s, s.admin, b.approvalRequestId);
    expect((await stockCount()).total).toBe(before.total - 40); // estorno contábil: estoque inalterado
    v = await vigente(s);
    await correct(s, s.operador, { expectedVigenteFulfillmentId: v, quantity: 100 });
    expect((await stockCount()).total).toBe(before.total); // 60 físico → 100
    const data = await historyData(s);
    expect(data.physicalBalance).toBe(100);
    const linked = await db.selectFrom("needFulfillments").select(["entryType", "stockTransactionId"]).where("allocationId", "=", s.allocationId).orderBy("id").execute();
    // só a correction que moveu o físico e o original têm movimento; reversals do par/contábil não
    expect(linked.filter((r) => r.entryType === "reversal").every((r) => r.stockTransactionId === null)).toBe(true);
  });

  it("o ledger segue append-only e as quantidades continuam positivas após uma cadeia longa", async () => {
    const s = await setup();
    let v = await vigente(s);
    await correct(s, s.operador, { expectedVigenteFulfillmentId: v, quantity: 111 });
    v = await vigente(s);
    await correct(s, s.operador, { expectedVigenteFulfillmentId: v, quantity: 222 });
    const rows = await ledger(s);
    expect(rows.every((r) => Number(r.quantity) > 0)).toBe(true);
    await expect(db.updateTable("needFulfillments").set({ unit: "x" }).where("id", "=", rows[0].id).execute()).rejects.toThrow();
    await expect(db.deleteFrom("needFulfillments").where("id", "=", rows[1].id).execute()).rejects.toThrow();
    expect(await balance(s)).toBe(222);
  });
});
