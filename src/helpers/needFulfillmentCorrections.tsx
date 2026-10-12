import type { Transaction } from "kysely";
import { sql } from "kysely";
import { z } from "zod";
import type { DB, Json } from "./schema.js";
import { normalize } from "./opportunityMatching.js";
import { computeNeedProgress, getNeedFulfillmentBalance } from "./needFulfillment.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { createApprovalRequest } from "./approvals.js";
import { getItemStockBalance } from "./stockBalance.js";
import superjson from "superjson";

/**
 * Ciclo de correção/estorno do ledger de atendimento (Fase 78, Fatia 1).
 * Contrato: docs/LEDGER_CORRECOES_ESPECIFICACAO.md (seções B, G, O–U).
 *
 * Fatia 1 (Fase 78): efeito contábil. Fatia 2 (Fase 80): efeito FÍSICO no estoque
 * — um único `stock_transactions` do tipo `ajuste` (delta com sinal), criado
 * na MESMA transação do ledger e vinculado a UMA linha (`correction`, ou a
 * `reversal` quando há retirada física opcional). O Modelo B não muda: toda
 * operação é um INSERT de linhas novas (`reversal`/`correction`).
 *
 * Fórmula de saldo: continua exclusivamente em `needFulfillment.tsx`
 * (`getNeedFulfillmentBalance`). `countedEffect` abaixo é só a projeção do
 * efeito de UMA linha, usada para decidir "reduz ou não" e para exibir o
 * histórico — nunca para recalcular saldo de necessidade.
 */

export const LEDGER_APPROVAL_ACTION_TYPES = ["correcao_recebimento", "estorno_recebimento"] as const;
export type LedgerApprovalActionType = (typeof LEDGER_APPROVAL_ACTION_TYPES)[number];

export function isLedgerApprovalActionType(value: string): value is LedgerApprovalActionType {
  return (LEDGER_APPROVAL_ACTION_TYPES as readonly string[]).includes(value);
}

export type LedgerLineState = "vigente" | "substituida" | "estornada" | "estorno";

export interface LedgerRow {
  id: string;
  entryType: "original" | "correction" | "reversal";
  needId: number | null;
  quantity: number;
  unit: string;
  isCountable: boolean;
  reversesFulfillmentId: string | null;
  createdByUserId: number | null;
  createdAt: Date;
  stockTransactionId: string | null;
}

/** Efeito contado de UMA linha (mesma regra da fórmula canônica). */
export function countedEffect(row: Pick<LedgerRow, "entryType" | "quantity" | "isCountable">): number {
  if (!row.isCountable) return 0;
  return row.entryType === "reversal" ? -row.quantity : row.quantity;
}

export interface LedgerChain {
  /** Linha que recebe a próxima operação (a vigente; ou a última estornada). `null` sem `original`. */
  head: LedgerRow | null;
  /** `ativa`: head conta/é a versão válida. `estornada`: head foi estornada e não há substituta. */
  headState: "ativa" | "estornada" | null;
  /**
   * Token de precondição otimista (`expectedVigenteFulfillmentId`): o id da
   * linha vigente quando a cadeia está ativa; o id da REVERSAL quando está
   * estornada. Qualquer operação que mude o estado da cadeia muda o token —
   * por isso um id igual significa "nada mudou desde que o cliente viu".
   */
  vigenteFulfillmentId: string | null;
  states: Map<string, LedgerLineState>;
  pairedReversals: Set<string>;
}

function idGreater(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b);
}

/**
 * Helper canônico da linha vigente (único lugar com este algoritmo). Cadeia
 * LINEAR a partir do `original`: se a linha atual tem uma `correction`
 * apontando para ela, a cadeia segue para essa correction (com ou sem a
 * `reversal` do par); senão a linha atual é o head. Nunca usa
 * MAX(created_at): o par reversal+correction tem o mesmo timestamp.
 */
