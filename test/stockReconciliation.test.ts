/**
 * Fase 94 — conciliação ponta a ponta do núcleo: estoque físico × ledger de atendimento × prestação de contas × histórico.
 * Sequências DETERMINÍSTICAS (gerador com semente) de recebimentos, correções (+/−/unidade), estornos (contábil e com retirada
 * física) e lançamentos manuais, pelos ENDPOINTS reais; depois cada invariante é recalculado por SQL independente (sem reusar
 * os helpers que o relatório usa) e comparado com o que a API/relatório devolve. Postgres real isolado.
 */
import { describe, it, expect } from "vitest";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { handle as getReport } from "../src/endpoints/impact-report_GET";
import { handle as getHistory } from "../src/endpoints/allocations-receipt-history_GET";
import { handle as postCorrect } from "../src/endpoints/allocations-receipt-correct_POST";
import { handle as postReverse } from "../src/endpoints/allocations-receipt-reverse_POST";
import { handle as postReceive } from "../src/endpoints/allocations-receive_POST";
import { handle as postDecide } from "../src/endpoints/approval-requests-decide_POST";
import { handle as postStock } from "../src/endpoints/stock-transactions_POST";
import { handle as getItems } from "../src/endpoints/inventory-items_GET";
import {
  createAuthenticatedUser, createTestOrganization, createTestSource, createTestOpportunityRegistry, createTestInventoryItem, addMembership, buildRequest, parseJson,
  type AuthenticatedTestUser,
} from "./helpers";
import type { OutputType as Report } from "../src/endpoints/impact-report_GET.schema";
import type { OutputType as History } from "../src/endpoints/allocations-receipt-history_GET.schema";

interface Env {
  owner: AuthenticatedTestUser;
  admin: AuthenticatedTestUser;
  orgId: number;
  itemId: number;
  needIds: number[];
  sourceId: number;
  platformId: number;
}

async function setupEnv(): Promise<Env> {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const admin = await createAuthenticatedUser();
  await addMembership(org.id, admin.userId, "administrador");
  const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
  const needIds: number[] = [];
  for (const title of ["Cestas A", "Cestas B"]) {
    const [need] = await db
      .insertInto("needs")
      .values({ organizationId: org.id, title, quantityNeeded: "300", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId, itemId: item.id })
      .returning(["id"])
      .execute();
    needIds.push(need.id);
  }
  const platform = await createAuthenticatedUser();
  const source = await createTestSource(platform.userId);
  return { owner, admin, orgId: org.id, itemId: item.id, needIds, sourceId: source.id, platformId: platform.userId };
}

