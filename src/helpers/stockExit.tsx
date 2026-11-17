/**
 * Fase 99E — núcleo transacional do registro de SAÍDA FÍSICA + DESTINAÇÃO. É a ÚNICA porta de saída de estoque: `stock-transactions_POST` recusa `saida` e `needs-status_POST` deixou de
 * baixar estoque. Saída (`stock_transactions`), destinação original (`stock_destinations`), pedido idempotente (`stock_exit_requests`) e auditoria nascem JUNTOS na mesma transação do
 * chamador; qualquer falha reverte tudo.
 *
 * ORDEM DE TRAVAS (única): trava consultiva da chave de idempotência → item (FOR UPDATE) → necessidade (FOR NO KEY UPDATE) → [linhas criadas] → auditoria (sempre por último, por causa do
 * advisory lock global da cadeia). A aprovação trava o pedido de aprovação antes de tudo (já é a ordem de approval-requests-decide).
 *
 * O saldo é recalculado SOB a trava do item (nunca o saldo da tela); o limite de risco usa o saldo imediatamente anterior, na unidade canônica do item. Nada aqui converte unidade.
 */
import { createHash } from "node:crypto";
import { publishStockTransactionCreated } from "./domainEventPublishers.js";
import { sql, type Transaction } from "kysely";
import type { DB } from "./schema.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { getItemStockBalance } from "./stockBalance.js";
import { roundQuantity } from "./quantityRules.js";
import { classifyUnit, unitsEquivalent } from "./unitVocabulary.js";
import { checkEffectiveDate, MAX_RETROACTIVE_DAYS } from "./businessDate.js";
import { getNeedAttendance, remainingToAttend } from "./needAttendance.js";
import { DESTINATION_LABELS, evaluateDestinationRisk, isAttendanceType, type DestinationType, type RiskReason } from "./destinationRules.js";

export const DESTINATION_APPROVAL_ACTION = "saida_destinacao_alto_risco";

export interface DestinationExitInput {
  organizationId: number;
  itemId: number;
  quantity: number;
  destinationType: DestinationType;
  needId: number | null;
  deliveredOn: string;
  peopleServed: number | null;
  peopleUnit: "familias" | "pessoas" | null;
  notes: string | null;
  lateRegistrationReason: string | null;
  /** Fase 99F: o usuário AUTORIZA expressamente que a saída física passe do que falta da necessidade (o excedente fica registrado, nunca conta como atendimento adicional). */
  authorizeSurplus: boolean;
  surplusReason: string | null;
}

export type ExitErrorCode =
  | "item_nao_encontrado"
  | "saldo_insuficiente"
  | "unidade_do_item_nao_confiavel"
  | "necessidade_nao_encontrada"
  | "necessidade_nao_aberta"
  | "necessidade_de_outro_item"
  | "data_futura"
  | "data_invalida"
  | "retroativa_exige_autorizacao"
  | "retroativa_exige_justificativa"
  | "necessidade_ja_atendida"
  | "excedente_nao_autorizado"
  | "excedente_exige_permissao"
  | "excedente_exige_motivo";

export type ExitFailure = { type: "error"; code: ExitErrorCode; status: number; message: string; details?: Record<string, unknown> };

export interface PreparedExit {
  type: "ready";
  item: { id: number; name: string; unit: string };
  balanceBefore: number;
  needTitle: string | null;
  isCountable: boolean;
  risk: RiskReason[];
  /** Fase 99F: quantidade aplicada ao atendimento da necessidade (null sem necessidade contabilizável), excedente autorizado e se esta destinação completa a necessidade. */
  applied: number | null;
  surplus: number;
  attendedBefore: number;
  needQuantity: number | null;
  fulfills: boolean;
  retroactive: boolean;
  businessToday: string;
  now: Date;
}