export function resolveLedgerChain(rows: LedgerRow[]): LedgerChain {
  const original = rows.find((r) => r.entryType === "original");
  const states = new Map<string, LedgerLineState>();
  const pairedReversals = new Set<string>();
  if (!original) return { head: null, headState: null, vigenteFulfillmentId: null, states, pairedReversals };

  const reversalOf = new Map<string, LedgerRow>();
  const correctionOf = new Map<string, LedgerRow>();
  for (const row of rows) {
    if (row.reversesFulfillmentId === null) continue;
    if (row.entryType === "reversal") reversalOf.set(row.reversesFulfillmentId, row);
    else if (row.entryType === "correction") {
      const current = correctionOf.get(row.reversesFulfillmentId);
      if (!current || idGreater(row.id, current.id)) correctionOf.set(row.reversesFulfillmentId, row);
    }
  }

  let head = original;
  const seen = new Set<string>();
  while (!seen.has(head.id)) {
    seen.add(head.id);
    const next = correctionOf.get(head.id);
    if (!next) break;
    head = next;
  }

  const headReversal = reversalOf.get(head.id) ?? null;
  const headState: "ativa" | "estornada" = headReversal ? "estornada" : "ativa";

  for (const row of rows) {
    if (row.entryType === "reversal") {
      states.set(row.id, "estorno");
      if (row.reversesFulfillmentId && correctionOf.has(row.reversesFulfillmentId)) pairedReversals.add(row.id);
    } else if (row.id === head.id) {
      states.set(row.id, headState === "ativa" ? "vigente" : "estornada");
    } else {
      states.set(row.id, "substituida");
    }
  }

  return { head, headState, vigenteFulfillmentId: headReversal ? headReversal.id : head.id, states, pairedReversals };
}

export type LedgerOperationInput = { kind: "correcao"; quantity?: number; unit?: string } | { kind: "estorno"; withdrawStock?: boolean };

/** Efeito físico planejado (e, na execução, aplicado) de UMA operação. Sempre um único `ajuste`. */
export interface LedgerStockEffect {
  itemId: number;
  itemName: string;
  /** Delta com sinal (+ entrada / − saída), 3 casas, nunca 0. */
  delta: number;
  /** Saldo físico da allocation ANTES da operação (soma dos movimentos vinculados ao ledger dela). */
  saldoFisicoAllocation: number;
  /** Linha do ledger que carrega o movimento (a `correction`; ou a `reversal` na retirada física). */
  carrier: "correction" | "reversal";
  /** Saldo do item sob o lock, antes do movimento. */
  itemBalanceBefore: number;
}

export interface LedgerOperationPlan {
  organizationId: number;
  allocationId: number;
  needId: number | null;
  needQuantity: number | null;
  /** Quantidade alocada à organização (só para o indicador de excedente na auditoria; NÃO limita a operação). */
  quantidadeAlocada: number;
  operacao: "correcao" | "estorno";
  vigenteFulfillmentId: string;
  headState: "ativa" | "estornada";
  targetRowId: string;
  quantidadeAnterior: number;
  quantidadeNova: number;
  unidadeAnterior: string;
  unidadeNova: string;
  isCountableAnterior: boolean;
  isCountableNova: boolean;
  efeitoAnterior: number;
  efeitoNovo: number;
  createReversal: boolean;
  requiresApproval: boolean;
  unitMismatchNote: string | null;
  /** Delta físico planejado = executado (null quando não há movimento). */
  deltaFisicoPlanejado: number | null;
  itemId: number | null;
  stock: LedgerStockEffect | null;
  retiradaFisica: boolean;
}

export type LedgerPlanError =
  | { type: "not_found" }
  | { type: "nao_recebida" }
  | { type: "obsolete"; currentVigenteFulfillmentId: string | null }
  | { type: "ja_estornado" }
  | { type: "sem_alteracao" }
  | { type: "quantidade_e_unidade_juntas" }
  | { type: "sem_dados" }
  | { type: "insufficient_stock"; currentStock: number; itemName: string }
  | { type: "sem_saldo_fisico" }
  | { type: "unidade_incompativel" };

const QUANTITY_SCALE = 1000;
const sameQuantity = (a: number, b: number) => Math.round(a * QUANTITY_SCALE) === Math.round(b * QUANTITY_SCALE);

async function readLedgerRows(trx: Transaction<DB>, allocationId: number, lock: boolean): Promise<LedgerRow[]> {
  let query = trx
    .selectFrom("needFulfillments")
    .select(["id", "entryType", "needId", "quantity", "unit", "isCountable", "reversesFulfillmentId", "createdByUserId", "createdAt", "stockTransactionId"])
    .where("allocationId", "=", allocationId)
    .orderBy("id", "asc");
  if (lock) query = query.forUpdate();
  const rows = await query.execute();
  return rows.map((r) => ({
    id: String(r.id),
    entryType: r.entryType,
    needId: r.needId,
    quantity: Number(r.quantity),
    unit: r.unit,
    isCountable: r.isCountable,
    reversesFulfillmentId: r.reversesFulfillmentId === null ? null : String(r.reversesFulfillmentId),
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt,
    stockTransactionId: r.stockTransactionId === null ? null : String(r.stockTransactionId),
  }));
}

export { readLedgerRows };

/**
 * Trava na ORDEM GLOBAL (allocation → need → itens → ledger; o pedido de
 * aprovação, quando existe, já foi travado pelo chamador e a auditoria vem
 * por último), revalida o estado e devolve o plano — sem escrever nada.
 * Usado tanto na solicitação (direta ou com pedido) quanto na decisão.
 */
