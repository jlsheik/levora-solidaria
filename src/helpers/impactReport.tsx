import { sql, type Kysely, type RawBuilder } from "kysely";
import type { DB } from "./schema.js";
import { computeNeedProgress, getNeedFulfillmentBalanceBatch } from "./needFulfillment.js";
import { countedEffect } from "./needFulfillmentCorrections.js";
import { normalize } from "./opportunityMatching.js";

/**
 * Prestação de Contas (Fase 85, Fatia 3) — CAMADA DE LEITURA sobre dados existentes. Contrato:
 * docs/PRESTACAO_CONTAS_ESPECIFICACAO.md. Nada aqui escreve, cria coluna, persiste saldo ou altera o ledger.
 *
 * Fontes: estoque físico = `stock_transactions`; atendimento = `need_fulfillments` (fórmula do saldo SÓ em
 * `needFulfillment.tsx`); estado administrativo = `needs.status` (nunca inferido); auditoria = `audit_log`, usada só
 * para motivo/aprovador (nunca exposta crua).
 *
 * Datas: intervalo SEMIABERTO `[startDate, endDateExclusive)` (início do dia ≥, início do dia seguinte <). Todos os
 * filtros de data de todas as consultas usam o mesmo par.
 *
 * Agregações (cartões, totais, saldos) são calculadas no SQL sobre TODO o conjunto; os limites de exibição valem só
 * para as LISTAS (nunca se calcula total em cima de uma lista truncada).
 */

export const REPORT_EVENT_LIMIT = 1000;
export const REPORT_NEED_LIMIT = 500;

export const REPORT_EVENT_TYPES = ["recebimento", "entrada_manual", "correcao", "estorno"] as const;
export type ReportEventType = (typeof REPORT_EVENT_TYPES)[number];

export interface ImpactReportParams {
  organizationId: number;
  startDate: Date;
  /** EXCLUSIVO. */
  endDate: Date;
  itemId?: number | null;
  needId?: number | null;
  eventType?: ReportEventType | null;
}

export type ReceiptEventKind = "correcao" | "reativacao" | "estorno";

export interface ReceiptEvent {
  kind: ReceiptEventKind;
  /** Só para `correcao`: positiva (↑ quantidade), negativa (↓) ou reclassificação de unidade. */
  subtype: "positiva" | "negativa" | "unidade" | null;
  createdAt: string;
  inPeriod: boolean;
  quantityFrom: number | null;
  quantityTo: number | null;
  /** quantidade nova − anterior (correção); −quantidade (estorno); nova (reativação). Na unidade da linha. */
  delta: number;
  unit: string;
  unitFrom: string | null;
  /** Efeito contado no saldo da necessidade (par = efeito líquido do par). */
  countedEffect: number;
  /** Consequência FÍSICA ligada a este evento (um `ajuste` do estoque), ou null (só contábil). */
  physical: { delta: number; withdrawal: boolean } | null;
  reason: string | null;
  authorName: string | null;
  approvedByName: string | null;
}

export interface ReceiptGroup {
  allocationId: number;
  opportunityTitle: string | null;
  needId: number | null;
  needTitle: string | null;
  item: { id: number; name: string; unit: string } | null;
  original: { quantity: number; unit: string; createdAt: string; inPeriod: boolean; isCountable: boolean; authorName: string | null; physicalDelta: number | null } | null;
  events: ReceiptEvent[];
  /** Efeito contado total do grupo (original + correções + estornos), todo o histórico. */
  netCounted: number;
  lastActivityAt: string;
}

export interface NeedReportRow {
  id: number;
  title: string;
  itemId: number | null;
  itemName: string | null;
  unit: string;
  needed: number;
  status: string;
  updatedAt: string;
  hasActivityInPeriod: boolean;
  /** Acumulado até o fim do período. */
  atEnd: { fulfilled: number; requiredRemaining: number; surplus: number };
  /** Acumulado no início do período (`created_at < startDate`). */
  fulfilledAtStart: number;
  /** Movimentação do período (Σ efeitos com `created_at ∈ [start, end)`). */
  periodNet: number;
  /** Composição do acumulado até o fim (recebido + correções + estornos = fulfilled). */
  components: { recebido: number; correcoes: number; estornos: number };
  /** Visão de hoje (todo o histórico). */
  today: { fulfilled: number; requiredRemaining: number; surplus: number };
  /** `needs.status = atendida` mas ainda há saldo faltante HOJE (aviso factual; nunca reabre). */
  statusWarning: boolean;
}

