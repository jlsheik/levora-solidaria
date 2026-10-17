/**
 * Fase 99G — núcleo transacional das CORREÇÕES e REVERSÕES de destinação. Nada é editado nem apagado: cada operação é um evento novo em `stock_destinations` (`correction` ou `reversal`)
 * apontando para a destinação ORIGINAL. Quatro situações distintas (docs/DESTINACAO_E_PRESTACAO_DE_CONTAS_ESPECIFICACAO.md, seção 9):
 *   - correção documental (`correction`)      : só campos DESCRITIVOS (data efetiva, pessoas atendidas, observações); NUNCA movimenta estoque nem muda atendimento;
 *   - estorno documental (`reversal`)         : o registro estava errado, a entrega ocorreu; SEM movimento físico (não cria saldo fictício); compensa o atendimento contabilizável;
 *   - devolução física (`reversal`)           : o recurso VOLTOU; cria uma ENTRADA de estoque (mesma transação) ligada à reversão;
 *   - correção de quantidade (`reversal`)     : parte do recurso nunca saiu; cria um AJUSTE positivo (mesma transação) ligado à reversão.
 * A soma das reversões de uma original nunca passa da quantidade dela (gatilho do banco, sob a trava da original); aqui a regra é checada antes só para devolver um erro claro.
 *
 * ORDEM DE TRAVAS (a mesma da 99E): chave de idempotência (consultiva) → item (FOR UPDATE) → necessidade (FOR NO KEY UPDATE) → linha da destinação original (FOR UPDATE) → [linhas criadas] →
 * auditoria (sempre por último, por causa do advisory lock global da cadeia de auditoria). Sempre recalcula o atendimento da necessidade a partir das destinações válidas
 * (`needAttendance`), nunca por soma incremental.
 */
import { createHash } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { DB } from "./schema.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { roundQuantity } from "./quantityRules.js";
import { checkEffectiveDate, MAX_RETROACTIVE_DAYS } from "./businessDate.js";
import { computeAttendanceProgress, getNeedAttendance } from "./needAttendance.js";
import { isAttendanceType, REASON_REQUIRED_TYPES, NOTES_MIN_WHEN_REQUIRED, type DestinationType } from "./destinationRules.js";
import { classifyUnit } from "./unitVocabulary.js";
import { serverNow } from "./stockExit.js";

export const REVERSAL_KINDS = ["estorno_documental", "devolucao_fisica", "correcao_quantidade"] as const;
export type ReversalKind = (typeof REVERSAL_KINDS)[number];

export const REVERSAL_KIND_LABELS: Record<ReversalKind, { label: string; description: string; physical: boolean }> = {
  estorno_documental: { label: "Estorno documental", description: "O registro estava errado, mas a entrega ocorreu. NÃO devolve nada ao estoque.", physical: false },
  devolucao_fisica: { label: "Devolução física", description: "O material voltou ao estoque. Cria uma ENTRADA de estoque da mesma quantidade.", physical: true },
  correcao_quantidade: { label: "Correção de quantidade", description: "Parte do material nunca saiu. Cria um AJUSTE positivo de estoque da mesma quantidade.", physical: true },
};

export type CorrectionErrorCode =
  | "destinacao_nao_encontrada"
  | "item_nao_encontrado"
  | "unidade_divergente"
  | "excede_reversivel"
  | "devolucao_fisica_exige_saida"
  | "sem_permissao_para_corrigir"
  | "sem_alteracao"
  | "campo_nao_aplicavel"
  | "notas_obrigatorias"
  | "data_futura"
  | "data_invalida"
  | "retroativa_exige_autorizacao"
  | "retroativa_exige_justificativa";

export type CorrectionFailure = { type: "error"; code: CorrectionErrorCode; status: number; message: string; details?: Record<string, unknown> };
const fail = (code: CorrectionErrorCode, status: number, message: string, details?: Record<string, unknown>): CorrectionFailure => ({ type: "error", code, status, message, details });

export interface ReversalInput {
  organizationId: number;
  destinationId: string;
  kind: ReversalKind;
  quantity: number;
  reason: string;
}

export interface CorrectionInput {
  organizationId: number;
  destinationId: string;
  deliveredOn: string | null;
  peopleServed: number | null;
  peopleUnit: "familias" | "pessoas" | null;
  notes: string | null;
  lateRegistrationReason: string | null;
  reason: string;
}