export async function lockAndPlanLedgerOperation(
  trx: Transaction<DB>,
  params: {
    organizationId: number;
    allocationId: number;
    expectedVigenteFulfillmentId: string;
    operation: LedgerOperationInput;
    /** Pedido da Fatia 1 (efeitoEstoque "nenhum") aprovado depois: executa só o contábil, como autorizado. */
    forceNoPhysical?: boolean;
  }
): Promise<{ type: "plan"; plan: LedgerOperationPlan } | LedgerPlanError> {
  const allocation = await trx
    .selectFrom("opportunityAllocations")
    .select(["id", "status", "quantityAllocated"])
    .where("id", "=", params.allocationId)
    .where("organizationId", "=", params.organizationId)
    .forUpdate()
    .executeTakeFirst();
  if (!allocation) return { type: "not_found" };
  if (allocation.status !== "recebida") return { type: "nao_recebida" };

  // A need é herdada do original e imutável (append-only): ler sem lock é
  // seguro; o lock da need vem ANTES do lock do ledger (ordem global).
  const originalRow = await trx
    .selectFrom("needFulfillments")
    .select(["needId"])
    .where("allocationId", "=", params.allocationId)
    .where("entryType", "=", "original")
    .executeTakeFirst();
  if (!originalRow) return { type: "nao_recebida" };

  let need: { quantityNeeded: number; unit: string } | null = null;
  if (originalRow.needId !== null) {
    // FOR NO KEY UPDATE (não FOR UPDATE): o recebimento insere em need_fulfillments (FK → needs = FOR KEY SHARE) DEPOIS de
    // travar o item; um FOR UPDATE aqui, antes do lock do item, fechava um ciclo (deadlock real, achado na Fase 80).
    const needRow = await trx.selectFrom("needs").select(["quantityNeeded", "unit"]).where("id", "=", originalRow.needId).forNoKeyUpdate().executeTakeFirst();
    if (needRow) need = { quantityNeeded: Number(needRow.quantityNeeded), unit: needRow.unit };
  }

  // Item físico do recebimento (o do movimento do `original`; imutável). O lock do
  // item vem DEPOIS da need e ANTES do ledger (ordem global: allocation → need →
  // itens → ledger → auditoria), a mesma ordem do recebimento e da decisão.
  let item: { id: number; name: string; unit: string } | null = null;
  const originalStock = await trx
    .selectFrom("needFulfillments")
    .innerJoin("stockTransactions", "stockTransactions.id", "needFulfillments.stockTransactionId")
    .select(["stockTransactions.itemId as itemId"])
    .where("needFulfillments.allocationId", "=", params.allocationId)
    .where("needFulfillments.entryType", "=", "original")
    .executeTakeFirst();
  if (originalStock) {
    const itemRow = await trx
      .selectFrom("inventoryItems")
      .select(["id", "name", "unit"])
      .where("id", "=", originalStock.itemId)
      .where("organizationId", "=", params.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!itemRow) return { type: "not_found" };
    item = itemRow;
  }

  const rows = await readLedgerRows(trx, params.allocationId, true);
  const chain = resolveLedgerChain(rows);
  if (!chain.head || !chain.headState || !chain.vigenteFulfillmentId) return { type: "nao_recebida" };
  if (chain.vigenteFulfillmentId !== params.expectedVigenteFulfillmentId) {
    return { type: "obsolete", currentVigenteFulfillmentId: chain.vigenteFulfillmentId };
  }

  const head = chain.head;
  const needId = originalRow.needId;
  const counts = head.isCountable && needId !== null;

  const itemId = item?.id ?? null;

  // Saldo físico REAL da allocation: soma dos movimentos efetivamente vinculados às
  // linhas dela (nem toda linha tem movimento; nunca se assume a quantidade da linha).
  const linkedIds = rows.map((r) => r.stockTransactionId).filter((v): v is string => v !== null);
  let saldoFisicoAllocation = 0;
  if (linkedIds.length > 0) {
    const sumRow = await trx
      .selectFrom("stockTransactions")
      .select((eb) => eb.fn.sum("delta").as("total"))
      .where("id", "in", linkedIds)
      .where("organizationId", "=", params.organizationId)
      .executeTakeFirst();
    saldoFisicoAllocation = Number(sumRow?.total ?? 0);
  }
  // Só há significado físico quando a unidade da linha é a do item (sem conversão).
  const unitMatchesItem = (lineUnit: string) => item !== null && normalize(lineUnit) === normalize(item.unit);
  const round3 = (n: number) => Math.round(n * QUANTITY_SCALE) / QUANTITY_SCALE;
  const buildStock = async (delta: number, carrier: "correction" | "reversal"): Promise<{ stock: LedgerStockEffect } | LedgerPlanError> => {
    const balance = await getItemStockBalance(trx, (item as { id: number }).id);
    if (delta < 0 && balance + delta < 0) return { type: "insufficient_stock", currentStock: balance, itemName: (item as { name: string }).name };
    return { stock: { itemId: (item as { id: number }).id, itemName: (item as { name: string }).name, delta, saldoFisicoAllocation, carrier, itemBalanceBefore: balance } };
  };

  const base = {
    organizationId: params.organizationId,
    allocationId: params.allocationId,
    needId,
    needQuantity: need?.quantityNeeded ?? null,
    quantidadeAlocada: Number(allocation.quantityAllocated),
    vigenteFulfillmentId: chain.vigenteFulfillmentId,
    headState: chain.headState,
    targetRowId: head.id,
    quantidadeAnterior: head.quantity,
    unidadeAnterior: head.unit,
    isCountableAnterior: head.isCountable,
    itemId,
  };

  if (params.operation.kind === "estorno") {
    if (chain.headState === "estornada") return { type: "ja_estornado" };
    // Retirada física opcional (P-L4): só o saldo físico REAL da allocation, inteiro.
    let stock: LedgerStockEffect | null = null;
    const withdraw = params.operation.withdrawStock === true && params.forceNoPhysical !== true;
    if (withdraw) {
      if (!unitMatchesItem(head.unit)) return { type: "unidade_incompativel" };
      if (saldoFisicoAllocation <= 0) return { type: "sem_saldo_fisico" };
      const built = await buildStock(-saldoFisicoAllocation, "reversal");
      if (!("stock" in built)) return built;
      stock = built.stock;
    }
    return {
      type: "plan",
      plan: {
        ...base,
        operacao: "estorno",
        quantidadeNova: head.quantity,
        unidadeNova: head.unit,
        isCountableNova: head.isCountable,
        efeitoAnterior: counts ? head.quantity : 0,
        efeitoNovo: 0,
        createReversal: true,
        requiresApproval: true,
        unitMismatchNote: null,
        deltaFisicoPlanejado: stock?.delta ?? null,
        stock,
        retiradaFisica: stock !== null,
      },
    };
  }

  const { quantity, unit } = params.operation;
  if (quantity === undefined && unit === undefined) return { type: "sem_dados" };

  const qtyChanged = quantity !== undefined && !sameQuantity(quantity, head.quantity);
  const unitChanged = unit !== undefined && normalize(unit) !== normalize(head.unit);
  if (qtyChanged && unitChanged) return { type: "quantidade_e_unidade_juntas" };

  const reactivating = chain.headState === "estornada";
  if (!qtyChanged && !unitChanged && !reactivating) return { type: "sem_alteracao" };

  const quantidadeNova = qtyChanged ? (quantity as number) : head.quantity;
  const unidadeNova = unitChanged ? (unit as string).trim() : head.unit;
  const isCountableNova = unitChanged ? (need ? normalize(unidadeNova) === normalize(need.unit) : true) : head.isCountable;
  const countsNova = isCountableNova && needId !== null;

  // Efeito contado ANTES: zero quando a cadeia está estornada (já anulada).
  const efeitoAnterior = reactivating ? 0 : counts ? head.quantity : 0;
  const efeitoNovo = countsNova ? quantidadeNova : 0;
  const createReversal = !reactivating && counts;

  // Redução = menos quantidade registrada OU menos efeito contado → exige
  // segunda pessoa (P-L5/P-L6). Aumento, reclassificação e reativação não.
  const reducesQuantity = !reactivating && qtyChanged && quantidadeNova < head.quantity;
  // Efeito físico (P-L3): a correção de QUANTIDADE (mesma unidade do item) leva o saldo
  // físico da allocation ao valor novo — UM ajuste pela diferença, nunca "saída tudo + entrada".
  // Unidade só reclassificada: sem movimento. Redução física exige segunda pessoa.
  let stock: LedgerStockEffect | null = null;
  if (params.forceNoPhysical !== true && !unitChanged && unitMatchesItem(head.unit)) {
    const delta = round3(quantidadeNova - saldoFisicoAllocation);
    if (delta !== 0) {
      const built = await buildStock(delta, "correction");
      if (!("stock" in built)) return built;
      stock = built.stock;
    }
  }
  const requiresApproval = reducesQuantity || efeitoNovo < efeitoAnterior || (stock !== null && stock.delta < 0);

  const unitMismatchNote =
    !isCountableNova && need
      ? `Unidade da correção ("${unidadeNova}") diverge da unidade da necessidade ("${need.unit}") — is_countable=false para nunca somar unidades incompatíveis.`
      : null;

  return {
    type: "plan",
    plan: {
      ...base,
      operacao: "correcao",
      quantidadeNova,
      unidadeNova,
      isCountableNova,
      efeitoAnterior,
      efeitoNovo,
      createReversal,
      requiresApproval,
      unitMismatchNote,
      deltaFisicoPlanejado: stock?.delta ?? null,
      stock,
      retiradaFisica: false,
    },
  };
}

