/**
 * Fase 85 — Prestação de Contas (Fatia 3): camada de LEITURA sobre estoque, ledger, necessidades e auditoria.
 * Postgres real. Contrato: docs/PRESTACAO_CONTAS_ESPECIFICACAO.md (P-R1…P-R8).
 */
import { describe, it, expect, vi } from "vitest";
import { db } from "../src/helpers/db";
import { handle as getReport } from "../src/endpoints/impact-report_GET";
import { handle as getHistory } from "../src/endpoints/allocations-receipt-history_GET";
import { handle as postCorrect } from "../src/endpoints/allocations-receipt-correct_POST";
import { handle as postReverse } from "../src/endpoints/allocations-receipt-reverse_POST";
import { handle as postReceive } from "../src/endpoints/allocations-receive_POST";
import { handle as postDecide } from "../src/endpoints/approval-requests-decide_POST";
import { getNeedFulfillmentBalanceBatch } from "../src/helpers/needFulfillment";
import { reportRange, dayStart, nextDayStart, localISODate } from "../src/helpers/reportDates";
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
import type { OutputType as Report } from "../src/endpoints/impact-report_GET.schema";
import type { OutputType as HistoryOutput } from "../src/endpoints/allocations-receipt-history_GET.schema";

interface Env {
  owner: AuthenticatedTestUser;
  operador: AuthenticatedTestUser;
  admin: AuthenticatedTestUser;
  voluntario: AuthenticatedTestUser;
  orgId: number;
  itemId: number;
  needId: number;
  sourceId: number;
  platformId: number;
}

async function setupEnv(opts: { needQuantity?: number } = {}): Promise<Env> {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const operador = await createAuthenticatedUser();
  const admin = await createAuthenticatedUser();
  const voluntario = await createAuthenticatedUser();
  await addMembership(org.id, operador.userId, "operador");
  await addMembership(org.id, admin.userId, "administrador");
  await addMembership(org.id, voluntario.userId, "voluntario");
  const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
  const [need] = await db
    .insertInto("needs")
    .values({ organizationId: org.id, title: "Cestas", quantityNeeded: String(opts.needQuantity ?? 500), unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId, itemId: item.id })
    .returning(["id"])
    .execute();
  const platform = await createAuthenticatedUser();
  const source = await createTestSource(platform.userId);
  return { owner, operador, admin, voluntario, orgId: org.id, itemId: item.id, needId: need.id, sourceId: source.id, platformId: platform.userId };
}

async function newAllocation(e: Env, needId: number | null = e.needId, status: "aceita" | "recebida" = "aceita") {
  const opp = await createTestOpportunityRegistry(e.sourceId, e.platformId, { unit: "kg", status: "reservada" });
  const [al] = await db
    .insertInto("opportunityAllocations")
    .values({ opportunityRegistryId: opp.id, organizationId: e.orgId, quantityAllocated: "100", status, needId })
    .returning(["id"])
    .execute();
  return al.id;
}

async function receive(e: Env, quantity = 100, itemId = e.itemId, needId: number | null = e.needId): Promise<number> {
  const allocationId = await newAllocation(e, needId);
  const res = await postReceive(buildRequest("allocations-receive", { method: "POST", cookie: e.owner.cookie, body: { organizationId: e.orgId, allocationId, itemId, quantityReceived: quantity } }));
  expect(res.status).toBe(200);
  return allocationId;
}

const tok = async (e: Env, allocationId: number) => {
  const res = await getHistory(buildRequest(`allocations-receipt-history?organizationId=${e.orgId}&allocationId=${allocationId}`, { cookie: e.owner.cookie }));
  return (await parseJson<HistoryOutput>(res)).vigenteFulfillmentId as string;
};
const correct = (e: Env, allocationId: number, user: AuthenticatedTestUser, body: Record<string, unknown>) =>
  postCorrect(buildRequest("allocations-receipt-correct", { method: "POST", cookie: user.cookie, body: { organizationId: e.orgId, allocationId, reason: "Conferência na chegada", ...body } }));
const reverse = (e: Env, allocationId: number, user: AuthenticatedTestUser, body: Record<string, unknown>) =>
  postReverse(buildRequest("allocations-receipt-reverse", { method: "POST", cookie: user.cookie, body: { organizationId: e.orgId, allocationId, reason: "Doação duplicada", ...body } }));
const decide = (e: Env, user: AuthenticatedTestUser, requestId: number) =>
  postDecide(buildRequest("approval-requests-decide", { method: "POST", cookie: user.cookie, body: { organizationId: e.orgId, requestId, decision: "aprovada" } }));
async function pending(res: Response) {
  expect(res.status).toBe(202);
  return (await parseJson<{ approvalRequestId: number }>(res)).approvalRequestId;
}

const DAY = 86400000;
const wide = () => ({ start: new Date(Date.now() - 2 * DAY), end: new Date(Date.now() + DAY) });

async function report(e: Env, opts: { start?: Date; end?: Date; itemId?: number; needId?: number; eventType?: string; user?: AuthenticatedTestUser; orgId?: number } = {}) {
  const w = wide();
  const qs = new URLSearchParams({
    organizationId: String(opts.orgId ?? e.orgId),
    startDate: (opts.start ?? w.start).toISOString(),
    endDate: (opts.end ?? w.end).toISOString(),
  });
  if (opts.itemId) qs.set("itemId", String(opts.itemId));
  if (opts.needId) qs.set("needId", String(opts.needId));
  if (opts.eventType) qs.set("eventType", opts.eventType);
  return getReport(buildRequest(`impact-report?${qs.toString()}`, { cookie: (opts.user ?? e.owner).cookie }));
}
async function reportData(e: Env, opts: Parameters<typeof report>[1] = {}) {
  const res = await report(e, opts);
  expect(res.status).toBe(200);
  return parseJson<Report>(res);
}