/** Hash canônico (a chave de idempotência fica de fora): mesmo conteúdo, mesmo hash; qualquer campo diferente, outro. O tipo da operação entra no hash. */
export function hashReversalInput(input: ReversalInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ op: "reversal", organizationId: input.organizationId, destinationId: input.destinationId, kind: input.kind, quantity: roundQuantity(input.quantity), reason: input.reason.trim() }))
    .digest("hex");
}

export function hashCorrectionInput(input: CorrectionInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        op: "correction",
        organizationId: input.organizationId,
        destinationId: input.destinationId,
        deliveredOn: input.deliveredOn,
        peopleServed: input.peopleServed,
        peopleUnit: input.peopleUnit,
        notes: input.notes ?? null,
        lateRegistrationReason: input.lateRegistrationReason ?? null,
        reason: input.reason.trim(),
      })
    )
    .digest("hex");
}

export interface NeedEffect {
  needId: number;
  title: string;
  attendedBefore: number;
  attendedAfter: number;
  requested: number;
  remainingAfter: number;
  /** A necessidade estava `atendida` pelo fluxo estruturado e voltou a `aberta` nesta mesma transação. */
  reopened: boolean;
}

export interface ReversalApplied {
  type: "ok";
  eventId: string;
  kind: ReversalKind;
  quantity: number;
  stockTransactionId: string | null;
  physicalMovement: "entrada" | "ajuste" | null;
  reversedTotal: number;
  reversibleAfter: number;
  newStock: number | null;
  itemName: string;
  unit: string;
  need: NeedEffect | null;
  target: { id: string; itemId: number; needId: number | null; isCountable: boolean };
}

export interface CorrectionApplied {
  type: "ok";
  eventId: string;
  changes: Record<string, { de: unknown; para: unknown }>;
  target: { id: string; itemId: number };
}

const sumReversed = async (trx: Transaction<DB>, destinationId: string) => {
  const r = await trx
    .selectFrom("stockDestinations")
    .select((eb) => eb.fn.coalesce(eb.fn.sum<string>("quantity"), eb.val("0")).as("t"))
    .where("entryType", "=", "reversal")
    .where("reversesDestinationId", "=", destinationId)
    .executeTakeFirstOrThrow();
  return roundQuantity(Number(r.t));
};