export interface LedgerExecutionResult {
  reversalFulfillmentId: string | null;
  fulfillmentId: string;
  stockTransactionId: string | null;
  itemBalanceAfter: number | null;
  needId: number | null;
  progressBefore: { fulfilled: number; requiredRemaining: number; surplus: number } | null;
  progressAfter: { fulfilled: number; requiredRemaining: number; surplus: number } | null;
}

/**
 * Escreve o plano (já travado e validado): primeiro o movimento físico (se houver),
 * depois as linhas do ledger — na MESMA transação do chamador (tudo ou nada).
 */
export async function executeLedgerPlan(trx: Transaction<DB>, plan: LedgerOperationPlan, createdByUserId: number, motivo: string): Promise<LedgerExecutionResult> {
  const before = plan.needId !== null && plan.needQuantity !== null ? computeNeedProgress(plan.needQuantity, await getNeedFulfillmentBalance(trx, plan.needId)) : null;

  let stockTransactionId: string | null = null;
  let itemBalanceAfter: number | null = null;
  if (plan.stock) {
    const reason =
      plan.operacao === "estorno"
        ? `Retirada física do estorno do recebimento da atribuição #${plan.allocationId}: ${motivo}`
        : `Ajuste da correção do recebimento da atribuição #${plan.allocationId} (${plan.stock.saldoFisicoAllocation} → ${plan.stock.saldoFisicoAllocation + plan.stock.delta}): ${motivo}`;
    const [tx] = await trx
      .insertInto("stockTransactions")
      .values({ organizationId: plan.organizationId, itemId: plan.stock.itemId, type: "ajuste", delta: plan.stock.delta, reason, createdByUserId })
      .returning(["id"])
      .execute();
    stockTransactionId = String(tx.id);
    itemBalanceAfter = await getItemStockBalance(trx, plan.stock.itemId);
    // Nunca negativo (o plano já validou sob o lock; esta é a trava final, desfaz tudo).
    if (itemBalanceAfter < 0) throw new Error("estoque ficaria negativo");
  }

  let reversalFulfillmentId: string | null = null;
  let fulfillmentId = "";

  if (plan.createReversal) {
    const [reversal] = await trx
      .insertInto("needFulfillments")
      .values({
        organizationId: plan.organizationId,
        needId: plan.needId,
        allocationId: plan.allocationId,
        stockTransactionId: plan.stock?.carrier === "reversal" ? stockTransactionId : null,
        quantity: plan.quantidadeAnterior,
        unit: plan.unidadeAnterior,
        isCountable: plan.isCountableAnterior,
        createdByUserId,
        entryType: "reversal",
        reversesFulfillmentId: plan.targetRowId,
      })
      .returning(["id"])
      .execute();
    reversalFulfillmentId = String(reversal.id);
    fulfillmentId = reversalFulfillmentId;
  }

  if (plan.operacao === "correcao") {
    const [correction] = await trx
      .insertInto("needFulfillments")
      .values({
        organizationId: plan.organizationId,
        needId: plan.needId,
        allocationId: plan.allocationId,
        stockTransactionId: plan.stock?.carrier === "correction" ? stockTransactionId : null,
        quantity: plan.quantidadeNova,
        unit: plan.unidadeNova,
        isCountable: plan.isCountableNova,
        unitMismatchNote: plan.unitMismatchNote,
        createdByUserId,
        entryType: "correction",
        reversesFulfillmentId: plan.targetRowId,
      })
      .returning(["id"])
      .execute();
    fulfillmentId = String(correction.id);
  }

  const after = plan.needId !== null && plan.needQuantity !== null ? computeNeedProgress(plan.needQuantity, await getNeedFulfillmentBalance(trx, plan.needId)) : null;
  return { reversalFulfillmentId, fulfillmentId, stockTransactionId, itemBalanceAfter, needId: plan.needId, progressBefore: before, progressAfter: after };
}