/** Insere um recebimento da rede HISTÓRICO (data explícita): allocation + entrada física + original. */
async function insertNetworkReceipt(e: Env, at: Date, quantity = 100, needId: number | null = e.needId, itemId = e.itemId) {
  const allocationId = await newAllocation(e, needId, "aceita");
  const [tx] = await db.insertInto("stockTransactions").values({ organizationId: e.orgId, itemId, type: "entrada", delta: String(quantity), createdByUserId: e.owner.userId, createdAt: at }).returning(["id"]).execute();
  const [orig] = await db
    .insertInto("needFulfillments")
    .values({ organizationId: e.orgId, needId, allocationId, stockTransactionId: tx.id, quantity: String(quantity), unit: "kg", entryType: "original", isCountable: true, createdByUserId: e.owner.userId, createdAt: at })
    .returning(["id"])
    .execute();
  await db.updateTable("opportunityAllocations").set({ status: "recebida" }).where("id", "=", allocationId).execute();
  return { allocationId, originalId: orig.id, txId: tx.id };
}
async function insertManualEntry(e: Env, at: Date, quantity = 10, itemId = e.itemId) {
  await db.insertInto("stockTransactions").values({ organizationId: e.orgId, itemId, type: "entrada", delta: String(quantity), reason: "Entrada manual", createdByUserId: e.owner.userId, createdAt: at }).execute();
}
async function insertReversal(e: Env, allocationId: number, targetId: string | number, quantity: number, at: Date, needId: number | null = e.needId) {
  await db
    .insertInto("needFulfillments")
    .values({ organizationId: e.orgId, needId, allocationId, stockTransactionId: null, quantity: String(quantity), unit: "kg", entryType: "reversal", isCountable: true, reversesFulfillmentId: String(targetId), createdByUserId: e.owner.userId, createdAt: at })
    .execute();
}

describe("Fase 85 — relatório vazio, doações e origem (P-R7), sem contagem dupla (P-R2)", () => {
  it("sem dados: todas as seções vazias, sem erro", async () => {
    const e = await setupEnv();
    const r = await reportData(e);
    expect(r.summary).toMatchObject({ needsCreated: 1, needsMarkedAtendida: 0, donations: { total: 0, network: 0, manual: 0 }, corrections: 0, reversals: { total: 0, accountingOnly: 0, withWithdrawal: 0 } });
    expect(r.itemMovements).toEqual([]);
    expect(r.donations).toMatchObject({ rows: [], total: 0, truncated: false });
    expect(r.receipts).toMatchObject({ groups: [], totalEvents: 0, truncated: false });
    expect(r.needs.rows).toEqual([]);
    expect(r.organizationName).toBeTruthy();
    expect(r.period.endDateExclusive).toBeTruthy();
  });

  it("recebimento da rede + entrada manual: 2 doações com origem distinta (rede/manual); ledger não duplica a doação", async () => {
    const e = await setupEnv();
    await receive(e, 100);
    await insertManualEntry(e, new Date(), 10);
    const r = await reportData(e);
    expect(r.summary.donations).toEqual({ total: 2, network: 1, manual: 1 });
    expect(r.donations.rows.map((d) => [d.origin, d.quantity]).sort()).toEqual([["manual", 10], ["rede", 100]]);
    const net = r.donations.rows.find((d) => d.origin === "rede")!;
    expect(net.needTitle).toBe("Cestas");
    expect(net.allocationId).not.toBeNull();
    expect(r.donations.rows.find((d) => d.origin === "manual")!.allocationId).toBeNull();
    // tabela física: 110 de entradas, sem inventar linhas do ledger
    expect(r.itemMovements[0]).toMatchObject({ entradas: 110, saidas: 0, ajustes: 0 });
  });

  it("P-R2: correção POSITIVA (100→120) não é nova doação: contador 1, linha separada de correção com efeito físico +20, líquido 120", async () => {
    const e = await setupEnv();
    const a = await receive(e, 100);
    expect((await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 120, reason: "Chegou mais 20 kg" })).status).toBe(200);
    const r = await reportData(e);
    expect(r.summary.donations).toEqual({ total: 1, network: 1, manual: 0 });
    expect(r.donations.rows).toHaveLength(1);
    expect(r.summary.corrections).toBe(1);
    const g = r.receipts.groups[0];
    expect(g.original).toMatchObject({ quantity: 100, unit: "kg", inPeriod: true });
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ kind: "correcao", subtype: "positiva", quantityFrom: 100, quantityTo: 120, delta: 20, countedEffect: 20, physical: { delta: 20, withdrawal: false }, reason: "Chegou mais 20 kg", inPeriod: true });
    expect(g.events[0].authorName).toBeTruthy();
    expect(g.netCounted).toBe(120);
    expect(r.itemMovements[0]).toMatchObject({ entradas: 100, ajustesRede: 20, ajustesOutros: 0, ajustes: 20, netChange: 120 });
  });

  it("P-R3: correção NEGATIVA (100→80): original 100 continua; correção −20 (par colapsado: efeito líquido −20); líquido 80; físico −20; aprovador identificado", async () => {
    const e = await setupEnv();
    const a = await receive(e, 100);
    const id = await pending(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 80, reason: "Faltaram 20 kg" }));
    await decide(e, e.admin, id);
    const r = await reportData(e);
    expect(r.summary).toMatchObject({ donations: { total: 1 }, corrections: 1, reversals: { total: 0 } });
    const g = r.receipts.groups[0];
    expect(g.original?.quantity).toBe(100);
    expect(g.events).toHaveLength(1); // o par reversal+correction é UM evento
    expect(g.events[0]).toMatchObject({ kind: "correcao", subtype: "negativa", quantityFrom: 100, quantityTo: 80, delta: -20, countedEffect: -20, physical: { delta: -20, withdrawal: false }, reason: "Faltaram 20 kg" });
    expect(g.events[0].approvedByName).toBeTruthy();
    expect(g.events[0].approvedByName).not.toBe(g.events[0].authorName);
    expect(g.netCounted).toBe(80);
    const n = r.needs.rows[0];
    expect(n.atEnd.fulfilled).toBe(80);
    expect(n.components).toEqual({ recebido: 100, correcoes: -20, estornos: 0 });
  });

  it("correção só de unidade (reclassificação) aparece como tal, sem efeito físico", async () => {
    const e = await setupEnv();
    const a = await receive(e, 100);
    const id = await pending(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), unit: "litros" }));
    await decide(e, e.admin, id);
    const g = (await reportData(e)).receipts.groups[0];
    expect(g.events[0]).toMatchObject({ kind: "correcao", subtype: "unidade", unit: "litros", unitFrom: "kg", physical: null });
  });
});