/** Reverte (total ou parcialmente) uma destinação. Quem chama já validou permissão e idempotência e audita por último com `auditReversal`. */
export async function reverseDestination(trx: Transaction<DB>, input: ReversalInput, actorUserId: number): Promise<ReversalApplied | CorrectionFailure> {
  const target = await trx
    .selectFrom("stockDestinations")
    .select(["id", "entryType", "itemId", "needId", "stockTransactionId", "quantity", "unit", "isCountable", "destinationType"])
    .where("id", "=", input.destinationId)
    .where("organizationId", "=", input.organizationId)
    .executeTakeFirst();
  if (!target || target.entryType !== "original") return fail("destinacao_nao_encontrada", 404, "Destinação não encontrada nesta organização");

  // 1) item, 2) necessidade, 3) a própria destinação — a ordem da 99E
  const item = await trx.selectFrom("inventoryItems").select(["id", "name", "unit"]).where("id", "=", target.itemId).where("organizationId", "=", input.organizationId).forUpdate().executeTakeFirst();
  if (!item) return fail("item_nao_encontrado", 404, "Item de inventário não encontrado nesta organização");
  let need: { id: number; title: string; status: string; quantityNeeded: string } | undefined;
  if (target.needId !== null) {
    need = await trx.selectFrom("needs").select(["id", "title", "status", "quantityNeeded"]).where("id", "=", target.needId).where("organizationId", "=", input.organizationId).forNoKeyUpdate().executeTakeFirst();
  }
  await trx.selectFrom("stockDestinations").select("id").where("id", "=", target.id).forUpdate().execute();

  // a unidade do item precisa ser ainda a da destinação (nenhuma conversão): senão é caso de regularização de unidades, não de estorno por suposição
  const unit = classifyUnit(item.unit);
  if (item.unit !== target.unit || unit.kind !== "canonica" || unit.canonicalLabel !== item.unit) {
    return fail("unidade_divergente", 409, `A unidade atual do item ("${item.unit.trim()}") não é a da destinação ("${target.unit}"). Use o procedimento de regularização de unidades antes de reverter.`);
  }

  const originalQty = Number(target.quantity);
  const reversed = await sumReversed(trx, target.id);
  const reversible = roundQuantity(originalQty - reversed);
  if (reversible <= 0) return fail("excede_reversivel", 409, "Esta destinação já foi revertida por inteiro", { quantidadeOriginal: originalQty, jaRevertido: reversed, reversivel: 0 });
  if (input.quantity > reversible) {
    return fail("excede_reversivel", 409, `A quantidade (${input.quantity} ${target.unit}) excede o que ainda pode ser revertido desta destinação: ${reversible} ${target.unit}`, {
      quantidadeOriginal: originalQty,
      jaRevertido: reversed,
      reversivel: reversible,
    });
  }

  const physical = REVERSAL_KIND_LABELS[input.kind].physical;
  let movementId: string | null = null;
  let movementType: "entrada" | "ajuste" | null = null;
  if (physical) {
    const origTx = await trx.selectFrom("stockTransactions").select(["id", "type"]).where("id", "=", target.stockTransactionId!).executeTakeFirstOrThrow();
    // devolução física desfaz uma SAÍDA física; um ajuste negativo apenas classificado como perda/descarte não saiu por esta destinação
    if (input.kind === "devolucao_fisica" && origTx.type !== "saida") {
      return fail("devolucao_fisica_exige_saida", 409, "Esta destinação classifica um ajuste de estoque, não uma saída física: use estorno documental ou correção de quantidade");
    }
    movementType = input.kind === "devolucao_fisica" ? "entrada" : "ajuste";
    const reasonPrefix = input.kind === "devolucao_fisica" ? "Devolução física da destinação" : "Correção de quantidade da destinação";
    const [tx] = await trx
      .insertInto("stockTransactions")
      .values({ organizationId: input.organizationId, itemId: target.itemId, type: movementType, delta: input.quantity, reason: `${reasonPrefix} #${target.id}: ${input.reason.trim()}`, createdByUserId: actorUserId })
      .returning(["id"])
      .execute();
    movementId = String(tx.id);
  }

  const attendedBefore = need && target.isCountable ? (await getNeedAttendance(trx, need.id)).appliedNet : 0;

  const [event] = await trx
    .insertInto("stockDestinations")
    .values({
      organizationId: input.organizationId,
      entryType: "reversal",
      itemId: target.itemId,
      stockTransactionId: movementId,
      quantity: input.quantity,
      unit: target.unit,
      reversesDestinationId: target.id,
      reversalKind: input.kind,
      reason: input.reason.trim(),
      createdByUserId: actorUserId,
    } as never)
    .returning(["id"])
    .execute();

  // atendimento RECALCULADO das destinações válidas; a transição de estado acontece na MESMA transação
  let needEffect: NeedEffect | null = null;
  if (need && target.isCountable) {
    const after = await getNeedAttendance(trx, need.id);
    const progress = computeAttendanceProgress(Number(need.quantityNeeded), after, need.status as "aberta" | "atendida" | "cancelada");
    let reopened = false;
    if (need.status === "atendida" && progress.remaining > 0) {
      // só `atendida` pelo fluxo ESTRUTURADO (tem destinação e nunca passou por resolução administrativa antiga) volta a `aberta`; histórica e cancelada ficam como estão
      const legacy = await trx.selectFrom("needResolutions").select("id").where("needId", "=", need.id).executeTakeFirst();
      if (!legacy && after.destinationCount > 0) {
        await trx.updateTable("needs").set({ status: "aberta", updatedAt: new Date() }).where("id", "=", need.id).where("organizationId", "=", input.organizationId).where("status", "=", "atendida").execute();
        reopened = true;
      }
    }
    needEffect = { needId: need.id, title: need.title, attendedBefore, attendedAfter: progress.attended, requested: progress.requested, remainingAfter: progress.remaining, reopened };
  }

  let newStock: number | null = null;
  if (physical) {
    const b = await trx.selectFrom("stockTransactions").select((eb) => eb.fn.coalesce(eb.fn.sum<string>("delta"), eb.val("0")).as("t")).where("itemId", "=", target.itemId).executeTakeFirstOrThrow();
    newStock = roundQuantity(Number(b.t));
  }

  return {
    type: "ok",
    eventId: String(event.id),
    kind: input.kind,
    quantity: input.quantity,
    stockTransactionId: movementId,
    physicalMovement: movementType,
    reversedTotal: roundQuantity(reversed + input.quantity),
    reversibleAfter: roundQuantity(reversible - input.quantity),
    newStock,
    itemName: item.name,
    unit: target.unit,
    need: needEffect,
    target: { id: String(target.id), itemId: target.itemId, needId: target.needId, isCountable: target.isCountable === true },
  };
}

