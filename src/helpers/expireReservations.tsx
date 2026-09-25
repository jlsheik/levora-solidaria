import { db } from "./db";
import { claimTaskRun, finishTaskRun, failTaskRun } from "./backgroundTasks";
import { recordAuditLogEntry } from "./auditLog";
import { runMatchingForOpportunity } from "./opportunityMatching";

/**
 * Tarefa agendada: libera atribuições propostas automaticamente (confiança
 * média) cuja reserva de 30 minutos venceu sem decisão da organização, e
 * tenta o matching de novo para a mesma descoberta — para que a
 * oportunidade não fique parada esperando uma organização que nunca vai
 * responder.
 */
export async function expireReservations() {
  const claim = await claimTaskRun({ taskName: "expireReservations" });
  if (!claim.claimed) return;

  try {
    const expired = await db
      .updateTable("opportunityAllocations")
      .set({ status: "cancelada", updatedAt: new Date() })
      .where("status", "=", "proposta")
      .where("autoMatched", "=", true)
      .where("reservedUntil", "is not", null)
      .where("reservedUntil", "<", new Date())
      .returning(["id", "opportunityRegistryId", "organizationId"])
      .execute();

    const opportunityIds = new Set<number>();
    for (const a of expired) {
      opportunityIds.add(a.opportunityRegistryId);
    }

    // Uma única transação para toda a varredura, em vez de uma por
    // atribuição expirada (ver o mesmo ajuste em expireApprovalRequests.tsx
    // e expireOpportunities.tsx).
    if (expired.length > 0) {
      await db.transaction().execute(async (trx) => {
        for (const a of expired) {
          await recordAuditLogEntry(
            {
              organizationId: a.organizationId,
              actorUserId: null,
              action: "atribuicao.reserva_expirada",
              entityType: "opportunity_allocation",
              entityId: String(a.id),
              metadata: { opportunityRegistryId: a.opportunityRegistryId },
            },
            trx
          );
        }
      });
    }

    // Reabrir a oportunidade para novo matching quando não sobrou nenhuma
    // atribuição ativa.
    for (const oppId of opportunityIds) {
      const remainingActive = await db
        .selectFrom("opportunityAllocations")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("opportunityRegistryId", "=", oppId)
        .where("status", "!=", "recusada")
        .where("status", "!=", "cancelada")
        .executeTakeFirst();

      if (Number(remainingActive?.count ?? 0) === 0) {
        await db
          .updateTable("opportunityRegistry")
          .set({ status: "aguardando_destinacao", updatedAt: new Date() })
          .where("id", "=", oppId)
          .where("status", "=", "reservada")
          .execute();

        await runMatchingForOpportunity(oppId, null);
      }
    }

    await finishTaskRun(claim.runId, { reservasExpiradas: expired.length, oportunidadesReavaliadas: opportunityIds.size });
  } catch (err) {
    await failTaskRun(claim.runId, err);
    throw err;
  }
}