describe("Fase 85 — P-R4: estorno contábil × físico (duas naturezas, nunca somadas)", () => {
  it("estorno CONTÁBIL: evento sem efeito físico; estoque inalterado; contadores separam 'só contábil'", async () => {
    const e = await setupEnv();
    const a = await receive(e, 100);
    const id = await pending(await reverse(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a) }));
    await decide(e, e.admin, id);
    const r = await reportData(e);
    expect(r.summary.reversals).toEqual({ total: 1, accountingOnly: 1, withWithdrawal: 0 });
    expect(r.summary.donations.total).toBe(1); // o estorno não é recebimento
    const ev = r.receipts.groups[0].events[0];
    expect(ev).toMatchObject({ kind: "estorno", quantityFrom: 100, delta: -100, countedEffect: -100, physical: null });
    expect(r.itemMovements[0]).toMatchObject({ entradas: 100, ajustes: 0, currentStock: 100 });
    expect(r.needs.rows[0]).toMatchObject({ atEnd: { fulfilled: 0 }, components: { recebido: 100, correcoes: 0, estornos: -100 } });
  });

  it("estorno FÍSICO: o evento contábil carrega a retirada física ligada (−100); contadores 'com retirada'; estoque 0", async () => {
    const e = await setupEnv();
    const a = await receive(e, 100);
    const id = await pending(await reverse(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), withdrawStock: true }));
    await decide(e, e.admin, id);
    const r = await reportData(e);
    expect(r.summary.reversals).toEqual({ total: 1, accountingOnly: 0, withWithdrawal: 1 });
    expect(r.receipts.groups[0].events[0]).toMatchObject({ kind: "estorno", countedEffect: -100, physical: { delta: -100, withdrawal: true } });
    expect(r.itemMovements[0]).toMatchObject({ entradas: 100, ajustesRede: -100, currentStock: 0, netChange: 0 });
  });

  it("'desfazer estorno' é uma correção (reativação) e o estorno anterior continua como estorno (sem confundir com par)", async () => {
    const e = await setupEnv();
    const a = await receive(e, 100);
    const id = await pending(await reverse(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a) }));
    await decide(e, e.admin, id);
    expect((await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 100, reason: "Estorno foi engano" })).status).toBe(200);
    const r = await reportData(e);
    expect(r.summary).toMatchObject({ corrections: 1, reversals: { total: 1, accountingOnly: 1 } });
    expect(r.receipts.groups[0].events.map((x) => x.kind)).toEqual(["estorno", "reativacao"]);
    expect(r.receipts.groups[0].netCounted).toBe(100);
    expect(r.needs.rows[0].atEnd.fulfilled).toBe(100);
  });
});

describe("Fase 85 — P-R1/P-R5: acumulado + período + hoje; intervalo semiaberto", () => {
  it("identidade: acum(fim) = acum(início) + período, e acum(início do período 2) = acum(fim do período 1) — necessidades e estoque", async () => {
    const e = await setupEnv();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const t1 = new Date("2026-02-01T00:00:00.000Z");
    const t2 = new Date("2026-03-01T00:00:00.000Z");
    const t3 = new Date("2026-04-01T00:00:00.000Z");
    const r1 = await insertNetworkReceipt(e, new Date("2026-01-10T12:00:00Z"), 100);
    // período 2: correção negativa (par) 100→70 e entrada manual
    const at = new Date("2026-02-15T12:00:00Z");
    await insertReversal(e, r1.allocationId, r1.originalId, 100, at);
    await db.insertInto("needFulfillments").values({ organizationId: e.orgId, needId: e.needId, allocationId: r1.allocationId, stockTransactionId: null, quantity: "70", unit: "kg", entryType: "correction", isCountable: true, reversesFulfillmentId: String(r1.originalId), createdAt: at }).execute();
    await insertManualEntry(e, new Date("2026-02-20T12:00:00Z"), 5);
    // período 3: novo recebimento da rede
    await insertNetworkReceipt(e, new Date("2026-03-10T12:00:00Z"), 40);

    const p1 = await reportData(e, { start: t0, end: t1 });
    const p2 = await reportData(e, { start: t1, end: t2 });
    const p3 = await reportData(e, { start: t2, end: t3 });
    const need = (r: Report) => r.needs.rows.find((n) => n.id === e.needId)!;
    expect(need(p1).atEnd.fulfilled).toBe(100);
    expect(need(p2).fulfilledAtStart).toBe(100);
    expect(need(p2).periodNet).toBe(-30);
    expect(need(p2).atEnd.fulfilled).toBe(70);
    expect(need(p3).fulfilledAtStart).toBe(70);
    expect(need(p3).periodNet).toBe(40);
    expect(need(p3).atEnd.fulfilled).toBe(110);
    for (const p of [p1, p2, p3]) expect(need(p).atEnd.fulfilled).toBeCloseTo(need(p).fulfilledAtStart + need(p).periodNet, 6);
    expect(need(p2).fulfilledAtStart).toBe(need(p1).atEnd.fulfilled);
    expect(need(p3).fulfilledAtStart).toBe(need(p2).atEnd.fulfilled);
    // hoje = todo o histórico, independente do período
    expect(need(p1).today.fulfilled).toBe(110);
    // estoque físico (mesma identidade): fim = início + líquido do período
    for (const p of [p1, p2, p3]) for (const m of p.itemMovements) expect(m.balanceAtEnd).toBeCloseTo(m.balanceAtStart + m.netChange, 6);
    expect(p2.itemMovements[0]).toMatchObject({ balanceAtStart: 100, entradas: 5, balanceAtEnd: 105, currentStock: 145 });
    // composição = fórmula única
    for (const p of [p1, p2, p3]) expect(need(p).components.recebido + need(p).components.correcoes + need(p).components.estornos).toBeCloseTo(need(p).atEnd.fulfilled, 6);
  });

  it("intervalo semiaberto: evento às 23:59:59,500 do último dia ENTRA; exatamente no início do dia seguinte fica FORA", async () => {
    const e = await setupEnv();
    await insertManualEntry(e, new Date("2026-03-10T23:59:59.500Z"), 7);
    await insertManualEntry(e, new Date("2026-03-11T00:00:00.000Z"), 11);
    const start = new Date("2026-03-10T00:00:00.000Z");
    const endExclusive = new Date("2026-03-11T00:00:00.000Z");
    const r = await reportData(e, { start, end: endExclusive });
    expect(r.donations.rows.map((d) => d.quantity)).toEqual([7]);
    expect(r.summary.donations.total).toBe(1);
    expect(r.itemMovements[0].entradas).toBe(7);
    // com o limite inclusivo antigo (T23:59:59) o evento de .500 ficaria de fora; aqui entra
    const old = await reportData(e, { start, end: new Date("2026-03-10T23:59:59.000Z") });
    expect(old.donations.rows).toHaveLength(0);
  });

  it("período sem movimentação: o item COM saldo anterior aparece só com o saldo (movimentação do período zerada); doações e cartões continuam só do período", async () => {
    const e = await setupEnv();
    await insertManualEntry(e, new Date("2026-01-05T12:00:00Z"), 30);
    await insertManualEntry(e, new Date("2026-02-05T12:00:00Z"), 20);
    const empty = await reportData(e, { start: new Date("2026-05-01T00:00:00Z"), end: new Date("2026-05-31T00:00:00Z") });
    expect(empty.itemMovements).toHaveLength(1);
    expect(empty.itemMovements[0]).toMatchObject({ itemId: e.itemId, entradas: 0, saidas: 0, ajustes: 0, ajustesRede: 0, ajustesOutros: 0, netChange: 0, balanceAtStart: 50, balanceAtEnd: 50, currentStock: 50 });
    expect(empty.summary.donations.total).toBe(0); // o saldo anterior NÃO é doação do período
    expect(empty.donations.rows).toHaveLength(0);
    const feb = await reportData(e, { start: new Date("2026-02-01T00:00:00Z"), end: new Date("2026-03-01T00:00:00Z") });
    expect(feb.itemMovements[0]).toMatchObject({ entradas: 20, balanceAtStart: 30, balanceAtEnd: 50 });
  });
});