export interface ImpactReportOutput {
  period: { startDate: string; endDateExclusive: string };
  generatedAt: string;
  filters: { itemId: number | null; needId: number | null; eventType: ReportEventType | null };
  organizationName: string;
  summary: {
    needsCreated: number;
    needsMarkedAtendida: number;
    donations: { total: number; network: number; manual: number };
    corrections: number;
    reversals: { total: number; accountingOnly: number; withWithdrawal: number };
    auditEventCount: number;
  };
  itemMovements: Array<{
    itemId: number;
    itemName: string;
    unit: string;
    entradas: number;
    saidas: number;
    ajustes: number;
    ajustesRede: number;
    ajustesOutros: number;
    netChange: number;
    balanceAtStart: number;
    balanceAtEnd: number;
    currentStock: number;
  }>;
  donations: {
    rows: Array<{
      id: string;
      createdAt: string;
      quantity: number;
      unit: string;
      itemId: number;
      itemName: string;
      origin: "rede" | "manual";
      reason: string | null;
      needId: number | null;
      needTitle: string | null;
      allocationId: number | null;
      opportunityTitle: string | null;
    }>;
    total: number;
    truncated: boolean;
    limit: number;
  };
  receipts: { groups: ReceiptGroup[]; totalEvents: number; truncated: boolean; limit: number };
  needs: { rows: NeedReportRow[]; truncated: boolean; limit: number };
}

const num = (v: unknown) => Number(v ?? 0);

/** Linhas do ledger com o item físico do recebimento e a marca "par de correção" (mesma transação = mesmo `created_at`). */
function ledgerRowsCte(organizationId: number): RawBuilder<unknown> {
  return sql`lr AS (
    SELECT nf.id, nf.entry_type, nf.need_id, nf.allocation_id, nf.created_at, nf.quantity, nf.is_countable,
           nf.stock_transaction_id, nf.reverses_fulfillment_id, so.item_id AS item_id,
           (nf.entry_type = 'reversal' AND EXISTS (
              SELECT 1 FROM need_fulfillments c
              WHERE c.entry_type = 'correction' AND c.reverses_fulfillment_id = nf.reverses_fulfillment_id AND c.created_at = nf.created_at
           )) AS paired
    FROM need_fulfillments nf
    LEFT JOIN need_fulfillments o ON o.allocation_id = nf.allocation_id AND o.entry_type = 'original'
    LEFT JOIN stock_transactions so ON so.id = o.stock_transaction_id
    WHERE nf.organization_id = ${organizationId}
  )`;
}

interface ChainRow {
  id: string;
  entryType: "original" | "correction" | "reversal";
  needId: number | null;
  allocationId: number;
  quantity: number;
  unit: string;
  isCountable: boolean;
  reversesId: string | null;
  createdAt: Date;
  createdByUserId: number | null;
  stockTransactionId: string | null;
  physicalDelta: number | null;
  itemId: number | null;
  itemName: string | null;
  itemUnit: string | null;
  needTitle: string | null;
  opportunityTitle: string | null;
}

interface AuditInfo {
  reason: string | null;
  actorUserId: number | null;
  approvalRequestId: number | null;
}

/**
 * Classifica as linhas do ledger de UMA atribuição em eventos legíveis. Puro (sem banco), testável.
 * Par de correção = `reversal` + `correction` do MESMO alvo na MESMA transação (mesmo `createdAt`) → UM evento
 * "Correção de A para B". `reversal` sem par = "Estorno". `correction` sobre alvo já estornado (e sem par) = "Desfazer
 * estorno". O `original` nunca vira evento (é o recebimento — a doação conta uma vez, pela `entrada` física).
 */