export function buildLedgerAuditEntry(
  plan: LedgerOperationPlan,
  result: LedgerExecutionResult,
  ctx: { actorUserId: number; reason: string; approvalRequestId?: number; requesterUserId?: number }
): { action: string; metadata: Json } {
  const fulfillmentIds = [result.reversalFulfillmentId, result.fulfillmentId].filter((v): v is string => v !== null && v !== "");
  const base: Record<string, Json> = {
    allocationId: plan.allocationId,
    needId: plan.needId,
    fulfillmentId: result.fulfillmentId,
    fulfillmentIds,
    alvoFulfillmentId: plan.targetRowId,
    quantidadeAnterior: plan.quantidadeAnterior,
    quantidadeNova: plan.operacao === "estorno" ? 0 : plan.quantidadeNova,
    unidadeAnterior: plan.unidadeAnterior,
    unidadeNova: plan.operacao === "estorno" ? plan.unidadeAnterior : plan.unidadeNova,
    efeitoNoSaldoAnterior: plan.efeitoAnterior,
    efeitoNoSaldoNovo: plan.efeitoNovo,
    excedenteAnterior: result.progressBefore?.surplus ?? 0,
    excedente: result.progressAfter?.surplus ?? 0,
    // indicador de excedente em relação ao ALOCADO (política de excedentes: permitido, mas identificável)
    quantidadeAlocada: plan.quantidadeAlocada,
    acimaDaAlocacao: (plan.operacao === "estorno" ? 0 : plan.quantidadeNova) > plan.quantidadeAlocada,
    excedenteAlocacao: Math.max(0, Math.round(((plan.operacao === "estorno" ? 0 : plan.quantidadeNova) - plan.quantidadeAlocada) * 1000) / 1000),
    efeitoEstoque: plan.stock ? "ajuste" : "nenhum",
    motivo: ctx.reason,
  };
  if (plan.stock) {
    base.stockTransactionId = result.stockTransactionId;
    base.deltaFisico = plan.stock.delta;
    base.itemId = plan.stock.itemId;
    base.unidade = plan.unidadeAnterior;
    base.saldoFisicoAllocationAntes = plan.stock.saldoFisicoAllocation;
    base.saldoEstoqueAntes = plan.stock.itemBalanceBefore;
    base.saldoEstoqueApos = result.itemBalanceAfter;
    base.retiradaFisica = plan.retiradaFisica;
  }
  if (plan.operacao === "correcao") base.reverteuFulfillmentId = result.reversalFulfillmentId;
  if (ctx.approvalRequestId !== undefined) base.approvalRequestId = ctx.approvalRequestId;
  if (ctx.requesterUserId !== undefined) base.solicitanteUserId = ctx.requesterUserId;
  return {
    action: plan.operacao === "estorno" ? "atribuicao.recebimento_estornado" : "atribuicao.recebimento_corrigido",
    metadata: base,
  };
}