describe("Fase 94 — inclusão na tabela 'Movimentação por item': movimentação no período OU saldo final ≠ 0", () => {
  const exit = (e: Env, itemId: number, at: Date, quantity: number) =>
    db.insertInto("stockTransactions").values({ organizationId: e.orgId, itemId, type: "saida", delta: String(-quantity), reason: "Saída", createdByUserId: e.owner.userId, createdAt: at }).execute();
  const ledgerAndStockCounts = async (orgId: number) => ({
    st: Number((await db.selectFrom("stockTransactions").select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", orgId).executeTakeFirstOrThrow()).n),
    nf: Number((await db.selectFrom("needFulfillments").select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", orgId).executeTakeFirstOrThrow()).n),
  });

  async function scenario() {
    const e = await setupEnv();
    const withMovement = e.itemId; // A: entrada DENTRO do período
    const onlyBalance = (await createTestInventoryItem(e.orgId, e.owner.userId, { unit: "kg" })).id; // B: saldo anterior, nenhuma movimentação no período
    const zeroBalance = (await createTestInventoryItem(e.orgId, e.owner.userId, { unit: "kg" })).id; // C: entrou e saiu ANTES do período (saldo 0), sem movimentação no período
    const futureOnly = (await createTestInventoryItem(e.orgId, e.owner.userId, { unit: "kg" })).id; // D: só tem movimento DEPOIS do fim do período
    await insertManualEntry(e, new Date("2026-03-10T12:00:00Z"), 40, withMovement);
    await insertManualEntry(e, new Date("2026-01-10T12:00:00Z"), 25, onlyBalance);
    await insertManualEntry(e, new Date("2026-01-11T12:00:00Z"), 15, zeroBalance);
    await exit(e, zeroBalance, new Date("2026-01-12T12:00:00Z"), 15);
    await insertManualEntry(e, new Date("2026-04-20T12:00:00Z"), 99, futureOnly);
    return { e, withMovement, onlyBalance, zeroBalance, futureOnly };
  }
  const period = { start: new Date("2026-03-01T00:00:00Z"), end: new Date("2026-04-01T00:00:00Z") };

  it("A com movimentação e B só com saldo aparecem; C (saldo final zero, sem movimentação) e D (só movimento futuro) ficam fora", async () => {
    const { e, withMovement, onlyBalance, zeroBalance, futureOnly } = await scenario();
    const r = await reportData(e, period);
    const ids = r.itemMovements.map((m) => m.itemId);
    expect(ids).toContain(withMovement);
    expect(ids).toContain(onlyBalance);
    expect(ids).not.toContain(zeroBalance);
    expect(ids).not.toContain(futureOnly);
    const A = r.itemMovements.find((m) => m.itemId === withMovement)!;
    const B = r.itemMovements.find((m) => m.itemId === onlyBalance)!;
    expect(A).toMatchObject({ entradas: 40, saidas: 0, ajustes: 0, netChange: 40, balanceAtStart: 0, balanceAtEnd: 40 });
    expect(B).toMatchObject({ entradas: 0, saidas: 0, ajustes: 0, ajustesRede: 0, ajustesOutros: 0, netChange: 0, balanceAtStart: 25, balanceAtEnd: 25, currentStock: 25 });
    expect(r.itemMovements.map((m) => m.itemName)).toEqual([...r.itemMovements.map((m) => m.itemName)].sort((x, y) => x.localeCompare(y)));
  });

  it("incluir linhas só-de-saldo NÃO infla nada: cartões, doações e Σ da movimentação do período são os mesmos de antes; reconcilia com o estoque real e o ledger", async () => {
    const { e, withMovement, onlyBalance } = await scenario();
    const before = await ledgerAndStockCounts(e.orgId);
    const r = await reportData(e, period);
    expect(await ledgerAndStockCounts(e.orgId)).toEqual(before); // nenhum movimento artificial, ledger intocado
    expect(r.summary.donations.total).toBe(1); // só a entrada de 40 dentro do período
    expect(r.donations.rows.map((d) => d.quantity)).toEqual([40]);
    expect(r.itemMovements.reduce((acc, m) => acc + m.entradas, 0)).toBe(40);
    expect(r.itemMovements.reduce((acc, m) => acc + m.netChange, 0)).toBe(40);
    for (const m of r.itemMovements) {
      const sums = await db.selectFrom("stockTransactions").select((eb) => [eb.fn.sum("delta").as("total")]).where("organizationId", "=", e.orgId).where("itemId", "=", m.itemId).executeTakeFirstOrThrow();
      expect(m.currentStock, `item ${m.itemId}: saldo × Σ stock_transactions`).toBe(Number(sums.total ?? 0));
      expect(m.balanceAtStart + m.netChange, `item ${m.itemId}: inicial + movimentação = final`).toBe(m.balanceAtEnd);
    }
    // o saldo de B é o real acumulado até o fim do período, mesmo sem nenhuma movimentação nele
    const sumB = await db.selectFrom("stockTransactions").select((eb) => [eb.fn.sum("delta").as("total")]).where("itemId", "=", onlyBalance).where("createdAt", "<", period.end).executeTakeFirstOrThrow();
    expect(r.itemMovements.find((m) => m.itemId === onlyBalance)!.balanceAtEnd).toBe(Number(sumB.total));
    expect(withMovement).toBeGreaterThan(0);
  });

  it("filtro por item continua valendo: o item só com saldo aparece quando filtrado, e outros itens não aparecem", async () => {
    const { e, onlyBalance, zeroBalance } = await scenario();
    const onlyB = await reportData(e, { ...period, itemId: onlyBalance });
    expect(onlyB.itemMovements.map((m) => m.itemId)).toEqual([onlyBalance]);
    const zero = await reportData(e, { ...period, itemId: zeroBalance });
    expect(zero.itemMovements).toEqual([]);
  });

  it("item cujo saldo vira zero DENTRO do período aparece (tem movimentação) e o saldo anterior não entra como movimentação", async () => {
    const e = await setupEnv();
    await insertManualEntry(e, new Date("2026-01-10T12:00:00Z"), 30);
    await exit(e, e.itemId, new Date("2026-03-15T12:00:00Z"), 30);
    const r = await reportData(e, period);
    expect(r.itemMovements).toHaveLength(1);
    expect(r.itemMovements[0]).toMatchObject({ entradas: 0, saidas: 30, netChange: -30, balanceAtStart: 30, balanceAtEnd: 0, currentStock: 0 });
  });
});

describe("Fase 85 — P-R6: necessidades com atividade no período OU saldo relevante no fim; status administrativo à parte", () => {
  it("inclui por atividade e por saldo; exclui sem atividade/saldo e atividade só depois do fim", async () => {
    const e = await setupEnv();
    const mk = async (title: string) => (await db.insertInto("needs").values({ organizationId: e.orgId, title, quantityNeeded: "100", unit: "kg", priority: "media", status: "aberta", createdByUserId: e.owner.userId, itemId: e.itemId }).returning(["id"]).execute())[0].id;
    const needA = await mk("A atividade no período");
    const needB = await mk("B saldo antigo");
    const needC = await mk("C sem nada");
    const needD = await mk("D só depois");
    await insertNetworkReceipt(e, new Date("2026-02-10T00:00:00Z"), 10, needA);
    await insertNetworkReceipt(e, new Date("2026-01-10T00:00:00Z"), 10, needB);
    await insertNetworkReceipt(e, new Date("2026-04-10T00:00:00Z"), 10, needD);
    const r = await reportData(e, { start: new Date("2026-02-01T00:00:00Z"), end: new Date("2026-03-01T00:00:00Z") });
    const byTitle = new Map(r.needs.rows.map((n) => [n.title, n]));
    expect([...byTitle.keys()].sort()).toEqual(["A atividade no período", "B saldo antigo"]);
    expect(byTitle.get("A atividade no período")!.hasActivityInPeriod).toBe(true);
    expect(byTitle.get("B saldo antigo")!.hasActivityInPeriod).toBe(false);
    expect(byTitle.get("B saldo antigo")!.atEnd.fulfilled).toBe(10);
    expect(needC).toBeGreaterThan(0);
    // as necessidades foram criadas HOJE (fora da janela de fevereiro): o cartão 'cadastradas' segue a data de criação
    expect(r.summary.needsCreated).toBe(0);
    expect((await reportData(e)).summary.needsCreated).toBe(5);
  });

  it("parcial, atendida (necessário = recebido) e excedente: faltante/excedente pela fórmula única; status não é inferido", async () => {
    const e = await setupEnv({ needQuantity: 100 });
    const partial = await receive(e, 60);
    const r1 = await reportData(e);
    expect(r1.needs.rows[0]).toMatchObject({ needed: 100, status: "aberta", statusWarning: false });
    expect(r1.needs.rows[0].atEnd).toEqual({ fulfilled: 60, requiredRemaining: 40, surplus: 0 });
    // completa e passa (excedente) — status continua 'aberta' (não é inferido)
    await receive(e, 70);
    const r2 = await reportData(e);
    expect(r2.needs.rows[0].atEnd).toEqual({ fulfilled: 130, requiredRemaining: 0, surplus: 30 });
    expect(r2.needs.rows[0].status).toBe("aberta");
    expect(partial).toBeGreaterThan(0);
  });

  it("necessidade marcada 'atendida' que voltou a faltar: aviso factual; needs.status NÃO é alterado", async () => {
    const e = await setupEnv({ needQuantity: 100 });
    const a = await receive(e, 100);
    await db.updateTable("needs").set({ status: "atendida" }).where("id", "=", e.needId).execute();
    const before = await reportData(e);
    expect(before.needs.rows[0].statusWarning).toBe(false);
    expect(before.summary.needsMarkedAtendida).toBe(1);
    const id = await pending(await reverse(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a) }));
    await decide(e, e.admin, id);
    const after = await reportData(e);
    expect(after.needs.rows[0]).toMatchObject({ status: "atendida", statusWarning: true, today: { requiredRemaining: 100 } });
    const st = await db.selectFrom("needs").select(["status"]).where("id", "=", e.needId).executeTakeFirstOrThrow();
    expect(st.status).toBe("atendida");
  });
});

describe("Fase 85 — P-R8: filtros por item, necessidade e tipo de evento", () => {
  async function two() {
    const e = await setupEnv();
    const item2 = await createTestInventoryItem(e.orgId, e.owner.userId, { name: "Feijão", unit: "kg" });
    const [need2] = await db.insertInto("needs").values({ organizationId: e.orgId, title: "Feijão", quantityNeeded: "100", unit: "kg", priority: "media", status: "aberta", createdByUserId: e.owner.userId, itemId: item2.id }).returning(["id"]).execute();
    const a1 = await receive(e, 100);
    const a2 = await receive(e, 50, item2.id, need2.id);
    await insertManualEntry(e, new Date(), 10, e.itemId);
    await insertManualEntry(e, new Date(), 5, item2.id);
    expect((await correct(e, a1, e.operador, { expectedVigenteFulfillmentId: await tok(e, a1), quantity: 120 })).status).toBe(200);
    const rid = await pending(await reverse(e, a2, e.operador, { expectedVigenteFulfillmentId: await tok(e, a2) }));
    await decide(e, e.admin, rid);
    return { e, item2: item2.id, need2: need2.id, a1, a2 };
  }

  it("item: tabela física, doações, eventos e necessidades só do item; contadores do item", async () => {
    const { e, item2, need2 } = await two();
    const r = await reportData(e, { itemId: item2 });
    expect(r.itemMovements.map((m) => m.itemId)).toEqual([item2]);
    expect(r.donations.rows.every((d) => d.itemId === item2)).toBe(true);
    expect(r.summary.donations).toEqual({ total: 2, network: 1, manual: 1 });
    expect(r.summary).toMatchObject({ corrections: 0, reversals: { total: 1 } });
    expect(r.needs.rows.map((n) => n.id)).toEqual([need2]);
    expect(r.receipts.groups.map((g) => g.item?.id)).toEqual([item2]);
  });

  it("necessidade: doações da rede dessa necessidade (entrada manual não pertence a nenhuma), eventos e a própria necessidade", async () => {
    const { e, need2 } = await two();
    const r = await reportData(e, { needId: need2 });
    expect(r.summary.donations).toEqual({ total: 1, network: 1, manual: 0 });
    expect(r.donations.rows).toHaveLength(1);
    expect(r.needs.rows.map((n) => n.id)).toEqual([need2]);
    expect(r.receipts.groups.every((g) => g.needId === need2)).toBe(true);
  });

  it("tipo de evento: recebimento / entrada_manual / correcao / estorno afetam as LISTAS (cartões seguem completos e rotulados)", async () => {
    const { e } = await two();
    const rec = await reportData(e, { eventType: "recebimento" });
    expect(rec.donations.rows.every((d) => d.origin === "rede")).toBe(true);
    expect(rec.receipts.groups).toEqual([]);
    expect(rec.donations.total).toBe(2);
    const man = await reportData(e, { eventType: "entrada_manual" });
    expect(man.donations.rows.every((d) => d.origin === "manual")).toBe(true);
    expect(man.donations.total).toBe(2);
    const cor = await reportData(e, { eventType: "correcao" });
    expect(cor.donations.rows).toEqual([]);
    expect(cor.receipts.groups.flatMap((g) => g.events.map((x) => x.kind))).toEqual(["correcao"]);
    const est = await reportData(e, { eventType: "estorno" });
    expect(est.receipts.groups.flatMap((g) => g.events.map((x) => x.kind))).toEqual(["estorno"]);
    // cartões do período não dependem do tipo
    expect(cor.summary.corrections).toBe(1);
    expect(cor.summary.reversals.total).toBe(1);
  });

  it("combinação item + necessidade + tipo; ids de outra organização não vazam nada", async () => {
    const { e, item2, need2 } = await two();
    const combo = await reportData(e, { itemId: item2, needId: need2, eventType: "estorno" });
    expect(combo.receipts.groups).toHaveLength(1);
    expect(combo.donations.rows).toEqual([]);
    const other = await setupEnv();
    await receive(other, 77);
    const cross = await reportData(e, { itemId: other.itemId, needId: other.needId });
    expect(cross.itemMovements).toEqual([]);
    expect(cross.donations.rows).toEqual([]);
    expect(cross.needs.rows).toEqual([]);
    expect(cross.receipts.groups).toEqual([]);
  });
});

describe("Fase 85 — limite de 1.000 só na LISTA; totais e saldos vêm de agregações completas", () => {
  async function manualEntries(e: Env, n: number) {
    const base = Date.now() - 3600000;
    const rows = Array.from({ length: n }, (_, i) => ({ organizationId: e.orgId, itemId: e.itemId, type: "entrada" as const, delta: "1", reason: "lote", createdByUserId: e.owner.userId, createdAt: new Date(base + i) }));
    for (let i = 0; i < rows.length; i += 500) await db.insertInto("stockTransactions").values(rows.slice(i, i + 500)).execute();
  }

  it("999, 1000 (exato) e 1001 entradas: truncamento só a partir de 1001; entradas/total/saldo contam TODAS; ordem determinística", async () => {
    for (const [n, truncated] of [[999, false], [1000, false], [1001, true]] as const) {
      const e = await setupEnv();
      await manualEntries(e, n);
      const r = await reportData(e);
      expect(r.donations.rows).toHaveLength(Math.min(n, 1000));
      expect(r.donations.truncated).toBe(truncated);
      expect(r.donations.total).toBe(n);
      expect(r.summary.donations.total).toBe(n);
      expect(r.itemMovements[0]).toMatchObject({ entradas: n, balanceAtEnd: n, currentStock: n });
      // mais recentes primeiro (created_at decrescente)
      const times = r.donations.rows.map((d) => d.createdAt);
      expect([...times].sort().reverse()).toEqual(times);
    }
  }, 120000);

  it("1001 estornos contábeis: lista de eventos limitada a 1000 com aviso, contadores e saldo das necessidades completos", async () => {
    const e = await setupEnv({ needQuantity: 10 });
    const at = new Date(Date.now() - 3600000);
    const [reg] = await db.insertInto("opportunityRegistry").values({ sourceId: e.sourceId, title: "Muitas", quantity: 1, unit: "kg", discoveryAgent: "manual", status: "reservada" }).returning(["id"]).execute();
    const N = 1001;
    const allocs = await db.insertInto("opportunityAllocations").values(Array.from({ length: N }, () => ({ opportunityRegistryId: reg.id, organizationId: e.orgId, quantityAllocated: "1", status: "recebida" as const, needId: e.needId }))).returning(["id"]).execute();
    const txs = await db.insertInto("stockTransactions").values(allocs.map((_, i) => ({ organizationId: e.orgId, itemId: e.itemId, type: "entrada" as const, delta: "1", createdByUserId: e.owner.userId, createdAt: new Date(at.getTime() + i) }))).returning(["id"]).execute();
    const origs = await db.insertInto("needFulfillments").values(allocs.map((a, i) => ({ organizationId: e.orgId, needId: e.needId, allocationId: a.id, stockTransactionId: txs[i].id, quantity: "1", unit: "kg", entryType: "original" as const, isCountable: true, createdAt: new Date(at.getTime() + i) }))).returning(["id", "allocationId"]).execute();
    await db.insertInto("needFulfillments").values(origs.map((o, i) => ({ organizationId: e.orgId, needId: e.needId, allocationId: o.allocationId, quantity: "1", unit: "kg", entryType: "reversal" as const, isCountable: true, reversesFulfillmentId: o.id, createdAt: new Date(at.getTime() + 5000 + i) }))).execute();
    const r = await reportData(e);
    expect(r.receipts.totalEvents).toBe(N);
    expect(r.receipts.truncated).toBe(true);
    expect(r.receipts.groups).toHaveLength(1000);
    expect(r.summary.reversals).toEqual({ total: N, accountingOnly: N, withWithdrawal: 0 });
    // totais NÃO calculados sobre a lista truncada: 1001 recebidos − 1001 estornados = 0, e 1001 entradas físicas
    expect(r.needs.rows[0]).toMatchObject({ atEnd: { fulfilled: 0 }, components: { recebido: N, estornos: -N } });
    expect(r.itemMovements[0].entradas).toBe(N);
    expect(r.summary.donations.total).toBe(N);
  }, 180000);
});

describe("Fase 85 — segurança: permissão relatorios.leia e isolamento entre organizações", () => {
  it("só proprietário e administrador (relatorios.leia); operador, voluntário, não-membro e membro inativo ⇒ 403", async () => {
    const e = await setupEnv();
    expect((await report(e, { user: e.owner })).status).toBe(200);
    expect((await report(e, { user: e.admin })).status).toBe(200);
    expect((await report(e, { user: e.operador })).status).toBe(403);
    expect((await report(e, { user: e.voluntario })).status).toBe(403);
    expect((await report(e, { user: await createAuthenticatedUser() })).status).toBe(403);
    const inactive = await createAuthenticatedUser();
    await addMembership(e.orgId, inactive.userId, "administrador", "inativo");
    expect((await report(e, { user: inactive })).status).toBe(403);
    // quem vê o histórico do recebimento (logistica.leia) NÃO vê a prestação de contas só por isso
    const a = await receive(e);
    const hist = await getHistory(buildRequest(`allocations-receipt-history?organizationId=${e.orgId}&allocationId=${a}`, { cookie: e.operador.cookie }));
    expect(hist.status).toBe(200);
    expect((await report(e, { user: e.operador })).status).toBe(403);
  });

  it("organização A nunca vê dados de B (estoque, ledger, necessidades, motivo, auditoria); pedir B com a sessão de A ⇒ 403", async () => {
    const a = await setupEnv();
    const b = await setupEnv();
    const alA = await receive(a, 100);
    const alB = await receive(b, 999);
    await correct(b, alB, b.operador, { expectedVigenteFulfillmentId: await tok(b, alB), quantity: 1100, reason: "SEGREDO-DA-ORG-B" });
    await insertManualEntry(b, new Date(), 555);
    expect((await correct(a, alA, a.operador, { expectedVigenteFulfillmentId: await tok(a, alA), quantity: 110, reason: "motivo da org A" })).status).toBe(200);
    const rA = await report(a);
    const text = await rA.text();
    expect(text).not.toContain("SEGREDO-DA-ORG-B");
    // Quantidades da org B (999 e 555) NÃO podem aparecer como NÚMEROS no relatório de A. A checagem é estrutural: procurar a
    // substring "999"/"555" no JSON inteiro falhava ao acaso quando um timestamp (ms) ou o horário de geração continha esses dígitos.
    expect(text).not.toMatch(/"(quantity|entradas|saidas|ajustes|netChange|balanceAtStart|balanceAtEnd|currentStock|fulfilled|periodNet|quantityTo|quantityFrom|delta|netCounted|recebido|correcoes)":-?(999|555|1100)(.0+)?[,}]/);
    const dataA = superjsonParse<Report>(text);
    const numbers = JSON.stringify(dataA, (_k, v) => (typeof v === "number" ? v : v instanceof Date || typeof v === "string" ? undefined : v)).match(/-?d+(.d+)?/g)?.map(Number) ?? [];
    expect(numbers.filter((n) => [999, 555, 1100].includes(Math.abs(n)))).toEqual([]);
    expect(dataA.itemMovements.map((m) => m.itemId)).toEqual([a.itemId]);
    expect(dataA.needs.rows.map((n) => n.id)).toEqual([a.needId]);
    expect(dataA.summary.auditEventCount).toBeGreaterThan(0);
    // sessão de A pedindo a organização B
    expect((await report(b, { user: a.owner })).status).toBe(403);
    // contagem de auditoria é por organização: exatamente os eventos de A no banco (B tem os seus, à parte)
    const w = wide();
    const rowsA = await db.selectFrom("auditLog").select(["id"]).where("organizationId", "=", a.orgId).where("createdAt", ">=", w.start).where("createdAt", "<", w.end).execute();
    const rowsAll = await db.selectFrom("auditLog").select(["id"]).where("createdAt", ">=", w.start).where("createdAt", "<", w.end).execute();
    expect(dataA.summary.auditEventCount).toBe(rowsA.length);
    expect(rowsAll.length).toBeGreaterThan(rowsA.length);
  });

  it("não expõe auditoria crua nem dado pessoal: sem e-mail, sem metadata, sem tokens; só motivo, autor (nome) e aprovador (nome)", async () => {
    const e = await setupEnv();
    const a = await receive(e, 100);
    const id = await pending(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await tok(e, a), quantity: 80, reason: "Contagem refeita" }));
    await decide(e, e.admin, id);
    const text = await (await report(e)).text();
    for (const u of [e.owner, e.operador, e.admin]) expect(text.toLowerCase()).not.toContain(u.email.toLowerCase());
    expect(text).not.toMatch(/metadata|eventHash|previousEventHash|password|passwordHash|token|jwt|cookie/i);
    expect(text).toContain("Contagem refeita");
  });
});