/** Auditoria de uma reversão aplicada (chamar por ÚLTIMO). `inventario.*` para o movimento físico mantém a conciliação do estoque com o histórico de auditoria. */
export async function auditReversal(trx: Transaction<DB>, organizationId: number, actorUserId: number, applied: ReversalApplied, input: ReversalInput, idempotencyKey: string) {
  if (applied.physicalMovement) {
    await recordAuditLogEntry(
      {
        organizationId,
        actorUserId,
        action: applied.physicalMovement === "entrada" ? "inventario.entrada_registrada" : "inventario.ajuste_registrado",
        entityType: "inventory_item",
        entityId: String(applied.target.itemId),
        metadata: { delta: applied.quantity, itemName: applied.itemName, motivo: input.kind, destinacaoId: applied.target.id, reversaoId: applied.eventId },
      },
      trx
    );
  }
  await recordAuditLogEntry(
    {
      organizationId,
      actorUserId,
      action: "destinacao.revertida",
      entityType: "stock_destination",
      entityId: applied.target.id,
      metadata: {
        reversaoId: applied.eventId,
        tipo: input.kind,
        quantidadeRevertida: applied.quantity,
        unidade: applied.unit,
        totalRevertido: applied.reversedTotal,
        reversivelRestante: applied.reversibleAfter,
        motivo: input.reason.trim(),
        movimentoFisico: applied.physicalMovement ? { tipo: applied.physicalMovement, movimentacaoId: applied.stockTransactionId, saldoApos: applied.newStock } : null,
        necessidadeId: applied.target.needId,
        contabilizavel: applied.target.isCountable,
        atendimento: applied.need ? { antes: applied.need.attendedBefore, depois: applied.need.attendedAfter, solicitado: applied.need.requested, faltam: applied.need.remainingAfter } : null,
        necessidadeReaberta: applied.need?.reopened === true,
        chaveIdempotencia: idempotencyKey,
      },
    },
    trx
  );
  if (applied.need?.reopened) {
    await recordAuditLogEntry(
      {
        organizationId,
        actorUserId,
        action: "necessidade.reaberta_automaticamente",
        entityType: "need",
        entityId: String(applied.need.needId),
        metadata: { reversaoId: applied.eventId, destinacaoId: applied.target.id, solicitado: applied.need.requested, atendidoAntes: applied.need.attendedBefore, atendidoDepois: applied.need.attendedAfter, nenhumMovimentoCriadoPelaTransicao: true },
      },
      trx
    );
  }
}

/** Visão efetiva de uma destinação: o original com as correções documentais sobrepostas (a mais recente de cada campo vence). O original nunca é alterado. */
export interface EffectiveFields {
  deliveredOn: string;
  peopleServed: number | null;
  peopleUnit: "familias" | "pessoas" | null;
  notes: string | null;
}

export function overlayCorrections(
  original: EffectiveFields,
  corrections: Array<{ id: number | string; deliveredOn: string | null; peopleServed: number | null; peopleUnit: "familias" | "pessoas" | null; notes: string | null }>
): EffectiveFields {
  const ordered = [...corrections].sort((a, b) => Number(a.id) - Number(b.id));
  const out = { ...original };
  for (const c of ordered) {
    if (c.deliveredOn !== null) out.deliveredOn = c.deliveredOn;
    if (c.peopleServed !== null) {
      out.peopleServed = c.peopleServed;
      out.peopleUnit = c.peopleUnit;
    }
    if (c.notes !== null) out.notes = c.notes;
  }
  return out;
}