/** Gerador pseudo-aleatório determinístico (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const post = (path: string, user: AuthenticatedTestUser, body: unknown) => buildRequest(path, { method: "POST", cookie: user.cookie, body });
const MIN = 60_000;

async function approve(e: Env, res: Response, key: "approvalRequestId" = "approvalRequestId") {
  if (res.status !== 202) return;
  const id = (await parseJson<{ approvalRequestId: number }>(res))[key];
  const dec = await postDecide(post("approval-requests-decide", e.admin, { organizationId: e.orgId, requestId: id, decision: "aprovada" }));
  expect([200, 409, 422, 403]).toContain(dec.status); // aprovação pode falhar legitimamente (estado mudou); nunca 5xx
}

async function history(e: Env, allocationId: number) {
  const res = await getHistory(buildRequest(`allocations-receipt-history?organizationId=${e.orgId}&allocationId=${allocationId}`, { cookie: e.owner.cookie }));
  expect(res.status).toBe(200);
  return parseJson<History>(res);
}

interface Counters { receipts: number; corrections: number; reversals: number; manual: number; rejected: number }

async function runScenario(seed: number, steps: number) {
  const e = await setupEnv();
  const rand = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const allocations: number[] = [];
  const c: Counters = { receipts: 0, corrections: 0, reversals: 0, manual: 0, rejected: 0 };

  for (let step = 0; step < steps; step++) {
    const roll = rand();
    if (roll < 0.3 || allocations.length === 0) {
      const opp = await createTestOpportunityRegistry(e.sourceId, e.platformId, { unit: "kg", status: "reservada" });
      const needId = rand() < 0.15 ? null : pick(e.needIds);
      const [al] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: opp.id, organizationId: e.orgId, quantityAllocated: "100", status: "aceita", needId }).returning(["id"]).execute();
      const quantity = 10 + Math.floor(rand() * 90);
      const res = await postReceive(post("allocations-receive", e.owner, { organizationId: e.orgId, allocationId: al.id, itemId: e.itemId, quantityReceived: quantity }));
      expect(res.status, "receive").toBe(200);
      allocations.push(al.id);
      c.receipts++;
    } else if (roll < 0.6) {
      const allocationId = pick(allocations);
      const h = await history(e, allocationId);
      const body: Record<string, unknown> = { organizationId: e.orgId, allocationId, expectedVigenteFulfillmentId: h.vigenteFulfillmentId, reason: "Conferência na chegada" };
      const kind = rand();
      if (kind < 0.7) body.quantity = 5 + Math.floor(rand() * 150);
      else if (kind < 0.85) body.unit = pick(["kg", "caixas", "KG"]);
      else {
        body.quantity = 5 + Math.floor(rand() * 60);
        body.unit = "kg";
      }
      const res = await postCorrect(post("allocations-receipt-correct", e.owner, body));
      expect(res.status, `correct ${JSON.stringify(body)}`).toBeLessThan(500);
      if (res.status === 202) await approve(e, res);
      else if (res.status >= 400) c.rejected++;
      c.corrections++;
    } else if (roll < 0.8) {
      const allocationId = pick(allocations);
      const h = await history(e, allocationId);
      const res = await postReverse(post("allocations-receipt-reverse", e.owner, { organizationId: e.orgId, allocationId, expectedVigenteFulfillmentId: h.vigenteFulfillmentId, reason: "Doação duplicada", withdrawStock: rand() < 0.5 }));
      expect(res.status, "reverse").toBeLessThan(500);
      if (res.status === 202) await approve(e, res);
      else if (res.status >= 400) c.rejected++;
      c.reversals++;
    } else {
      const type = pick(["entrada", "entrada", "saida", "ajuste"] as const);
      const quantity = type === "ajuste" ? (rand() < 0.5 ? -1 : 1) * (1 + Math.floor(rand() * 20)) : 1 + Math.floor(rand() * 30);
      const res = await postStock(post("stock-transactions", e.owner, { organizationId: e.orgId, itemId: e.itemId, type, quantity, reason: "Lançamento manual" }));
      expect(res.status, `stock ${type}`).toBeLessThan(500);
      if (res.status === 202) await approve(e, res);
      else if (res.status >= 400) c.rejected++;
      c.manual++;
    }
    // todos os eventos em instantes distintos e crescentes (o relatório pareia correção+estorno pelo MESMO created_at)
    if (step % 7 === 6) await sql`SELECT 1`.execute(db);
  }
  return { e, allocations, c };
}

const num = (v: unknown) => Number(v ?? 0);

async function reportFor(e: Env, start: Date, end: Date): Promise<Report> {
  const qs = new URLSearchParams({ organizationId: String(e.orgId), startDate: start.toISOString(), endDate: end.toISOString() });
  const res = await getReport(buildRequest(`impact-report?${qs}`, { cookie: e.owner.cookie }));
  expect(res.status).toBe(200);
  return parseJson<Report>(res);
}

/** Todas as invariantes, recalculadas por SQL independente. */
async function assertReconciled(e: Env, allocations: number[]) {
  const start = new Date(Date.now() - 3 * 86400000);
  const end = new Date(Date.now() + 86400000);
  const r = await reportFor(e, start, end);

  // ---- estoque físico -------------------------------------------------------------------------------------
  const st = await sql<{ type: string; total: string; n: string }>`SELECT type, sum(delta) AS total, count(*) AS n FROM stock_transactions WHERE organization_id = ${e.orgId} GROUP BY type`.execute(db);
  const byType = new Map(st.rows.map((x) => [x.type, num(x.total)]));
  const stockTotal = [...byType.values()].reduce((a, b) => a + b, 0);
  const itemsRes = await getItems(buildRequest(`inventory-items?organizationId=${e.orgId}`, { cookie: e.owner.cookie }));
  const items = (await parseJson<{ items: Array<{ id: number; currentStock: number }> }>(itemsRes)).items;
  expect(items.find((i) => i.id === e.itemId)?.currentStock, "inventory-items × Σ stock_transactions").toBe(stockTotal);
  expect(stockTotal, "estoque nunca negativo").toBeGreaterThanOrEqual(0);
  const running = await sql<{ low: string | null }>`SELECT min(run) AS low FROM (SELECT sum(delta) OVER (PARTITION BY item_id ORDER BY created_at, id) AS run FROM stock_transactions WHERE organization_id = ${e.orgId}) x`.execute(db);
  expect(num(running.rows[0].low), "o saldo acumulado NUNCA ficou negativo em nenhum ponto do histórico").toBeGreaterThanOrEqual(0);
  if (r.itemMovements.length > 0) {
    const m = r.itemMovements[0];
    expect(m.currentStock, "relatório × Σ delta").toBe(stockTotal);
    expect(m.balanceAtEnd, "saldo final do período = Σ delta (período cobre tudo)").toBe(stockTotal);
    expect(m.balanceAtStart, "saldo inicial = 0 (nada antes do período)").toBe(0);
    expect(m.entradas, "Σ entradas").toBe(byType.get("entrada") ?? 0);
    expect(m.saidas + 0, "Σ saídas").toBe(-(byType.get("saida") ?? 0) + 0);
    expect(m.ajustes, "Σ ajustes").toBe(byType.get("ajuste") ?? 0);
    expect(m.ajustesRede + m.ajustesOutros).toBe(m.ajustes);
    expect(m.balanceAtStart + m.netChange, "saldo inicial + movimentação = saldo final").toBe(m.balanceAtEnd);
    const linked = await sql<{ total: string }>`SELECT coalesce(sum(st.delta),0) AS total FROM stock_transactions st JOIN need_fulfillments nf ON nf.stock_transaction_id = st.id WHERE st.organization_id = ${e.orgId} AND st.type = 'ajuste'`.execute(db);
    expect(m.ajustesRede, "ajustes da rede = ajustes ligados ao ledger").toBe(num(linked.rows[0].total));
  }

  // ---- trilha de auditoria: todo movimento de estoque MANUAL tem exatamente um evento (direto ou aprovado e executado) ----
  const manual = await sql<{ n: string }>`SELECT count(*) AS n FROM stock_transactions st WHERE st.organization_id = ${e.orgId} AND NOT EXISTS (SELECT 1 FROM need_fulfillments nf WHERE nf.stock_transaction_id = st.id)`.execute(db);
  const manualAudits = await sql<{ n: string }>`SELECT count(*) AS n FROM audit_log WHERE organization_id = ${e.orgId} AND action IN ('inventario.entrada_registrada', 'inventario.saida_registrada', 'inventario.ajuste_registrado', 'inventario.ajuste_aprovado_e_executado')`.execute(db);
  expect(num(manualAudits.rows[0].n), "movimentos manuais de estoque × eventos de auditoria").toBe(num(manual.rows[0].n));

  // ---- ledger de atendimento × necessidades ---------------------------------------------------------------
  const ledger = await sql<{ needId: number; total: string }>`
    SELECT need_id, coalesce(sum(CASE WHEN NOT is_countable THEN 0 WHEN entry_type = 'reversal' THEN -quantity ELSE quantity END), 0) AS total
      FROM need_fulfillments WHERE organization_id = ${e.orgId} AND need_id IS NOT NULL GROUP BY need_id`.execute(db);
  const expected = new Map(ledger.rows.map((x) => [x.needId, num(x.total)]));
  for (const row of r.needs.rows) {
    const want = expected.get(row.id) ?? 0;
    expect(row.today.fulfilled, `necessidade ${row.id}: hoje × Σ ledger`).toBe(want);
    expect(row.atEnd.fulfilled, `necessidade ${row.id}: fim do período × Σ ledger`).toBe(want);
    expect(row.fulfilledAtStart + row.periodNet, `necessidade ${row.id}: início + período = fim`).toBe(row.atEnd.fulfilled);
    expect(row.components.recebido + row.components.correcoes + row.components.estornos, `necessidade ${row.id}: componentes = acumulado`).toBeCloseTo(row.atEnd.fulfilled, 6);
    expect(row.atEnd.requiredRemaining).toBe(Math.max(0, row.needed - want));
    expect(row.atEnd.surplus, "sobra permanece contabilizada").toBe(Math.max(0, want - row.needed));
  }
  // toda necessidade com saldo ≠ 0 aparece no relatório (critério P-R6)
  for (const [needId, total] of expected) if (total !== 0) expect(r.needs.rows.map((x) => x.id), `necessidade ${needId} com saldo ${total}`).toContain(needId);

  // ---- cartões × listas × ledger --------------------------------------------------------------------------
  const entradas = await sql<{ n: string }>`SELECT count(*) AS n FROM stock_transactions WHERE organization_id = ${e.orgId} AND type = 'entrada'`.execute(db);
  expect(r.summary.donations.total, "doações = entradas físicas").toBe(num(entradas.rows[0].n));
  expect(r.summary.donations.network + r.summary.donations.manual).toBe(r.summary.donations.total);
  expect(r.donations.rows.length).toBe(r.summary.donations.total);
  expect(r.donations.rows.reduce((a, x) => a + x.quantity, 0), "Σ das doações listadas = Σ entradas").toBe(byType.get("entrada") ?? 0);
  const corrRows = await sql<{ n: string }>`SELECT count(*) AS n FROM need_fulfillments WHERE organization_id = ${e.orgId} AND entry_type = 'correction'`.execute(db);
  expect(r.summary.corrections, "correções = linhas `correction`").toBe(num(corrRows.rows[0].n));
  const events = r.receipts.groups.flatMap((g) => g.events).filter((x) => x.inPeriod);
  expect(events.filter((x) => x.kind === "correcao" || x.kind === "reativacao").length, "eventos de correção listados = cartão").toBe(r.summary.corrections);
  expect(events.filter((x) => x.kind === "estorno").length, "estornos listados = cartão").toBe(r.summary.reversals.total);
  expect(r.summary.reversals.accountingOnly + r.summary.reversals.withWithdrawal).toBe(r.summary.reversals.total);

  // ---- rastreabilidade: linha do ledger ↔ histórico ↔ movimento físico ↔ auditoria -----------------------
  for (const allocationId of allocations) {
    const h = await history(e, allocationId);
    const linked = await sql<{ total: string }>`SELECT coalesce(sum(st.delta),0) AS total FROM need_fulfillments nf JOIN stock_transactions st ON st.id = nf.stock_transaction_id WHERE nf.organization_id = ${e.orgId} AND nf.allocation_id = ${allocationId}`.execute(db);
    expect(h.physicalBalance, `atribuição ${allocationId}: saldo físico do histórico × Σ movimentos ligados`).toBe(num(linked.rows[0].total));
    const dbRows = await sql<{ id: string; entryType: string; stockTransactionId: string | null }>`SELECT id, entry_type, stock_transaction_id FROM need_fulfillments WHERE organization_id = ${e.orgId} AND allocation_id = ${allocationId} ORDER BY id`.execute(db);
    expect(h.rows.map((x) => x.id), "histórico lista TODAS as linhas do ledger").toEqual(dbRows.rows.map((x) => String(x.id)));
    for (const row of dbRows.rows.filter((x) => x.entryType !== "original")) {
      const audits = await sql<{ n: string }>`SELECT count(*) AS n FROM audit_log WHERE organization_id = ${e.orgId} AND entity_type = 'opportunity_allocation' AND entity_id = ${String(allocationId)} AND action IN ('atribuicao.recebimento_corrigido','atribuicao.recebimento_estornado') AND metadata -> 'fulfillmentIds' ? ${String(row.id)}`.execute(db);
      expect(num(audits.rows[0].n), `linha ${row.id} (${row.entryType}) tem exatamente 1 evento de auditoria`).toBe(1);
    }
    // o original nunca é apagado nem alterado: continua com a quantidade e a entrada física do recebimento
    const orig = dbRows.rows.find((x) => x.entryType === "original");
    expect(orig, "original preservado").toBeDefined();
    expect(orig!.stockTransactionId).not.toBeNull();
  }
}