function superjsonParse<T>(text: string): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (JSON.parse(text) as { json: T }).json;
}

describe("Fase 85 — desempenho: sem N+1 (número de consultas constante)", () => {
  /** Conta as consultas executadas (Kysely: db e transações) durante `fn`. */
  async function countQueries(fn: () => Promise<unknown>) {
    const proto = Object.getPrototypeOf(db.getExecutor()) as { executeQuery: (...args: unknown[]) => Promise<unknown> };
    const spy = vi.spyOn(proto, "executeQuery");
    // A limpeza oportunista de sessões (getServerUserSession) roda com probabilidade fixa e acrescenta 1 DELETE ao acaso — numa
    // medição e não na outra, isso fazia o teste falhar de vez em quando. Desliga-se o sorteio SÓ durante a contagem.
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999999);
    try {
      await fn();
      return spy.mock.calls.length;
    } finally {
      random.mockRestore();
      spy.mockRestore();
    }
  }

  it("1 necessidade/evento × 100 necessidades e 100 eventos: o MESMO número de consultas, e os filtros não acrescentam consultas por linha", async () => {
    const small = await setupEnv();
    const sr = await insertNetworkReceipt(small, new Date(Date.now() - 3600000), 10);
    await insertReversal(small, sr.allocationId, sr.originalId, 10, new Date(Date.now() - 3000000));
    const big = await setupEnv();
    const at = new Date(Date.now() - 3600000);
    for (let i = 0; i < 100; i++) {
      const [n] = await db.insertInto("needs").values({ organizationId: big.orgId, title: `N${i}`, quantityNeeded: "10", unit: "kg", priority: "media", status: "aberta", createdByUserId: big.owner.userId, itemId: big.itemId }).returning(["id"]).execute();
      const r = await insertNetworkReceipt(big, new Date(at.getTime() + i), 5, n.id);
      await insertReversal(big, r.allocationId, r.originalId, 5, new Date(at.getTime() + 1000 + i), n.id);
    }
    await report(small); // aquece a sessão (as consultas de autenticação não dependem do tamanho dos dados)
    await report(big);
    const qSmall = await countQueries(() => report(small));
    const qBig = await countQueries(() => report(big));
    expect(qBig).toBe(qSmall);
    const qFiltered = await countQueries(() => report(big, { itemId: big.itemId, eventType: "estorno" }));
    expect(qFiltered).toBeLessThanOrEqual(qSmall);
    expect(qBig).toBeLessThanOrEqual(24);
    const r = await reportData(big);
    expect(r.needs.rows).toHaveLength(100);
    expect(r.receipts.groups).toHaveLength(100);
  }, 120000);
});