const dateOnly = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/** Correção documental: só campos descritivos, sem movimento e sem tocar o atendimento. Quem chama audita por último com `auditCorrection`. */
export async function correctDestination(
  trx: Transaction<DB>,
  input: CorrectionInput,
  ctx: { actorUserId: number; actorCanManage: boolean }
): Promise<CorrectionApplied | CorrectionFailure> {
  const target = await trx
    .selectFrom("stockDestinations")
    .select(["id", "entryType", "itemId", "destinationType", "deliveredOn", "peopleServed", "peopleUnit", "notes", "createdByUserId"])
    .where("id", "=", input.destinationId)
    .where("organizationId", "=", input.organizationId)
    .executeTakeFirst();
  if (!target || target.entryType !== "original") return fail("destinacao_nao_encontrada", 404, "Destinação não encontrada nesta organização");
  if (!ctx.actorCanManage && target.createdByUserId !== ctx.actorUserId) {
    return fail("sem_permissao_para_corrigir", 403, "Somente quem registrou a destinação, ou proprietário/administrador, pode corrigir seus dados descritivos");
  }

  // trava a destinação original: correções concorrentes se serializam e a segunda lê o estado confirmado
  await trx.selectFrom("stockDestinations").select("id").where("id", "=", target.id).forUpdate().execute();
  const previous = await trx
    .selectFrom("stockDestinations")
    .select(["id", "deliveredOn", "peopleServed", "peopleUnit", "notes"])
    .where("entryType", "=", "correction")
    .where("reversesDestinationId", "=", target.id)
    .execute();
  const current = overlayCorrections(
    { deliveredOn: dateOnly(target.deliveredOn), peopleServed: target.peopleServed, peopleUnit: target.peopleUnit as "familias" | "pessoas" | null, notes: target.notes },
    previous.map((p) => ({ id: String(p.id), deliveredOn: p.deliveredOn === null ? null : dateOnly(p.deliveredOn), peopleServed: p.peopleServed, peopleUnit: p.peopleUnit as "familias" | "pessoas" | null, notes: p.notes }))
  );

  const type = target.destinationType as DestinationType | null;
  const changes: Record<string, { de: unknown; para: unknown }> = {};
  if (input.deliveredOn !== null && input.deliveredOn !== current.deliveredOn) changes.dataEfetiva = { de: current.deliveredOn, para: input.deliveredOn };
  if (input.peopleServed !== null && (input.peopleServed !== current.peopleServed || input.peopleUnit !== current.peopleUnit)) {
    if (!type || !isAttendanceType(type)) return fail("campo_nao_aplicavel", 422, "Pessoas atendidas só se aplica às finalidades de atendimento");
    changes.pessoasAtendidas = { de: current.peopleServed === null ? null : { quantidade: current.peopleServed, unidade: current.peopleUnit }, para: { quantidade: input.peopleServed, unidade: input.peopleUnit } };
  }
  if (input.notes !== null && input.notes !== current.notes) {
    if (type && REASON_REQUIRED_TYPES.includes(type) && input.notes.trim().length < NOTES_MIN_WHEN_REQUIRED) {
      return fail("notas_obrigatorias", 422, `Esta finalidade exige observações com no mínimo ${NOTES_MIN_WHEN_REQUIRED} caracteres`);
    }
    changes.observacoes = { de: current.notes, para: input.notes };
  }
  if (Object.keys(changes).length === 0) return fail("sem_alteracao", 422, "Nenhum dos valores informados difere do que já está registrado");

  let lateReason: string | null = null;
  let authorizer: number | null = null;
  if (changes.dataEfetiva) {
    const now = await serverNow(trx);
    const date = checkEffectiveDate(input.deliveredOn!, now);
    if (!date.ok) {
      return date.reason === "futura" ? fail("data_futura", 422, "A data efetiva não pode ser futura (data de negócio no fuso America/Sao_Paulo)") : fail("data_invalida", 422, "Informe uma data real do calendário (AAAA-MM-DD)");
    }
    if (date.retroactive) {
      if (!ctx.actorCanManage) return fail("retroativa_exige_autorizacao", 403, `Datas com mais de ${MAX_RETROACTIVE_DAYS} dias corridos exigem autorização de proprietário ou administrador`);
      if (!input.lateRegistrationReason || input.lateRegistrationReason.trim().length < 10) {
        return fail("retroativa_exige_justificativa", 422, `Datas com mais de ${MAX_RETROACTIVE_DAYS} dias corridos exigem uma justificativa (mínimo de 10 caracteres)`);
      }
      lateReason = input.lateRegistrationReason.trim();
      authorizer = ctx.actorUserId;
    }
  }

  const [event] = await trx
    .insertInto("stockDestinations")
    .values({
      organizationId: input.organizationId,
      entryType: "correction",
      itemId: target.itemId,
      reversesDestinationId: target.id,
      deliveredOn: changes.dataEfetiva ? input.deliveredOn : null,
      peopleServed: changes.pessoasAtendidas ? input.peopleServed : null,
      peopleUnit: changes.pessoasAtendidas ? input.peopleUnit : null,
      notes: changes.observacoes ? input.notes : null,
      reason: input.reason.trim(),
      lateRegistrationReason: lateReason,
      authorizedByUserId: authorizer,
      createdByUserId: ctx.actorUserId,
    } as never)
    .returning(["id"])
    .execute();

  return { type: "ok", eventId: String(event.id), changes, target: { id: String(target.id), itemId: target.itemId } };
}

