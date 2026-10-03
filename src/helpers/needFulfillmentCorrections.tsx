import type { Transaction } from "kysely";
import { sql } from "kysely";
import { z } from "zod";
import type { DB, Json } from "./schema.js";
import { normalize } from "./opportunityMatching.js";
import { computeNeedProgress, getNeedFulfillmentBalance } from "./needFulfillment.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { createApprovalRequest } from "./approvals.js";
import superjson from "superjson";

/**
 * Ciclo de correção/estorno do ledger de atendimento (Fase 78, Fatia 1).
 * Contrato: docs/LEDGER_CORRECOES_ESPECIFICACAO.md (seções B, G, O–U).
 *
 * Esta fatia é SÓ CONTÁBIL: nenhuma função aqui cria `stock_transactions`
 * (o efeito físico de correção/estorno é a Fatia 2). O Modelo B não muda:
 * toda operação é um INSERT de linhas novas (`reversal`/`correction`).
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

export type LedgerOperationInput = { kind: "correcao"; quantity?: number; unit?: string } | { kind: "estorno" };

export interface LedgerOperationPlan {
  organizationId: number;
  allocationId: number;
  needId: number | null;
  needQuantity: number | null;
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
  /** Dado de planejamento para a Fatia 2 (não executado nesta fatia). */
  deltaFisicoPlanejado: number | null;
  itemId: number | null;
}

export type LedgerPlanError =
  | { type: "not_found" }
  | { type: "nao_recebida" }
  | { type: "obsolete"; currentVigenteFulfillmentId: string | null }
  | { type: "ja_estornado" }
  | { type: "sem_alteracao" }
  | { type: "quantidade_e_unidade_juntas" }
  | { type: "sem_dados" };

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
  params: { organizationId: number; allocationId: number; expectedVigenteFulfillmentId: string; operation: LedgerOperationInput }
): Promise<{ type: "plan"; plan: LedgerOperationPlan } | LedgerPlanError> {
  const allocation = await trx
    .selectFrom("opportunityAllocations")
    .select(["id", "status"])
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
    const needRow = await trx.selectFrom("needs").select(["quantityNeeded", "unit"]).where("id", "=", originalRow.needId).forUpdate().executeTakeFirst();
    if (needRow) need = { quantityNeeded: Number(needRow.quantityNeeded), unit: needRow.unit };
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

  const original = rows.find((r) => r.entryType === "original");
  let itemId: number | null = null;
  if (original?.stockTransactionId) {
    const stockRow = await trx.selectFrom("stockTransactions").select(["itemId"]).where("id", "=", original.stockTransactionId).executeTakeFirst();
    itemId = stockRow?.itemId ?? null;
  }

  const base = {
    organizationId: params.organizationId,
    allocationId: params.allocationId,
    needId,
    needQuantity: need?.quantityNeeded ?? null,
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
        deltaFisicoPlanejado: null,
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
  const requiresApproval = reducesQuantity || efeitoNovo < efeitoAnterior;

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
      deltaFisicoPlanejado: unitChanged || !qtyChanged ? null : quantidadeNova - head.quantity,
    },
  };
}

export interface LedgerExecutionResult {
  reversalFulfillmentId: string | null;
  fulfillmentId: string;
  needId: number | null;
  progressBefore: { fulfilled: number; requiredRemaining: number; surplus: number } | null;
  progressAfter: { fulfilled: number; requiredRemaining: number; surplus: number } | null;
}

/** Escreve as linhas do plano (já travado/validado). SEM estoque físico nesta fatia. */
export async function executeLedgerPlan(trx: Transaction<DB>, plan: LedgerOperationPlan, createdByUserId: number): Promise<LedgerExecutionResult> {
  const before = plan.needId !== null && plan.needQuantity !== null ? computeNeedProgress(plan.needQuantity, await getNeedFulfillmentBalance(trx, plan.needId)) : null;

  let reversalFulfillmentId: string | null = null;
  let fulfillmentId = "";

  if (plan.createReversal) {
    const [reversal] = await trx
      .insertInto("needFulfillments")
      .values({
        organizationId: plan.organizationId,
        needId: plan.needId,
        allocationId: plan.allocationId,
        stockTransactionId: null,
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
        stockTransactionId: null,
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
  return { reversalFulfillmentId, fulfillmentId, needId: plan.needId, progressBefore: before, progressAfter: after };
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
    efeitoEstoque: "nenhum",
    motivo: ctx.reason,
  };
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
  efeitoEstoque: z.literal("nenhum"),
  deltaFisicoPlanejado: z.number().nullable(),
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
      efeitoEstoque: "nenhum",
      deltaFisicoPlanejado: plan.deltaFisicoPlanejado,
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

  const result = await executeLedgerPlan(trx, plan, params.actorUserId);
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
  | { type: "pedido_obsoleto" };

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
    payload.operacao === "estorno" ? { kind: "estorno" } : { kind: "correcao", quantity: payload.quantidadeNova, unit: payload.unidadeNova };

  const planned = await lockAndPlanLedgerOperation(trx, {
    organizationId: payload.organizationId,
    allocationId: payload.allocationId,
    expectedVigenteFulfillmentId: payload.targetFulfillmentId,
    operation,
  });
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
    plan.requiresApproval;
  if (!sameAsRequested) return { type: "pedido_obsoleto" };

  const result = await executeLedgerPlan(trx, plan, request.requestedByUserId);
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
    case "pedido_pendente":
      return make(409, "pedido_pendente", "Já existe um pedido de aprovação pendente para este recebimento", { approvalRequestId: error.approvalRequestId });
  }
}