describe("Fase 85 — helper de saldo: janelas opcionais são retrocompatíveis e a fórmula é única", () => {
  it("sem janela = todo o histórico (como antes); before/from/to semiabertos; identidade entre janelas", async () => {
    const e = await setupEnv();
    const r = await insertNetworkReceipt(e, new Date("2026-01-10T00:00:00Z"), 100);
    await insertReversal(e, r.allocationId, r.originalId, 100, new Date("2026-02-10T00:00:00Z"));
    const all = await getNeedFulfillmentBalanceBatch(db, [e.needId]);
    expect(all.get(e.needId)).toBe(0);
    expect((await getNeedFulfillmentBalanceBatch(db, [e.needId], { before: new Date("2026-02-01T00:00:00Z") })).get(e.needId)).toBe(100);
    expect((await getNeedFulfillmentBalanceBatch(db, [e.needId], { before: new Date("2026-01-10T00:00:00Z") })).get(e.needId) ?? 0).toBe(0); // exclusivo
    expect((await getNeedFulfillmentBalanceBatch(db, [e.needId], { from: new Date("2026-02-01T00:00:00Z"), to: new Date("2026-03-01T00:00:00Z") })).get(e.needId)).toBe(-100);
    expect((await getNeedFulfillmentBalanceBatch(db, [])).size).toBe(0);
  });
});