export async function auditCorrection(trx: Transaction<DB>, organizationId: number, actorUserId: number, applied: CorrectionApplied, input: CorrectionInput, idempotencyKey: string) {
  await recordAuditLogEntry(
    {
      organizationId,
      actorUserId,
      action: "destinacao.corrigida",
      entityType: "stock_destination",
      entityId: applied.target.id,
      metadata: { correcaoId: applied.eventId, alteracoes: applied.changes as never, motivo: input.reason.trim(), nenhumMovimentoDeEstoque: true, chaveIdempotencia: idempotencyKey },
    },
    trx
  );
}

// ---- leitura -------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface DestinationEventView {
  id: string;
  entryType: "correction" | "reversal";
  reversalKind: ReversalKind | null;
  quantity: number | null;
  reason: string;
  stockTransactionId: string | null;
  /** Para uma reversão: houve movimento físico de estoque (entrada ou ajuste)? */
  physicalMovement: "entrada" | "ajuste" | null;
  changes: { deliveredOn: string | null; peopleServed: number | null; peopleUnit: string | null; notes: string | null };
  createdByDisplayName: string;
  createdAt: string;
}

export interface DestinationView {
  id: string;
  itemId: number;
  itemName: string;
  destinationType: DestinationType;
  quantity: number;
  unit: string;
  isCountable: boolean;
  appliedQuantity: number | null;
  surplusQuantity: number | null;
  need: { id: number; title: string; status: string } | null;
  /** Dados como foram registrados (imutáveis) e os efetivos depois das correções documentais. */
  recorded: EffectiveFields;
  effective: EffectiveFields;
  reversedQuantity: number;
  reversibleQuantity: number;
  physicallyReturnedQuantity: number;
  documentallyRevertedQuantity: number;
  quantityCorrectedQuantity: number;
  state: "ativa" | "parcialmente_revertida" | "revertida";
  createdByDisplayName: string;
  createdAt: string;
  events: DestinationEventView[];
}