export const ledgerApprovalPayloadSchema = z.object({
  organizationId: z.number().int().positive(),
  allocationId: z.number().int().positive(),
  operacao: z.enum(["correcao", "estorno"]),
  targetFulfillmentId: z.string().regex(/^\d+$/),
  headState: z.enum(["ativa", "estornada"]),
  alvoLinhaId: z.string().regex(/^\d+$/),
  quantidadeAnterior: z.number(),
  quantidadeNova: z.number(),
  unidadeAnterior: z.string(),
  unidadeNova: z.string(),
  isCountableResultante: z.boolean(),
  efeitoEstoque: z.enum(["nenhum", "ajuste"]),
  deltaFisicoPlanejado: z.number().nullable(),
  retiradaFisica: z.boolean().optional(),
  saldoFisicoAllocation: z.number().nullable().optional(),
  itemId: z.number().int().nullable(),
  motivo: z.string(),
  solicitadoEm: z.string(),
});
export type LedgerApprovalPayload = z.infer<typeof ledgerApprovalPayloadSchema>;

function describeOperation(plan: LedgerOperationPlan, motivo: string): string {
  const head =
    plan.operacao === "estorno"
      ? `Estorno do recebimento da atribuição #${plan.allocationId} (${plan.quantidadeAnterior} ${plan.unidadeAnterior})`
      : `Correção do recebimento da atribuição #${plan.allocationId}: ${plan.quantidadeAnterior} ${plan.unidadeAnterior} → ${plan.quantidadeNova} ${plan.unidadeNova}`;
  return `${head}. Motivo: ${motivo}`;
}

export type SubmitLedgerResult =
  | { type: "executed"; plan: LedgerOperationPlan; result: LedgerExecutionResult }
  | { type: "pending_approval"; approvalRequestId: number; plan: LedgerOperationPlan }
  | { type: "pedido_pendente"; approvalRequestId: number }
  | LedgerPlanError;

/**
 * Solicitação (uma transação curta, chamada dentro de `db.transaction()`):
 * trava, valida e (a) executa direto quando não reduz ou (b) grava um pedido
 * de aprovação — nunca espera uma pessoa com a transação aberta. A auditoria
 * é o ÚLTIMO passo.
 */
