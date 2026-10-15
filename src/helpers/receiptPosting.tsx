/**
 * Lançamento do recebimento no estoque (e, na rede, no ledger), extraído dos endpoints para que o recebimento NORMAL e a conclusão de uma regularização de unidade (Fase 99C)
 * usem exatamente o mesmo código. Nada aqui decide se a unidade é compatível: quem chama já decidiu (compatível, ou conferida fisicamente na unidade do item).
 * O chamador é dono da transação e das travas (atribuição|doação → item → …); a auditoria entra por último.
 */
import type { Transaction } from "kysely";
import type { DB } from "./schema.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { getItemStockBalance } from "./stockBalance.js";
import { concludeOpportunityIfAllTerminalAndReceived } from "./concludeOpportunity.js";
import { computeNeedProgress, createNeedFulfillment, getNeedFulfillmentBalance } from "./needFulfillment.js";
import { roundQuantity } from "./quantityRules.js";

export interface PostAllocationReceiptInput {
  organizationId: number;
  allocation: { id: number; opportunityRegistryId: number; quantityAllocated: string | number };
  item: { id: number; name: string; unit: string };
  quantityReceived: number;
  userId: number;
  notes: string | null;
  proofUrl: string | null;
  /** Só para a conclusão de uma regularização: vira parte do motivo do movimento e da auditoria. */
  regularizationCaseId?: number;
}

export async function postAllocationReceipt(trx: Transaction<DB>, p: PostAllocationReceiptInput): Promise<{ stockTransactionId: string; newStock: number }> {
  const opportunity = await trx.selectFrom("opportunityRegistry").select(["id", "title"]).where("id", "=", p.allocation.opportunityRegistryId).executeTakeFirst();
  const regNote = p.regularizationCaseId ? ` — regularização de unidade (caso ${p.regularizationCaseId})` : "";

  const [tx] = await trx
    .insertInto("stockTransactions")
    .values({
      organizationId: p.organizationId,
      itemId: p.item.id,
      type: "entrada",
      delta: p.quantityReceived,
      reason: `Recebimento da atribuição da rede Levora — oportunidade "${opportunity?.title ?? p.allocation.opportunityRegistryId}"${regNote}${p.notes ? ` — ${p.notes}` : ""}`,
      createdByUserId: p.userId,
    })
    .returning(["id"])
    .execute();

  await trx.updateTable("opportunityAllocations").set({ status: "recebida", updatedAt: new Date() }).where("id", "=", p.allocation.id).execute();

  // Ledger de atendimento (Fase 29) — registra o fato físico do recebimento; organizationId vem sempre da própria atribuição já validada.
  await createNeedFulfillment(trx, {
    organizationId: p.organizationId,
    allocationId: p.allocation.id,
    stockTransactionId: tx.id,
    quantity: p.quantityReceived,
    unit: p.item.unit,
    createdByUserId: p.userId,
  });

  await trx
    .insertInto("logisticsEvents")
    .values({
      opportunityAllocationId: p.allocation.id,
      organizationId: p.organizationId,
      eventType: "entrega_confirmada",
      notes: p.notes,
      proofUrl: p.proofUrl,
      actorUserId: p.userId,
    })
    .execute();

  // ANTES de qualquer recordAuditLogEntry desta transação (que trava o advisory lock GLOBAL da cadeia de auditoria até o commit): oportunidade antes, auditoria por último.
  const concluded = await concludeOpportunityIfAllTerminalAndReceived(trx, p.allocation.opportunityRegistryId);

  // Política de excedentes (decisão do dono): receber MAIS que o alocado/necessário é PERMITIDO; o excedente fica identificável na auditoria.
  const allocated = Number(p.allocation.quantityAllocated);
  const overAllocation = Math.max(0, roundQuantity(p.quantityReceived - allocated));
  const ledgerRow = await trx
    .selectFrom("needFulfillments as nf")
    .leftJoin("needs as n", "n.id", "nf.needId")
    .select(["nf.needId", "nf.isCountable", "n.quantityNeeded"])
    .where("nf.allocationId", "=", p.allocation.id)
    .where("nf.entryType", "=", "original")
    .executeTakeFirst();
  let needProgress: { fulfilled: number; requiredRemaining: number; surplus: number } | null = null;
  let overNeed = 0;
  if (ledgerRow?.needId != null && ledgerRow.quantityNeeded != null) {
    const needed = Number(ledgerRow.quantityNeeded);
    const fulfilledAfter = await getNeedFulfillmentBalance(trx, ledgerRow.needId);
    needProgress = computeNeedProgress(needed, fulfilledAfter);
    const fulfilledBefore = ledgerRow.isCountable ? roundQuantity(fulfilledAfter - p.quantityReceived) : fulfilledAfter;
    overNeed = roundQuantity(needProgress.surplus - computeNeedProgress(needed, fulfilledBefore).surplus);
  }

  await recordAuditLogEntry(
    {
      organizationId: p.organizationId,
      actorUserId: p.userId,
      action: "atribuicao.recebida",
      entityType: "opportunity_allocation",
      entityId: String(p.allocation.id),
      metadata: {
        itemId: p.item.id,
        itemName: p.item.name,
        quantityReceived: p.quantityReceived,
        stockTransactionId: String(tx.id),
        needId: ledgerRow?.needId ?? null,
        quantidadeAlocada: allocated,
        acimaDaAlocacao: overAllocation > 0,
        excedenteAlocacao: overAllocation,
        excedenteNecessidade: overNeed,
        progressoNecessidade: needProgress,
        ...(p.regularizationCaseId ? { casoRegularizacaoId: p.regularizationCaseId } : {}),
      },
    },
    trx
  );

  if (concluded) {
    await recordAuditLogEntry(
      { organizationId: null, actorUserId: p.userId, action: "descoberta_central.concluida", entityType: "opportunity_registry", entityId: String(p.allocation.opportunityRegistryId), metadata: {} },
      trx
    );
  }

  return { stockTransactionId: String(tx.id), newStock: await getItemStockBalance(trx, p.item.id) };
}