export function classifyReceiptEvents(
  rows: ChainRow[],
  period: { start: Date; end: Date },
  audit: (row: ChainRow) => AuditInfo | null,
  userName: (id: number | null) => string | null
): ReceiptEvent[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const sameTx = (a: ChainRow, b: ChainRow) => a.createdAt.getTime() === b.createdAt.getTime();
  const reversalsOf = (targetId: string) => rows.filter((r) => r.entryType === "reversal" && r.reversesId === targetId);
  const events: ReceiptEvent[] = [];
  const inPeriod = (d: Date) => d >= period.start && d < period.end;

  const effect = (r: ChainRow) => countedEffect({ entryType: r.entryType, quantity: r.quantity, isCountable: r.isCountable });

  for (const r of rows) {
    if (r.entryType === "original") continue;
    const info = audit(r);
    const common = {
      createdAt: r.createdAt.toISOString(),
      inPeriod: inPeriod(r.createdAt),
      reason: info?.reason ?? null,
      authorName: userName(r.createdByUserId),
      approvedByName: info?.approvalRequestId != null ? userName(info.actorUserId) : null,
    };

    if (r.entryType === "reversal") {
      const paired = rows.some((c) => c.entryType === "correction" && c.reversesId === r.reversesId && sameTx(c, r));
      if (paired) continue; // representado pela correção do par
      events.push({
        ...common,
        kind: "estorno",
        subtype: null,
        quantityFrom: r.quantity,
        quantityTo: 0,
        delta: -r.quantity,
        unit: r.unit,
        unitFrom: null,
        countedEffect: effect(r),
        physical: r.physicalDelta !== null ? { delta: r.physicalDelta, withdrawal: true } : null,
      });
      continue;
    }

    // correction
    const target = r.reversesId ? (byId.get(r.reversesId) ?? null) : null;
    const pairRev = target ? reversalsOf(target.id).find((x) => sameTx(x, r)) ?? null : null;
    const reactivation = !pairRev && target !== null && reversalsOf(target.id).length > 0;
    const unitChanged = target !== null && normalize(target.unit) !== normalize(r.unit);
    const from = target ? target.quantity : null;
    events.push({
      ...common,
      kind: reactivation ? "reativacao" : "correcao",
      subtype: reactivation ? null : unitChanged ? "unidade" : from !== null && r.quantity >= from ? "positiva" : "negativa",
      quantityFrom: reactivation ? null : from,
      quantityTo: r.quantity,
      delta: reactivation ? r.quantity : from !== null ? Math.round((r.quantity - from) * 1000) / 1000 : r.quantity,
      unit: r.unit,
      unitFrom: unitChanged && target ? target.unit : null,
      countedEffect: effect(r) + (pairRev ? effect(pairRev) : 0),
      physical: r.physicalDelta !== null ? { delta: r.physicalDelta, withdrawal: false } : null,
    });
  }
  return events.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

export async function buildImpactReport(db: Kysely<DB>, params: ImpactReportParams): Promise<ImpactReportOutput> {
  const org = params.organizationId;
  const s = params.startDate;
  const e = params.endDate;
  const itemId = params.itemId ?? null;
  const needId = params.needId ?? null;
  const eventType = params.eventType ?? null;

  const stItem = itemId !== null ? sql`AND st.item_id = ${itemId}` : sql``;
  const nfNeed = needId !== null ? sql`AND nf.need_id = ${needId}` : sql``;
  const lrItem = itemId !== null ? sql`AND item_id = ${itemId}` : sql``;
  const lrNeed = needId !== null ? sql`AND need_id = ${needId}` : sql``;
  const nItem = itemId !== null ? sql`AND n.item_id = ${itemId}` : sql``;
  const nNeed = needId !== null ? sql`AND n.id = ${needId}` : sql``;

  // ── 1. cabeçalho + cartões (todas as contagens, sobre o conjunto COMPLETO) ──────────────────────────
  const counters = (
    await sql<{
      orgName: string | null;
      dTotal: string;
      dNet: string;
      corrections: string;
      revAcc: string;
      revPhys: string;
      needsCreated: string;
      needsMarked: string;
      auditCount: string;
    }>`
    WITH ${ledgerRowsCte(org)}
    SELECT
      (SELECT name FROM organizations WHERE id = ${org}) AS org_name,
      d.total AS d_total, d.net AS d_net,
      l.corrections, l.rev_acc, l.rev_phys,
      n.created AS needs_created, n.marked AS needs_marked,
      (SELECT count(*) FROM audit_log WHERE organization_id = ${org} AND created_at >= ${s} AND created_at < ${e}) AS audit_count
    FROM
      (SELECT count(*) AS total, count(nf.id) AS net
         FROM stock_transactions st
         LEFT JOIN need_fulfillments nf ON nf.stock_transaction_id = st.id AND nf.entry_type = 'original' AND nf.organization_id = ${org}
        WHERE st.organization_id = ${org} AND st.type = 'entrada' AND st.created_at >= ${s} AND st.created_at < ${e} ${stItem} ${nfNeed}) d,
      (SELECT count(*) FILTER (WHERE entry_type = 'correction') AS corrections,
              count(*) FILTER (WHERE entry_type = 'reversal' AND NOT paired AND stock_transaction_id IS NULL) AS rev_acc,
              count(*) FILTER (WHERE entry_type = 'reversal' AND NOT paired AND stock_transaction_id IS NOT NULL) AS rev_phys
         FROM lr WHERE created_at >= ${s} AND created_at < ${e} ${lrItem} ${lrNeed}) l,
      (SELECT count(*) FILTER (WHERE n.created_at >= ${s} AND n.created_at < ${e}) AS created,
              count(*) FILTER (WHERE n.status = 'atendida' AND n.updated_at >= ${s} AND n.updated_at < ${e}) AS marked
         FROM needs n WHERE n.organization_id = ${org} ${nItem} ${nNeed}) n
  `.execute(db)
  ).rows[0];

  const donationsTotal = num(counters.dTotal);
  const donationsNetwork = num(counters.dNet);
  const correctionsCount = num(counters.corrections);
  const revAcc = num(counters.revAcc);
  const revPhys = num(counters.revPhys);

  // ── 2. movimentação física por item (período, fim do período, hoje) ───────────────────────────────
  const movementRows = (
    await sql<{
      itemId: number;
      itemName: string;
      unit: string;
      entradas: string;
      saidas: string;
      ajustesRede: string;
      ajustesOutros: string;
      balanceAtStart: string;
      balanceAtEnd: string;
      currentStock: string;
    }>`
    SELECT i.id AS item_id, i.name AS item_name, i.unit,
      coalesce(sum(st.delta) FILTER (WHERE st.type = 'entrada' AND st.created_at >= ${s} AND st.created_at < ${e}), 0) AS entradas,
      coalesce(sum(-st.delta) FILTER (WHERE st.type = 'saida' AND st.created_at >= ${s} AND st.created_at < ${e}), 0) AS saidas,
      coalesce(sum(st.delta) FILTER (WHERE st.type = 'ajuste' AND nf.id IS NOT NULL AND st.created_at >= ${s} AND st.created_at < ${e}), 0) AS ajustes_rede,
      coalesce(sum(st.delta) FILTER (WHERE st.type = 'ajuste' AND nf.id IS NULL AND st.created_at >= ${s} AND st.created_at < ${e}), 0) AS ajustes_outros,
      coalesce(sum(st.delta) FILTER (WHERE st.created_at < ${s}), 0) AS balance_at_start,
      coalesce(sum(st.delta) FILTER (WHERE st.created_at < ${e}), 0) AS balance_at_end,
      coalesce(sum(st.delta), 0) AS current_stock
    FROM stock_transactions st
    JOIN inventory_items i ON i.id = st.item_id AND i.organization_id = ${org}
    LEFT JOIN need_fulfillments nf ON nf.stock_transaction_id = st.id AND nf.organization_id = ${org}
    WHERE st.organization_id = ${org} ${stItem}
    GROUP BY i.id, i.name, i.unit
    -- Inclusão (decisão de produto, Fase 94): o item aparece se teve movimentação no período OU tem saldo final ≠ 0 (acumulado até o fim).
    -- Item só com saldo: entradas/saídas/ajustes do período = 0 (o saldo anterior NÃO é movimentação); nada é criado no ledger.
    HAVING count(*) FILTER (WHERE st.created_at >= ${s} AND st.created_at < ${e}) > 0
        OR coalesce(sum(st.delta) FILTER (WHERE st.created_at < ${e}), 0) <> 0
    ORDER BY i.name, i.id
  `.execute(db)
  ).rows;

  // ── 3. lista "Doações recebidas" (entradas; LIMITADA — os totais vêm do SQL acima) ─────────────────
  const donationsAllowed = eventType === null || eventType === "recebimento" || eventType === "entrada_manual";
  const originCond = eventType === "recebimento" ? sql`AND nf.id IS NOT NULL` : eventType === "entrada_manual" ? sql`AND nf.id IS NULL` : sql``;
  const donationRows = donationsAllowed
    ? (
        await sql<{
          id: string;
          createdAt: Date;
          delta: string;
          unit: string;
          itemId: number;
          itemName: string;
          reason: string | null;
          needId: number | null;
          needTitle: string | null;
          allocationId: number | null;
          opportunityTitle: string | null;
          fromNetwork: boolean;
        }>`
        SELECT st.id, st.created_at, st.delta, i.unit, i.id AS item_id, i.name AS item_name, st.reason,
               nf.need_id, n.title AS need_title, nf.allocation_id, r.title AS opportunity_title,
               (nf.id IS NOT NULL) AS from_network
          FROM stock_transactions st
          JOIN inventory_items i ON i.id = st.item_id AND i.organization_id = ${org}
          LEFT JOIN need_fulfillments nf ON nf.stock_transaction_id = st.id AND nf.entry_type = 'original' AND nf.organization_id = ${org}
          LEFT JOIN needs n ON n.id = nf.need_id AND n.organization_id = ${org}
          LEFT JOIN opportunity_allocations a ON a.id = nf.allocation_id AND a.organization_id = ${org}
          LEFT JOIN opportunity_registry r ON r.id = a.opportunity_registry_id
         WHERE st.organization_id = ${org} AND st.type = 'entrada' AND st.created_at >= ${s} AND st.created_at < ${e} ${stItem} ${nfNeed} ${originCond}
         ORDER BY st.created_at DESC, st.id DESC
         LIMIT ${REPORT_EVENT_LIMIT + 1}
      `.execute(db)
      ).rows
    : [];
  const donationsTruncated = donationRows.length > REPORT_EVENT_LIMIT;

  // ── 4. eventos do ledger no período (correções + estornos sem par; LIMITADO) ───────────────────────
  const wantCorrections = eventType === null || eventType === "correcao";
  const wantReversals = eventType === null || eventType === "estorno";
  const totalEvents = (wantCorrections ? correctionsCount : 0) + (wantReversals ? revAcc + revPhys : 0);
  const kindCond = wantCorrections && wantReversals ? sql`entry_type = 'correction' OR (entry_type = 'reversal' AND NOT paired)` : wantCorrections ? sql`entry_type = 'correction'` : sql`entry_type = 'reversal' AND NOT paired`;
  const eventRowIds =
    wantCorrections || wantReversals
      ? (
          await sql<{ id: string; allocationId: number }>`
          WITH ${ledgerRowsCte(org)}
          SELECT id, allocation_id FROM lr
           WHERE created_at >= ${s} AND created_at < ${e} ${lrItem} ${lrNeed}
             AND (${kindCond})
           ORDER BY created_at DESC, id DESC
           LIMIT ${REPORT_EVENT_LIMIT}
        `.execute(db)
        ).rows
      : [];
  const allocationIds = [...new Set(eventRowIds.map((r) => r.allocationId))];

  // ── 5. cadeias completas das atribuições envolvidas (1 consulta, em lote) ──────────────────────────
  const chainRowsRaw =
    allocationIds.length > 0
      ? await db
          .selectFrom("needFulfillments as nf")
          .leftJoin("stockTransactions as st", "st.id", "nf.stockTransactionId")
          .leftJoin("inventoryItems as ii", (j) => j.onRef("ii.id", "=", "st.itemId").on("ii.organizationId", "=", org))
          .leftJoin("needs as nd", (j) => j.onRef("nd.id", "=", "nf.needId").on("nd.organizationId", "=", org))
          .leftJoin("opportunityAllocations as al", (j) => j.onRef("al.id", "=", "nf.allocationId").on("al.organizationId", "=", org))
          .leftJoin("opportunityRegistry as rg", "rg.id", "al.opportunityRegistryId")
          .select([
            "nf.id",
            "nf.entryType",
            "nf.needId",
            "nf.allocationId",
            "nf.quantity",
            "nf.unit",
            "nf.isCountable",
            "nf.reversesFulfillmentId",
            "nf.createdAt",
            "nf.createdByUserId",
            "nf.stockTransactionId",
            "st.delta as physicalDelta",
            "st.itemId as itemId",
            "ii.name as itemName",
            "ii.unit as itemUnit",
            "nd.title as needTitle",
            "rg.title as opportunityTitle",
          ])
          .where("nf.organizationId", "=", org)
          .where("nf.allocationId", "in", allocationIds)
          .orderBy("nf.id", "asc")
          .execute()
      : [];
  const chainRows: ChainRow[] = chainRowsRaw.map((r) => ({
    id: String(r.id),
    entryType: r.entryType,
    needId: r.needId,
    allocationId: r.allocationId,
    quantity: Number(r.quantity),
    unit: r.unit,
    isCountable: r.isCountable,
    reversesId: r.reversesFulfillmentId === null ? null : String(r.reversesFulfillmentId),
    createdAt: r.createdAt,
    createdByUserId: r.createdByUserId,
    stockTransactionId: r.stockTransactionId === null ? null : String(r.stockTransactionId),
    physicalDelta: r.physicalDelta === null ? null : Number(r.physicalDelta),
    itemId: r.itemId ?? null,
    itemName: r.itemName ?? null,
    itemUnit: r.itemUnit ?? null,
    needTitle: r.needTitle ?? null,
    opportunityTitle: r.opportunityTitle ?? null,
  }));

  // ── 6. motivo e aprovador (auditoria SÓ contextual: ids/motivo; nunca o evento cru) ────────────────
  const auditRows =
    allocationIds.length > 0
      ? await db
          .selectFrom("auditLog")
          .select(["actorUserId", "metadata"])
          .where("organizationId", "=", org)
          .where("entityType", "=", "opportunity_allocation")
          .where("entityId", "in", allocationIds.map(String))
          .where("action", "in", ["atribuicao.recebimento_corrigido", "atribuicao.recebimento_estornado"])
          .execute()
      : [];
  const auditByFulfillment = new Map<string, AuditInfo>();
  for (const a of auditRows) {
    const meta = a.metadata as { fulfillmentIds?: unknown; motivo?: unknown; approvalRequestId?: unknown } | null;
    if (!meta || !Array.isArray(meta.fulfillmentIds)) continue;
    const info: AuditInfo = {
      reason: typeof meta.motivo === "string" ? meta.motivo : null,
      actorUserId: a.actorUserId,
      approvalRequestId: typeof meta.approvalRequestId === "number" ? meta.approvalRequestId : null,
    };
    for (const id of meta.fulfillmentIds) if (typeof id === "string") auditByFulfillment.set(id, info);
  }

  // ── 7. nomes (autor/aprovador): só `display_name`, em lote ─────────────────────────────────────────
  const userIds = [...new Set([...chainRows.map((r) => r.createdByUserId), ...[...auditByFulfillment.values()].map((a) => a.actorUserId)].filter((v): v is number => v !== null))];
  const users = userIds.length > 0 ? await db.selectFrom("users").select(["id", "displayName"]).where("id", "in", userIds).execute() : [];
  const nameById = new Map(users.map((u) => [u.id, u.displayName]));
  const userName = (id: number | null) => (id === null ? null : (nameById.get(id) ?? null));

  const period = { start: s, end: e };
  const byAllocation = new Map<number, ChainRow[]>();
  for (const r of chainRows) (byAllocation.get(r.allocationId) ?? byAllocation.set(r.allocationId, []).get(r.allocationId)!).push(r);

  const groups: ReceiptGroup[] = [];
  for (const [allocationId, rows] of byAllocation) {
    const original = rows.find((r) => r.entryType === "original") ?? null;
    let events = classifyReceiptEvents(rows, period, (r) => auditByFulfillment.get(r.id) ?? null, userName);
    // Filtro de tipo: só os eventos do tipo pedido; sem filtro, mantém o contexto (eventos fora do período, esmaecidos).
    if (eventType === "correcao") events = events.filter((ev) => ev.inPeriod && (ev.kind === "correcao" || ev.kind === "reativacao"));
    else if (eventType === "estorno") events = events.filter((ev) => ev.inPeriod && ev.kind === "estorno");
    if (events.length === 0 || !events.some((ev) => ev.inPeriod)) continue;
    const netCounted = rows.reduce((acc, r) => acc + countedEffect({ entryType: r.entryType, quantity: r.quantity, isCountable: r.isCountable }), 0);
    groups.push({
      allocationId,
      opportunityTitle: original?.opportunityTitle ?? null,
      needId: original?.needId ?? null,
      needTitle: original?.needTitle ?? null,
      item: original && original.itemId !== null ? { id: original.itemId, name: original.itemName ?? "", unit: original.itemUnit ?? "" } : null,
      original: original
        ? {
            quantity: original.quantity,
            unit: original.unit,
            createdAt: original.createdAt.toISOString(),
            inPeriod: original.createdAt >= s && original.createdAt < e,
            isCountable: original.isCountable,
            authorName: userName(original.createdByUserId),
            physicalDelta: original.physicalDelta,
          }
        : null,
      events,
      netCounted,
      lastActivityAt: events.filter((ev) => ev.inPeriod).map((ev) => ev.createdAt).sort().slice(-1)[0],
    });
  }
  groups.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : b.allocationId - a.allocationId));

  // ── 8. necessidades (P-R6): atividade de atendimento no período OU saldo relevante no fim do período ─
  const needRowsRaw = (
    await sql<{
      id: number;
      title: string;
      unit: string;
      quantityNeeded: string;
      status: string;
      itemId: number | null;
      itemName: string | null;
      updatedAt: Date;
      hasActivity: boolean;
    }>`
    WITH ${ledgerRowsCte(org)}
    SELECT n.id, n.title, n.unit, n.quantity_needed, n.status, n.item_id, i.name AS item_name, n.updated_at,
           (n.id IN (SELECT need_id FROM need_fulfillments WHERE organization_id = ${org} AND need_id IS NOT NULL AND created_at >= ${s} AND created_at < ${e})) AS has_activity
      FROM needs n
      LEFT JOIN inventory_items i ON i.id = n.item_id AND i.organization_id = ${org}
     WHERE n.organization_id = ${org} ${nNeed}
       ${itemId !== null ? sql`AND (n.item_id = ${itemId} OR n.id IN (SELECT need_id FROM lr WHERE item_id = ${itemId}))` : sql``}
       AND n.id IN (
         SELECT need_id FROM need_fulfillments
          WHERE organization_id = ${org} AND need_id IS NOT NULL AND created_at >= ${s} AND created_at < ${e}
         UNION
         SELECT need_id FROM need_fulfillments
          WHERE organization_id = ${org} AND need_id IS NOT NULL AND is_countable AND created_at < ${e}
          GROUP BY need_id
         HAVING sum(CASE WHEN entry_type = 'reversal' THEN -quantity ELSE quantity END) <> 0
       )
     ORDER BY n.title, n.id
     LIMIT ${REPORT_NEED_LIMIT + 1}
  `.execute(db)
  ).rows;
  const needsTruncated = needRowsRaw.length > REPORT_NEED_LIMIT;
  const needRows = needRowsRaw.slice(0, REPORT_NEED_LIMIT);
  const needIds = needRows.map((r) => r.id);

  // Saldo pela fórmula ÚNICA (lote, sem N+1): fim do período, início do período, movimentação do período, hoje.
  const [atEndMap, atStartMap, periodMap, todayMap] = await Promise.all([
    getNeedFulfillmentBalanceBatch(db, needIds, { before: e }),
    getNeedFulfillmentBalanceBatch(db, needIds, { before: s }),
    getNeedFulfillmentBalanceBatch(db, needIds, { from: s, to: e }),
    getNeedFulfillmentBalanceBatch(db, needIds),
  ]);

  // Composição do acumulado até o fim (recebido + correções + estornos = fulfilled), numa agregação por need.
  const componentRows =
    needIds.length > 0
      ? (
          await sql<{ needId: number; recebido: string; correcoes: string; estornos: string }>`
          WITH x AS (
            SELECT nf.need_id, nf.entry_type, nf.quantity, nf.is_countable,
                   (nf.entry_type = 'reversal' AND EXISTS (
                      SELECT 1 FROM need_fulfillments c
                       WHERE c.entry_type = 'correction' AND c.reverses_fulfillment_id = nf.reverses_fulfillment_id AND c.created_at = nf.created_at
                   )) AS paired
              FROM need_fulfillments nf
             WHERE nf.organization_id = ${org} AND nf.need_id IN (${sql.join(needIds)}) AND nf.created_at < ${e} AND nf.is_countable
          )
          SELECT need_id,
                 coalesce(sum(quantity) FILTER (WHERE entry_type = 'original'), 0) AS recebido,
                 coalesce(sum(quantity) FILTER (WHERE entry_type = 'correction'), 0) - coalesce(sum(quantity) FILTER (WHERE entry_type = 'reversal' AND paired), 0) AS correcoes,
                 -coalesce(sum(quantity) FILTER (WHERE entry_type = 'reversal' AND NOT paired), 0) AS estornos
            FROM x GROUP BY need_id
        `.execute(db)
        ).rows
      : [];
  const componentsByNeed = new Map(componentRows.map((r) => [r.needId, { recebido: num(r.recebido), correcoes: num(r.correcoes), estornos: num(r.estornos) }]));

  const needs: NeedReportRow[] = needRows.map((n) => {
    const needed = Number(n.quantityNeeded);
    const today = computeNeedProgress(needed, todayMap.get(n.id) ?? 0);
    return {
      id: n.id,
      title: n.title,
      itemId: n.itemId,
      itemName: n.itemName,
      unit: n.unit,
      needed,
      status: n.status,
      updatedAt: n.updatedAt.toISOString(),
      hasActivityInPeriod: n.hasActivity,
      atEnd: computeNeedProgress(needed, atEndMap.get(n.id) ?? 0),
      fulfilledAtStart: atStartMap.get(n.id) ?? 0,
      periodNet: periodMap.get(n.id) ?? 0,
      components: componentsByNeed.get(n.id) ?? { recebido: 0, correcoes: 0, estornos: 0 },
      today,
      // aviso factual: marcada como atendida, mas ainda falta saldo HOJE (nunca reabre, nunca altera o status)
      statusWarning: n.status === "atendida" && today.requiredRemaining > 0,
    };
  });

  return {
    period: { startDate: s.toISOString(), endDateExclusive: e.toISOString() },
    generatedAt: new Date().toISOString(),
    filters: { itemId, needId, eventType },
    organizationName: counters.orgName ?? "",
    summary: {
      needsCreated: num(counters.needsCreated),
      needsMarkedAtendida: num(counters.needsMarked),
      donations: { total: donationsTotal, network: donationsNetwork, manual: donationsTotal - donationsNetwork },
      corrections: correctionsCount,
      reversals: { total: revAcc + revPhys, accountingOnly: revAcc, withWithdrawal: revPhys },
      auditEventCount: num(counters.auditCount),
    },
    itemMovements: movementRows.map((r) => {
      const entradas = num(r.entradas);
      const saidas = num(r.saidas);
      const ajustesRede = num(r.ajustesRede);
      const ajustesOutros = num(r.ajustesOutros);
      return {
        itemId: r.itemId,
        itemName: r.itemName,
        unit: r.unit,
        entradas,
        saidas,
        ajustes: ajustesRede + ajustesOutros,
        ajustesRede,
        ajustesOutros,
        netChange: entradas - saidas + ajustesRede + ajustesOutros,
        balanceAtStart: num(r.balanceAtStart),
        balanceAtEnd: num(r.balanceAtEnd),
        currentStock: num(r.currentStock),
      };
    }),
    donations: {
      rows: donationRows.slice(0, REPORT_EVENT_LIMIT).map((r) => ({
        id: String(r.id),
        createdAt: r.createdAt.toISOString(),
        quantity: num(r.delta),
        unit: r.unit,
        itemId: r.itemId,
        itemName: r.itemName,
        origin: r.fromNetwork ? ("rede" as const) : ("manual" as const),
        reason: r.reason,
        needId: r.needId,
        needTitle: r.needTitle,
        allocationId: r.allocationId,
        opportunityTitle: r.opportunityTitle,
      })),
      total: donationsAllowed ? (eventType === "recebimento" ? donationsNetwork : eventType === "entrada_manual" ? donationsTotal - donationsNetwork : donationsTotal) : 0,
      truncated: donationsTruncated,
      limit: REPORT_EVENT_LIMIT,
    },
    receipts: { groups, totalEvents, truncated: totalEvents > REPORT_EVENT_LIMIT, limit: REPORT_EVENT_LIMIT },
    needs: { rows: needs, truncated: needsTruncated, limit: REPORT_NEED_LIMIT },
  };
}
