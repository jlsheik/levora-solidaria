import { db } from "./db.js";
import { claimTaskRun, finishTaskRun, failTaskRun } from "./backgroundTasks.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { runMatchingForOpportunity } from "./opportunityMatching.js";
import { withScheduledTaskLock } from "./scheduledTaskLock.js";
import { reopenOpportunityIfNoActiveAllocations } from "./reopenOpportunity.js";
import { concludeOpportunityIfAllTerminalAndReceived } from "./concludeOpportunity.js";

/**
 * Tarefa agendada: libera atribuições propostas automaticamente (confiança
 * média) cuja reserva de 30 minutos venceu sem decisão da organização, e
 * tenta o matching de novo para a mesma descoberta — para que a
 * oportunidade não fique parada esperando uma organização que nunca vai
 * responder.
 *
 * `withScheduledTaskLock` (achado de auditoria) garante que duas chamadas
 * concorrentes desta função — seja o cron disparando de novo antes da
 * anterior terminar, seja o reprocessamento manual (POST
 * background-tasks-retry) rodando ao mesmo tempo — nunca executam o corpo
 * simultaneamente. `claimTaskRun` continua com sua semântica de sempre
 * (registro em background_task_runs + idempotência por `idempotencyKey`
 * quando usada), inalterada.
 */
export async function expireReservations() {
  await withScheduledTaskLock("expireReservations", () => runExpireReservations());
}

async function runExpireReservations() {
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
    // atribuição ativa — OU concluí-la, se a expiração desta for a última
    // atribuição pendente e uma irmã já tiver sido "recebida" (achado de
    // auditoria: antes, só allocations-receive_POST checava a condição de
    // conclusão; expirar a última atribuição não recebida deixava a
    // oportunidade presa em "atribuida" para sempre nesse caso). Tenta
    // concluir primeiro; só tenta reabrir se não concluiu — mesmo padrão
    // dos outros 3 caminhos. Os dois helpers travam a linha da oportunidade
    // ANTES de contar atribuições-irmãs, serializando a decisão contra
    // qualquer outra transação concorrente terminando uma atribuição
    // diferente da mesma oportunidade. Cada oportunidade numa transação
    // própria — mantém o padrão de transações curtas já usado no resto do
    // arquivo.
    for (const oppId of opportunityIds) {
      const { reopened } = await db.transaction().execute(async (trx) => {
        const concluded = await concludeOpportunityIfAllTerminalAndReceived(trx, oppId);
        if (concluded) {
          await recordAuditLogEntry(
            {
              organizationId: null,
              actorUserId: null,
              action: "descoberta_central.concluida",
              entityType: "opportunity_registry",
              entityId: String(oppId),
              metadata: {},
            },
            trx
          );
          return { concluded: true, reopened: false };
        }
        const reopened = await reopenOpportunityIfNoActiveAllocations(trx, oppId);
        return { concluded: false, reopened };
      });
      if (reopened) {
        await runMatchingForOpportunity(oppId, null);
      }
    }

    await finishTaskRun(claim.runId, { reservasExpiradas: expired.length, oportunidadesReavaliadas: opportunityIds.size });
  } catch (err) {
    await failTaskRun(claim.runId, err);
    throw err;
  }
}