export interface PostLocalDonationReceiptInput {
  organizationId: number;
  opportunity: { id: number; title: string; donorName: string };
  item: { id: number; name: string };
  quantityReceived: number;
  userId: number;
  notes: string | null;
  regularizationCaseId?: number;
}

/**
 * Doação local: NÃO escreve no ledger da rede (decisão E3: o atendimento de uma necessidade por doação local só conta pela destinação, que é fase posterior).
 * Devolve `claimed: false` quando a oferta já não estava mais num estado recebível (nada foi escrito).
 */
export async function postLocalDonationReceipt(
  trx: Transaction<DB>,
  p: PostLocalDonationReceiptInput
): Promise<{ claimed: false } | { claimed: true; opportunity: { id: number; status: string }; stockTransactionId: string; newStock: number }> {
  // "Reivindica" a oferta ANTES de lançar o estoque: atualização condicional (defesa em profundidade além da trava).
  const [updated] = await trx
    .updateTable("donationOpportunities")
    .set({ status: "recebida", updatedAt: new Date() })
    .where("id", "=", p.opportunity.id)
    .where("organizationId", "=", p.organizationId)
    .where("status", "not in", ["recebida", "cancelada"])
    .returning(["id", "status"])
    .execute();
  if (!updated) return { claimed: false };

  const regNote = p.regularizationCaseId ? ` — regularização de unidade (caso ${p.regularizationCaseId})` : "";
  const [tx] = await trx
    .insertInto("stockTransactions")
    .values({
      organizationId: p.organizationId,
      itemId: p.item.id,
      type: "entrada",
      delta: p.quantityReceived,
      reason: `Recebimento da oportunidade "${p.opportunity.title}" — doador: ${p.opportunity.donorName}${regNote}${p.notes ? ` — ${p.notes}` : ""}`,
      createdByUserId: p.userId,
    })
    .returning(["id"])
    .execute();

  await recordAuditLogEntry(
    {
      organizationId: p.organizationId,
      actorUserId: p.userId,
      action: "oportunidade.recebida",
      entityType: "donation_opportunity",
      entityId: String(p.opportunity.id),
      metadata: {
        title: p.opportunity.title,
        donorName: p.opportunity.donorName,
        itemId: p.item.id,
        itemName: p.item.name,
        quantityReceived: p.quantityReceived,
        stockTransactionId: String(tx.id),
        ...(p.regularizationCaseId ? { casoRegularizacaoId: p.regularizationCaseId } : {}),
      },
    },
    trx
  );

  return { claimed: true, opportunity: updated, stockTransactionId: String(tx.id), newStock: await getItemStockBalance(trx, p.item.id) };
}