export async function submitLedgerOperation(
  trx: Transaction<DB>,
  params: {
    organizationId: number;
    allocationId: number;
    expectedVigenteFulfillmentId: string;
    operation: LedgerOperationInput;
    reason: string;
    actorUserId: number;
  }
): Promise<SubmitLedgerResult> {
  const planned = await lockAndPlanLedgerOperation(trx, params);
  if (planned.type !== "plan") return planned;
  const plan = planned.plan;

  if (plan.requiresApproval) {
    // Sob o lock da allocation: no máximo UM pedido pendente por allocation.
    const pending = await trx
      .selectFrom("approvalRequests")
      .select(["id"])
      .where("organizationId", "=", params.organizationId)
      .where("status", "=", "pendente")
      .where("actionType", "in", [...LEDGER_APPROVAL_ACTION_TYPES])
      .where(sql<boolean>`payload->>'allocationId' = ${String(params.allocationId)}`)
      .executeTakeFirst();
    if (pending) return { type: "pedido_pendente", approvalRequestId: pending.id };

    const payload: LedgerApprovalPayload = {
      organizationId: plan.organizationId,
      allocationId: plan.allocationId,
      operacao: plan.operacao,
      targetFulfillmentId: plan.vigenteFulfillmentId,
      headState: plan.headState,
      alvoLinhaId: plan.targetRowId,
      quantidadeAnterior: plan.quantidadeAnterior,
      quantidadeNova: plan.operacao === "estorno" ? 0 : plan.quantidadeNova,
      unidadeAnterior: plan.unidadeAnterior,
      unidadeNova: plan.operacao === "estorno" ? plan.unidadeAnterior : plan.unidadeNova,
      isCountableResultante: plan.isCountableNova,
      efeitoEstoque: plan.stock ? "ajuste" : "nenhum",
      deltaFisicoPlanejado: plan.deltaFisicoPlanejado,
      retiradaFisica: plan.retiradaFisica,
      saldoFisicoAllocation: plan.stock?.saldoFisicoAllocation ?? null,
      itemId: plan.itemId,
      motivo: params.reason,
      solicitadoEm: new Date().toISOString(),
    };
    const approval = await createApprovalRequest(
      {
        actionType: plan.operacao === "estorno" ? "estorno_recebimento" : "correcao_recebimento",
        organizationId: params.organizationId,
        payload,
        reason: describeOperation(plan, params.reason),
        requestedByUserId: params.actorUserId,
      },
      trx
    );
    await recordAuditLogEntry(
      {
        organizationId: params.organizationId,
        actorUserId: params.actorUserId,
        action: "atribuicao.recebimento_pendente_aprovacao",
        entityType: "opportunity_allocation",
        entityId: String(params.allocationId),
        metadata: { approvalRequestId: approval.id, operacao: plan.operacao, allocationId: params.allocationId, alvoFulfillmentId: plan.targetRowId, motivo: params.reason },
      },
      trx
    );
    return { type: "pending_approval", approvalRequestId: approval.id, plan };
  }

  const result = await executeLedgerPlan(trx, plan, params.actorUserId, params.reason);
  const audit = buildLedgerAuditEntry(plan, result, { actorUserId: params.actorUserId, reason: params.reason });
  await recordAuditLogEntry(
    {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      action: audit.action,
      entityType: "opportunity_allocation",
      entityId: String(params.allocationId),
      metadata: audit.metadata,
    },
    trx
  );
  return { type: "executed", plan, result };
}

export type ApprovedLedgerResult =
  | { type: "executed"; plan: LedgerOperationPlan; result: LedgerExecutionResult; payload: LedgerApprovalPayload }
  | { type: "payload_invalid" }
  | { type: "pedido_obsoleto" }
  | { type: "insufficient_stock"; currentStock: number; itemName: string };

/**
 * Execução de um pedido APROVADO, dentro da transação da decisão (o pedido
 * já está travado pelo chamador — 1º da ordem de locks). Lê SOMENTE o
 * payload gravado; nada vem do cliente. Qualquer divergência entre o estado
 * atual e o do pedido → `pedido_obsoleto`, sem escrever nada (o pedido
 * continua pendente). A auditoria da execução é gravada pelo chamador por
 * último, via `buildLedgerAuditEntry`.
 */