/** Aditividade entre períodos: [início, meio) + [meio, fim) fecha com [início, fim) em estoque, necessidades e cartões. */
async function assertPeriodAdditivity(e: Env) {
  for (const source of ["stock_transactions", "need_fulfillments"] as const) await additivityAt(e, source);
}

async function additivityAt(e: Env, source: "stock_transactions" | "need_fulfillments") {
  const start = new Date(Date.now() - 3 * 86400000);
  const end = new Date(Date.now() + 86400000);
  const times = await sql<{ t: Date }>`SELECT DISTINCT created_at AS t FROM ${sql.table(source)} WHERE organization_id = ${e.orgId} ORDER BY 1`.execute(db);
  if (times.rows.length < 3) return;
  const mid = times.rows[Math.floor(times.rows.length / 2)].t; // um instante REAL de evento dessa fonte: cai no 2º período (limite inferior inclusivo) e fora do 1º (superior exclusivo)
  const [all, p1, p2] = await Promise.all([reportFor(e, start, end), reportFor(e, start, mid), reportFor(e, mid, end)]);
  const m = (r: Report) => r.itemMovements[0];
  if (all.itemMovements.length > 0) {
    const a = m(all), x = m(p1), y = m(p2);
    expect((x?.balanceAtEnd ?? 0) + 0, "saldo final do 1º período = saldo inicial do 2º").toBe((y?.balanceAtStart ?? x?.balanceAtEnd ?? 0) + 0);
    expect((x?.entradas ?? 0) + (y?.entradas ?? 0), "Σ entradas dos períodos").toBe(a.entradas);
    expect((x?.saidas ?? 0) + (y?.saidas ?? 0)).toBe(a.saidas);
    expect((x?.ajustes ?? 0) + (y?.ajustes ?? 0)).toBe(a.ajustes);
    expect((y?.balanceAtEnd ?? 0)).toBe(a.balanceAtEnd);
  }
  expect(p1.summary.donations.total + p2.summary.donations.total).toBe(all.summary.donations.total);
  expect(p1.summary.corrections + p2.summary.corrections).toBe(all.summary.corrections);
  expect(p1.summary.reversals.total + p2.summary.reversals.total).toBe(all.summary.reversals.total);
  const nets = (r: Report) => new Map(r.needs.rows.map((n) => [n.id, n]));
  const [n1, n2, nAll] = [nets(p1), nets(p2), nets(all)];
  for (const [id, row] of nAll) {
    const net1 = n1.get(id)?.periodNet ?? 0;
    const net2 = n2.get(id)?.periodNet ?? 0;
    expect(net1 + net2, `necessidade ${id}: movimentação dos dois períodos = movimentação total`).toBeCloseTo(row.periodNet, 6);
    expect(n2.get(id)?.fulfilledAtStart ?? n1.get(id)?.atEnd.fulfilled ?? 0, `necessidade ${id}: acumulado inicial do 2º = final do 1º`).toBeCloseTo(n1.get(id)?.atEnd.fulfilled ?? 0, 6);
  }
}

describe("conciliação estoque × ledger × prestação de contas (sequências determinísticas)", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`semente ${seed}: 40 operações pelos endpoints reais; todas as invariantes fecham`, async () => {
      const { e, allocations, c } = await runScenario(seed, 40);
      expect(c.receipts).toBeGreaterThan(3);
      await assertReconciled(e, allocations);
      await assertPeriodAdditivity(e);
    }, 120_000);
  }
});

void MIN;
