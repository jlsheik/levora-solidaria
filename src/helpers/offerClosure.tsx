import type { Transaction } from "kysely";
import type { DB } from "./schema.js";
import { recordAuditLogEntry } from "./auditLog.js";

/**
 * Encerramento de PROPOSTAS quando a oferta (oportunidade) é encerrada (Fase 98).
 *
 * Antes: o admin cancelava/expirava uma oportunidade 'reservada' (ou a expiração automática a encerrava) e a proposta continuava 'proposta' — a organização ainda podia
 * aceitá-la. Agora, ao encerrar a oferta, as propostas pendentes são encerradas NA MESMA TRANSAÇÃO (status 'cancelada' + closed_reason + closed_at, sem apagar nada) e
 * auditadas com ator e motivo. NÃO é recusa explícita da organização (a exclusão permanente da Fase 97 só lê 'recusada' e o evento 'cancelado' da logística).
 *
 * Atribuições EM ANDAMENTO (aceita/em_coleta/em_transporte) nunca são tocadas aqui: quem chama decide antes (a oferta com atribuição em andamento não é encerrada).
 *
 * Ordem de travas (a mesma de decisão/logística/recebimento): atribuições → oportunidade → auditoria. Por isso `lockOfferAllocations` vem ANTES de travar a oportunidade.
 */
export type OfferClosureReason = "oferta_cancelada_admin" | "oferta_expirada_admin" | "oferta_expirada_automatica" | "oferta_encerrada";

export const IN_PROGRESS_ALLOCATION_STATUSES = ["aceita", "em_coleta", "em_transporte"] as const;
const LOCKABLE_STATUSES = ["proposta", ...IN_PROGRESS_ALLOCATION_STATUSES] as const;

/** Trava (FOR UPDATE, por id) as atribuições não terminais da oferta. Chame antes de travar a linha da oportunidade. */
export async function lockOfferAllocations(trx: Transaction<DB>, opportunityRegistryId: number): Promise<void> {
  await trx
    .selectFrom("opportunityAllocations")
    .select("id")
    .where("opportunityRegistryId", "=", opportunityRegistryId)
    .where("status", "in", [...LOCKABLE_STATUSES])
    .orderBy("id")
    .forUpdate()
    .execute();
}

export async function countInProgressAllocations(trx: Transaction<DB>, opportunityRegistryId: number): Promise<number> {
  const r = await trx
    .selectFrom("opportunityAllocations")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("opportunityRegistryId", "=", opportunityRegistryId)
    .where("status", "in", [...IN_PROGRESS_ALLOCATION_STATUSES])
    .executeTakeFirst();
  return Number(r?.n ?? 0);
}

/** Encerra as propostas pendentes da oferta e audita cada uma. Devolve os ids encerrados. Exige as travas de `lockOfferAllocations` já obtidas. */
export async function closeOpenProposals(
  trx: Transaction<DB>,
  opportunityRegistryId: number,
  reason: OfferClosureReason,
  actorUserId: number | null
): Promise<number[]> {
  const closed = await trx
    .updateTable("opportunityAllocations")
    .set({ status: "cancelada", closedAt: new Date(), closedReason: reason, updatedAt: new Date() })
    .where("opportunityRegistryId", "=", opportunityRegistryId)
    .where("status", "=", "proposta")
    .returning(["id", "organizationId"])
    .execute();
  for (const a of closed) {
    await recordAuditLogEntry(
      {
        organizationId: a.organizationId,
        actorUserId,
        action: "atribuicao.encerrada_com_oferta",
        entityType: "opportunity_allocation",
        entityId: String(a.id),
        metadata: { opportunityRegistryId, motivo: reason, origem: actorUserId === null ? "sistema" : "administrador", naoERecusaDaOrganizacao: true },
      },
      trx
    );
  }
  return closed.map((c) => c.id);
}