export async function executeApprovedLedgerRequest(
  trx: Transaction<DB>,
  request: { id: number; organizationId: number | null; actionType: string; payload: Json; requestedByUserId: number }
): Promise<ApprovedLedgerResult> {
  const parsed = ledgerApprovalPayloadSchema.safeParse(request.payload);
  if (!parsed.success || request.organizationId === null || parsed.data.organizationId !== request.organizationId) return { type: "payload_invalid" };
  const payload = parsed.data;
  if ((payload.operacao === "estorno") !== (request.actionType === "estorno_recebimento")) return { type: "payload_invalid" };

  const operation: LedgerOperationInput =
    payload.operacao === "estorno"
      ? { kind: "estorno", withdrawStock: payload.retiradaFisica === true }
      : { kind: "correcao", quantity: payload.quantidadeNova, unit: payload.unidadeNova };

  const planned = await lockAndPlanLedgerOperation(trx, {
    organizationId: payload.organizationId,
    allocationId: payload.allocationId,
    expectedVigenteFulfillmentId: payload.targetFulfillmentId,
    operation,
    // Pedido criado na Fatia 1 (sem efeito físico autorizado): executa SÓ o contábil.
    forceNoPhysical: payload.efeitoEstoque === "nenhum",
  });
  // Estoque que deixou de comportar a saída: o pedido continua pendente (nada executa).
  if (planned.type === "insufficient_stock") return planned;
  if (planned.type !== "plan") return { type: "pedido_obsoleto" };
  const plan = planned.plan;

  // O estado atual precisa reproduzir EXATAMENTE o que foi solicitado.
  const sameAsRequested =
    plan.headState === payload.headState &&
    plan.targetRowId === payload.alvoLinhaId &&
    plan.operacao === payload.operacao &&
    sameQuantity(plan.quantidadeAnterior, payload.quantidadeAnterior) &&
    plan.unidadeAnterior === payload.unidadeAnterior &&
    plan.isCountableNova === payload.isCountableResultante &&
    plan.requiresApproval &&
    // O efeito físico aprovado é EXATAMENTE o executado: mesmo item, mesmo delta, mesmo saldo físico.
    (plan.stock?.itemId ?? null) === (payload.efeitoEstoque === "ajuste" ? payload.itemId : null) &&
    sameQuantity(plan.stock?.delta ?? 0, payload.efeitoEstoque === "ajuste" ? (payload.deltaFisicoPlanejado ?? 0) : 0) &&
    (payload.efeitoEstoque !== "ajuste" || sameQuantity(plan.stock?.saldoFisicoAllocation ?? 0, payload.saldoFisicoAllocation ?? 0)) &&
    (plan.retiradaFisica === (payload.retiradaFisica === true));
  if (!sameAsRequested) return { type: "pedido_obsoleto" };

  const result = await executeLedgerPlan(trx, plan, request.requestedByUserId, payload.motivo);
  return { type: "executed", plan, result, payload };
}

/**
 * Resposta HTTP padrão para os erros de planejamento/solicitação. Corpo
 * `{ message, code }` — `code` é estável e é o que o cliente deve comparar
 * (nunca o texto). Sem dado de outra organização.
 */
export function ledgerErrorResponse(error: LedgerPlanError | { type: "pedido_pendente"; approvalRequestId: number }): Response {
  const make = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
    new Response(superjson.stringify({ message, code, ...extra }), { status, headers: { "Content-Type": "application/json" } });
  switch (error.type) {
    case "not_found":
      return make(404, "atribuicao_nao_encontrada", "Atribuição não encontrada");
    case "nao_recebida":
      return make(409, "nao_recebida", "Esta atribuição ainda não tem um recebimento registrado");
    case "obsolete":
      return make(409, "recebimento_alterado", "O recebimento foi alterado por outra operação. Recarregue o histórico antes de tentar de novo.", {
        currentVigenteFulfillmentId: error.currentVigenteFulfillmentId,
      });
    case "ja_estornado":
      return make(409, "ja_estornado", "Este recebimento já está estornado");
    case "sem_alteracao":
      return make(422, "sem_alteracao", "A correção não altera nada: quantidade e unidade já são as registradas");
    case "quantidade_e_unidade_juntas":
      return make(422, "quantidade_e_unidade_juntas", "Corrija a quantidade e a unidade em operações separadas");
    case "sem_dados":
      return make(422, "sem_dados", "Informe a nova quantidade ou a nova unidade");
    case "insufficient_stock":
      return make(409, "insufficient_stock", `Estoque insuficiente: saldo atual é ${error.currentStock}, a saída solicitada deixaria o saldo negativo`, { currentStock: error.currentStock });
    case "sem_saldo_fisico":
      return make(422, "sem_saldo_fisico", "Esta atribuição não tem saldo físico a retirar do estoque: use o estorno só contábil");
    case "unidade_incompativel":
      return make(422, "unidade_incompativel", "A unidade do recebimento difere da do item de estoque: a retirada física exigiria conversão, que não existe");
    case "pedido_pendente":
      return make(409, "pedido_pendente", "Já existe um pedido de aprovação pendente para este recebimento", { approvalRequestId: error.approvalRequestId });
  }
}