/** Hash canônico do conteúdo (a chave de idempotência fica de fora): o mesmo conteúdo gera o mesmo hash; qualquer campo diferente, outro. */
export function hashDestinationInput(input: DestinationExitInput): string {
  const canonical = {
    organizationId: input.organizationId,
    itemId: input.itemId,
    quantity: roundQuantity(input.quantity),
    destinationType: input.destinationType,
    needId: input.needId,
    deliveredOn: input.deliveredOn,
    peopleServed: input.peopleServed,
    peopleUnit: input.peopleUnit,
    notes: input.notes ?? null,
    lateRegistrationReason: input.lateRegistrationReason ?? null,
    authorizeSurplus: input.authorizeSurplus === true,
    surplusReason: input.surplusReason ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const fail = (code: ExitErrorCode, status: number, message: string, details?: Record<string, unknown>): ExitFailure => ({ type: "error", code, status, message, details });

/** Instante do servidor (relógio do BANCO), a mesma referência para a data de negócio e para o registro. */
export async function serverNow(trx: Transaction<DB>): Promise<Date> {
  const r = await sql<{ now: Date }>`SELECT now() AS now`.execute(trx);
  return r.rows[0].now;
}

/**
 * Trava o item, recalcula o saldo e valida TUDO que não depende de quem é o aprovador: item da organização, unidade confiável, saldo, necessidade, data efetiva e risco. Chamado
 * tanto no pedido quanto na aprovação (que reavalia o estado atual). `actorCanAuthorizeLate`: quem pede/aprova pode autorizar data retroativa (proprietário/administrador).
 */
export async function prepareDestinationExit(trx: Transaction<DB>, input: DestinationExitInput, ctx: { actorCanAuthorizeLate: boolean }): Promise<PreparedExit | ExitFailure> {
  // `actorCanAuthorizeLate` (proprietário/administrador, `organizacao.gerencie`) também é quem pode AUTORIZAR excedente: a mesma permissão existente, sem nenhuma nova.
  const item = await trx
    .selectFrom("inventoryItems")
    .select(["id", "name", "unit", "organizationId"])
    .where("id", "=", input.itemId)
    .forUpdate()
    .executeTakeFirst();
  if (!item || item.organizationId !== input.organizationId) return fail("item_nao_encontrado", 404, "Item de inventário não encontrado nesta organização");

  // Unidade confiável: o item precisa estar na unidade canônica do vocabulário, exatamente como gravada (o banco recusa o resto). Nenhuma conversão.
  const unit = classifyUnit(item.unit);
  if (unit.kind !== "canonica" || unit.canonicalLabel !== item.unit) {
    return fail("unidade_do_item_nao_confiavel", 422, `A unidade do item ("${item.unit.trim()}") não é uma unidade canônica confiável. Regularize a unidade do item antes de registrar uma saída.`);
  }

  const balanceBefore = await getItemStockBalance(trx, item.id);
  if (roundQuantity(balanceBefore - input.quantity) < 0) {
    return fail("saldo_insuficiente", 409, `Estoque insuficiente: o saldo atual é ${balanceBefore} ${item.unit}, a saída de ${input.quantity} deixaria o saldo negativo`, { balance: balanceBefore });
  }

  let needTitle: string | null = null;
  let isCountable = false;
  let applied: number | null = null;
  let surplus = 0;
  let attendedBefore = 0;
  let needQuantity: number | null = null;
  let fulfills = false;
  if (input.needId !== null) {
    const need = await trx
      .selectFrom("needs")
      .select(["id", "title", "status", "itemId", "unit", "quantityNeeded"])
      .where("id", "=", input.needId)
      .where("organizationId", "=", input.organizationId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!need) return fail("necessidade_nao_encontrada", 404, "Necessidade não encontrada nesta organização");
    if (need.status !== "aberta") return fail("necessidade_nao_aberta", 409, `A necessidade "${need.title}" não está aberta (situação: ${need.status}) e não recebe novas destinações`);
    if (need.itemId !== null && need.itemId !== item.id) return fail("necessidade_de_outro_item", 409, `A necessidade "${need.title}" é de outro item de estoque`);
    needTitle = need.title;
    // contabilizável só com a MESMA unidade canônica; unidade incompatível registra a saída física, mas NÃO conta como atendimento (nada é convertido)
    isCountable = isAttendanceType(input.destinationType) && unitsEquivalent(need.unit, item.unit);

    // Fase 99F: com a necessidade TRAVADA, recalcula quanto falta a partir das destinações CONFIRMADAS (nunca de um total vindo do cliente). Só a parcela que falta conta como
    // atendimento; o que passa disso é EXCEDENTE e só existe com autorização expressa, motivo e permissão (a quantidade física real nunca é cortada nem trocada de unidade).
    needQuantity = Number(need.quantityNeeded);
    if (isCountable) {
      const attendance = await getNeedAttendance(trx, need.id);
      attendedBefore = attendance.appliedNet;
      const remaining = remainingToAttend(needQuantity, attendance);
      if (remaining <= 0) return fail("necessidade_ja_atendida", 409, `A necessidade "${need.title}" já foi atendida por inteiro (${attendance.appliedNet} de ${needQuantity} ${need.unit}); não há mais o que aplicar`, { maxAplicavel: 0 });
      if (input.quantity <= remaining) {
        applied = input.quantity;
      } else {
        const excess = roundQuantity(input.quantity - remaining);
        if (!input.authorizeSurplus) {
          return fail("excedente_nao_autorizado", 409, `A quantidade (${input.quantity} ${item.unit}) supera o que falta da necessidade "${need.title}": faltam ${remaining} ${need.unit} (excedente de ${excess}). Reduza a quantidade ou autorize o excedente com motivo`, { maxAplicavel: remaining, excedente: excess });
        }
        if (!ctx.actorCanAuthorizeLate) return fail("excedente_exige_permissao", 403, "Somente proprietário ou administrador pode autorizar excedente");
        if (!input.surplusReason || input.surplusReason.trim().length < 10) return fail("excedente_exige_motivo", 422, "Autorizar excedente exige um motivo (mínimo de 10 caracteres)");
        applied = remaining;
        surplus = excess;
      }
      fulfills = roundQuantity(attendance.appliedNet + applied) >= needQuantity;
    }
  }

  const now = await serverNow(trx);
  const date = checkEffectiveDate(input.deliveredOn, now);
  if (!date.ok) {
    return date.reason === "futura"
      ? fail("data_futura", 422, "A data efetiva não pode ser futura (data de negócio no fuso America/Sao_Paulo)")
      : fail("data_invalida", 422, "Informe a data efetiva no formato AAAA-MM-DD, uma data real do calendário");
  }
  if (date.retroactive) {
    if (!ctx.actorCanAuthorizeLate) {
      return fail("retroativa_exige_autorizacao", 403, `Datas com mais de ${MAX_RETROACTIVE_DAYS} dias corridos exigem autorização de proprietário ou administrador`);
    }
    if (!input.lateRegistrationReason || input.lateRegistrationReason.trim().length < 10) {
      return fail("retroativa_exige_justificativa", 422, `Datas com mais de ${MAX_RETROACTIVE_DAYS} dias corridos exigem uma justificativa (mínimo de 10 caracteres)`);
    }
  }

  return {
    type: "ready",
    item: { id: item.id, name: item.name, unit: item.unit },
    balanceBefore,
    needTitle,
    isCountable,
    risk: evaluateDestinationRisk({ destinationType: input.destinationType, quantity: input.quantity, balanceBefore }),
    applied,
    surplus,
    attendedBefore,
    needQuantity,
    fulfills,
    retroactive: date.retroactive,
    businessToday: date.businessToday,
    now,
  };
}

export interface ExecutedExit {
  stockTransactionId: string;
  destinationId: string;
  newStock: number;
  /** Fase 99F: esta destinação completou a necessidade e a levou a `atendida` (nunca gera saída: é só o estado derivado). */
  needFulfilled: boolean;
}

/** Grava a saída física e a destinação original, ligadas entre si. NÃO audita (quem chama audita por último). */
export async function executeDestinationExit(trx: Transaction<DB>, input: DestinationExitInput, prepared: PreparedExit, actors: { creatorUserId: number; authorizerUserId: number | null }): Promise<ExecutedExit> {
  const label = DESTINATION_LABELS[input.destinationType].label;
  const [tx] = await trx
    .insertInto("stockTransactions")
    .values({
      organizationId: input.organizationId,
      itemId: input.itemId,
      type: "saida",
      delta: -input.quantity,
      reason: `Destinação: ${label}${prepared.needTitle ? ` — necessidade "${prepared.needTitle}"` : ""}`,
      createdByUserId: actors.creatorUserId,
    })
    .returning(["id"])
    .execute();

  // M35: a saída física também é um lançamento do ledger e precisa chegar à Sentinela (contrato v2; mesma transação; qualquer falha adiante reverte o evento junto).
  await publishStockTransactionCreated(trx, { organizationId: input.organizationId, transactionId: String(tx.id), itemId: input.itemId, type: "saida", delta: -input.quantity, source: "destinacao_saida", actorUserId: actors.creatorUserId });

  const [destination] = await trx
    .insertInto("stockDestinations")
    .values({
      organizationId: input.organizationId,
      entryType: "original",
      itemId: input.itemId,
      stockTransactionId: tx.id,
      needId: input.needId,
      destinationType: input.destinationType,
      quantity: input.quantity,
      unit: prepared.item.unit,
      isCountable: prepared.isCountable,
      deliveredOn: input.deliveredOn,
      peopleServed: input.peopleServed,
      peopleUnit: input.peopleUnit,
      notes: input.notes,
      appliedQuantity: prepared.applied,
      surplusQuantity: prepared.surplus > 0 ? prepared.surplus : null,
      surplusReason: prepared.surplus > 0 ? input.surplusReason : null,
      lateRegistrationReason: prepared.retroactive ? input.lateRegistrationReason : null,
      authorizedByUserId: prepared.retroactive || prepared.surplus > 0 ? actors.authorizerUserId : null,
      createdByUserId: actors.creatorUserId,
    } as never)
    .returning(["id"])
    .execute();

  // Estado derivado: a destinação que completa a necessidade a leva a `atendida` NA MESMA transação (necessidade já travada; nenhuma saída é criada por isto)
  if (prepared.fulfills && input.needId !== null) {
    await trx.updateTable("needs").set({ status: "atendida", updatedAt: new Date() }).where("id", "=", input.needId).where("organizationId", "=", input.organizationId).where("status", "=", "aberta").execute();
  }

  return { stockTransactionId: String(tx.id), destinationId: String(destination.id), newStock: roundQuantity(prepared.balanceBefore - input.quantity), needFulfilled: prepared.fulfills && input.needId !== null };
}

/** As duas entradas de auditoria de uma saída executada (a antiga `inventario.saida_registrada` continua existindo para a conciliação). */
export async function auditExecutedExit(
  trx: Transaction<DB>,
  input: DestinationExitInput,
  prepared: PreparedExit,
  executed: ExecutedExit,
  actors: { actorUserId: number; requesterUserId?: number; approvalRequestId?: number },
  idempotencyKey: string
) {
  await recordAuditLogEntry(
    {
      organizationId: input.organizationId,
      actorUserId: actors.actorUserId,
      action: "inventario.saida_registrada",
      entityType: "inventory_item",
      entityId: String(input.itemId),
      metadata: { delta: -input.quantity, itemName: prepared.item.name, motivo: "destinacao", destinacaoId: executed.destinationId },
    },
    trx
  );
  await recordAuditLogEntry(
    {
      organizationId: input.organizationId,
      actorUserId: actors.actorUserId,
      action: "destinacao.registrada",
      entityType: "stock_destination",
      entityId: executed.destinationId,
      metadata: {
        stockTransactionId: executed.stockTransactionId,
        itemId: input.itemId,
        itemName: prepared.item.name,
        quantidade: input.quantity,
        unidade: prepared.item.unit,
        finalidade: input.destinationType,
        necessidadeId: input.needId,
        contabilizavel: prepared.isCountable,
        dataEfetiva: input.deliveredOn,
        registradoEm: prepared.now.toISOString(),
        retroativa: prepared.retroactive,
        saldoAnterior: prepared.balanceBefore,
        riscoAvaliado: prepared.risk,
        quantidadeAplicada: prepared.applied,
        excedenteAutorizado: prepared.surplus > 0 ? { quantidade: prepared.surplus, motivo: input.surplusReason } : null,
        atendidoAntes: prepared.attendedBefore,
        chaveIdempotencia: idempotencyKey,
        ...(actors.requesterUserId ? { solicitanteId: actors.requesterUserId, aprovadoPor: actors.actorUserId, pedidoAprovacaoId: actors.approvalRequestId ?? null } : {}),
      },
    },
    trx
  );
  if (executed.needFulfilled && input.needId !== null) {
    await recordAuditLogEntry(
      {
        organizationId: input.organizationId,
        actorUserId: actors.actorUserId,
        action: "necessidade.atendida_automaticamente",
        entityType: "need",
        entityId: String(input.needId),
        metadata: { destinacaoId: executed.destinationId, quantidadeSolicitada: prepared.needQuantity, atendidoAntes: prepared.attendedBefore, quantidadeAplicada: prepared.applied, nenhumaSaidaCriadaPelaTransicao: true },
      },
      trx
    );
  }
}

export type ApprovedDestinationResult =
  | { type: "executed"; run: (trx: Transaction<DB>) => Promise<void> }
  | { type: "payload_invalid" }
  | ExitFailure;

/**
 * Execução da saída na TRANSAÇÃO DA APROVAÇÃO (segunda pessoa). Reavalia o estado ATUAL (item, unidade, saldo, necessidade, data) — a autorização do pedido não vale como garantia —,
 * grava saída + destinação e o desfecho do pedido idempotente, e devolve `run`, que audita por último. Falha de validação devolve o erro SEM escrever nada (o pedido continua pendente).
 */
export async function executeApprovedDestinationRequest(
  trx: Transaction<DB>,
  req: { id: number; payload: unknown; requestedByUserId: number; organizationId: number | null },
  approverUserId: number
): Promise<ApprovedDestinationResult> {
  const payload = req.payload as { input?: DestinationExitInput; idempotencyKey?: string; requesterCanAuthorize?: boolean } | null;
  if (!payload?.input || !payload.idempotencyKey || req.organizationId === null || payload.input.organizationId !== req.organizationId) return { type: "payload_invalid" };
  const input = payload.input;

  const request = await trx
    .selectFrom("stockExitRequests")
    .select(["id", "status"])
    .where("approvalRequestId", "=", req.id)
    .where("organizationId", "=", req.organizationId)
    .forUpdate()
    .executeTakeFirst();
  if (!request || request.status !== "pendente_aprovacao") return { type: "payload_invalid" };

  // o aprovador (proprietário/administrador: `aprovacoes.decida`) pode autorizar data retroativa; quem pediu já precisou ter essa autoridade para pedir
  const prepared = await prepareDestinationExit(trx, input, { actorCanAuthorizeLate: true });
  if (prepared.type === "error") return prepared;

  const executed = await executeDestinationExit(trx, input, prepared, { creatorUserId: req.requestedByUserId, authorizerUserId: payload.requesterCanAuthorize ? req.requestedByUserId : approverUserId });
  await trx.updateTable("stockExitRequests").set({ status: "executada", stockTransactionId: executed.stockTransactionId, stockDestinationId: executed.destinationId }).where("id", "=", request.id).execute();

  return {
    type: "executed",
    run: async (t) => {
      await auditExecutedExit(t, input, prepared, executed, { actorUserId: approverUserId, requesterUserId: req.requestedByUserId, approvalRequestId: req.id }, payload.idempotencyKey!);
    },
  };
}

/** Rejeição do pedido de aprovação: o pedido idempotente é encerrado, sem nenhuma baixa de estoque. */
export async function markDestinationRequestRejected(trx: Transaction<DB>, approvalRequestId: number, organizationId: number) {
  await trx.updateTable("stockExitRequests").set({ status: "rejeitada" }).where("approvalRequestId", "=", approvalRequestId).where("organizationId", "=", organizationId).where("status", "=", "pendente_aprovacao").execute();
}