describe("Fase 86 — contrato do filtro de datas: [startDate, endDate) com limite superior EXCLUSIVO, igual na tela, no endpoint e no helper", () => {
  it("a tela monta [início do dia De, início do dia seguinte a Até): filtro de 03/10 = >= 2026-10-03T00:00:00 e < 2026-10-04T00:00:00 (fuso local)", () => {
    const { startDate, endDate } = reportRange("2026-10-03", "2026-10-03");
    expect(startDate.getTime()).toBe(new Date(2026, 9, 3, 0, 0, 0, 0).getTime());
    expect(endDate.getTime()).toBe(new Date(2026, 9, 4, 0, 0, 0, 0).getTime());
    // virada de mês e de ano pelo calendário (não por +24h)
    expect(nextDayStart("2026-01-31").getTime()).toBe(new Date(2026, 1, 1).getTime());
    expect(nextDayStart("2026-12-31").getTime()).toBe(new Date(2027, 0, 1).getTime());
    expect(localISODate(new Date(2026, 9, 3, 23, 59, 59))).toBe("2026-10-03");
    expect(dayStart("2026-10-03").getHours()).toBe(0);
  });

  it("endpoint: 23:59:59.000, 23:59:59.500 e 23:59:59.999 do último dia ENTRAM; 00:00:00.000 do dia seguinte NÃO entra; 00:00:00.000 do primeiro dia entra", async () => {
    const e = await setupEnv();
    const at = (d: string, hms: string) => new Date(d + "T" + hms); // sem Z: fuso local, como a tela
    await insertManualEntry(e, at("2026-03-10", "00:00:00.000"), 1);
    await insertManualEntry(e, at("2026-03-10", "23:59:59.000"), 2);
    await insertManualEntry(e, at("2026-03-10", "23:59:59.500"), 4);
    await insertManualEntry(e, at("2026-03-10", "23:59:59.999"), 8);
    await insertManualEntry(e, at("2026-03-11", "00:00:00.000"), 16);
    await insertManualEntry(e, at("2026-03-09", "23:59:59.999"), 32);
    const { startDate, endDate } = reportRange("2026-03-10", "2026-03-10");
    const r = await reportData(e, { start: startDate, end: endDate });
    expect(r.donations.rows.map((d) => d.quantity).sort((a, b) => a - b)).toEqual([1, 2, 4, 8]);
    expect(r.summary.donations.total).toBe(4);
    expect(r.itemMovements[0]).toMatchObject({ entradas: 15, balanceAtStart: 32, balanceAtEnd: 47 });
    // dia seguinte: pega exatamente o evento de 00:00:00.000 (fronteira exclusiva do dia anterior = inclusiva deste)
    const next = reportRange("2026-03-11", "2026-03-11");
    const r2 = await reportData(e, { start: next.startDate, end: next.endDate });
    expect(r2.donations.rows.map((d) => d.quantity)).toEqual([16]);
    expect(r.period.endDateExclusive).toBe(endDate.toISOString());
  });
});