export async function listDestinationHistory(
  db: Kysely<DB> | Transaction<DB>,
  organizationId: number,
  filter: { itemId?: number; needId?: number; limit: number; beforeId?: string }
): Promise<{ destinations: DestinationView[]; hasMore: boolean }> {
  let q = db
    .selectFrom("stockDestinations as d")
    .innerJoin("inventoryItems as i", "i.id", "d.itemId")
    .innerJoin("users as u", "u.id", "d.createdByUserId")
    .leftJoin("needs as n", "n.id", "d.needId")
    .select(["d.id", "d.itemId", "i.name as itemName", "d.destinationType", "d.quantity", "d.unit", "d.isCountable", "d.appliedQuantity", "d.surplusQuantity", "d.needId", "n.title as needTitle", "n.status as needStatus", "d.deliveredOn", "d.peopleServed", "d.peopleUnit", "d.notes", "u.displayName as createdByDisplayName", "d.createdAt"])
    .where("d.organizationId", "=", organizationId)
    .where("d.entryType", "=", "original")
    .orderBy("d.id", "desc")
    .limit(filter.limit + 1);
  if (filter.itemId) q = q.where("d.itemId", "=", filter.itemId);
  if (filter.needId) q = q.where("d.needId", "=", filter.needId);
  if (filter.beforeId) q = q.where("d.id", "<", filter.beforeId);
  const fetched = await q.execute();
  const hasMore = fetched.length > filter.limit;
  const rows = fetched.slice(0, filter.limit);
  if (rows.length === 0) return { destinations: [], hasMore: false };

  const events = await db
    .selectFrom("stockDestinations as e")
    .innerJoin("users as u", "u.id", "e.createdByUserId")
    .leftJoin("stockTransactions as t", "t.id", "e.stockTransactionId")
    .select(["e.id", "e.entryType", "e.reversalKind", "e.quantity", "e.reason", "e.stockTransactionId", "t.type as movementType", "e.reversesDestinationId", "e.deliveredOn", "e.peopleServed", "e.peopleUnit", "e.notes", "u.displayName as createdByDisplayName", "e.createdAt"])
    .where("e.organizationId", "=", organizationId)
    .where("e.entryType", "in", ["correction", "reversal"])
    .where("e.reversesDestinationId", "in", rows.map((r) => r.id))
    .orderBy("e.id", "asc")
    .execute();

  const destinations = rows.map((r): DestinationView => {
    const mine = events.filter((e) => String(e.reversesDestinationId) === String(r.id));
    const reversals = mine.filter((e) => e.entryType === "reversal");
    const sum = (kind: ReversalKind) => roundQuantity(reversals.filter((e) => e.reversalKind === kind).reduce((s, e) => s + Number(e.quantity), 0));
    const reversed = roundQuantity(reversals.reduce((s, e) => s + Number(e.quantity), 0));
    const quantity = Number(r.quantity);
    const recorded: EffectiveFields = { deliveredOn: dateOnly(r.deliveredOn), peopleServed: r.peopleServed, peopleUnit: r.peopleUnit as "familias" | "pessoas" | null, notes: r.notes };
    const effective = overlayCorrections(
      recorded,
      mine.filter((e) => e.entryType === "correction").map((e) => ({ id: String(e.id), deliveredOn: e.deliveredOn === null ? null : dateOnly(e.deliveredOn), peopleServed: e.peopleServed, peopleUnit: e.peopleUnit as "familias" | "pessoas" | null, notes: e.notes }))
    );
    return {
      id: String(r.id),
      itemId: r.itemId,
      itemName: r.itemName,
      destinationType: r.destinationType as DestinationType,
      quantity,
      unit: r.unit!,
      isCountable: r.isCountable === true,
      appliedQuantity: r.appliedQuantity === null ? null : Number(r.appliedQuantity),
      surplusQuantity: r.surplusQuantity === null ? null : Number(r.surplusQuantity),
      need: r.needId === null ? null : { id: r.needId, title: r.needTitle!, status: r.needStatus! },
      recorded,
      effective,
      reversedQuantity: reversed,
      reversibleQuantity: roundQuantity(quantity - reversed),
      physicallyReturnedQuantity: sum("devolucao_fisica"),
      documentallyRevertedQuantity: sum("estorno_documental"),
      quantityCorrectedQuantity: sum("correcao_quantidade"),
      state: reversed <= 0 ? "ativa" : reversed >= quantity ? "revertida" : "parcialmente_revertida",
      createdByDisplayName: r.createdByDisplayName,
      createdAt: r.createdAt.toISOString(),
      events: mine.map((e): DestinationEventView => ({
        id: String(e.id),
        entryType: e.entryType as "correction" | "reversal",
        reversalKind: e.reversalKind as ReversalKind | null,
        quantity: e.quantity === null ? null : Number(e.quantity),
        reason: e.reason ?? "",
        stockTransactionId: e.stockTransactionId === null ? null : String(e.stockTransactionId),
        physicalMovement: e.movementType === "entrada" || e.movementType === "ajuste" ? e.movementType : null,
        changes: { deliveredOn: e.deliveredOn === null ? null : dateOnly(e.deliveredOn), peopleServed: e.peopleServed, peopleUnit: e.peopleUnit, notes: e.notes },
        createdByDisplayName: e.createdByDisplayName,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  });
  return { destinations, hasMore };
}
