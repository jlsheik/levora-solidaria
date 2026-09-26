import { db } from "./db";
import { claimTaskRun, finishTaskRun, failTaskRun } from "./backgroundTasks";
import { recordAuditLogEntry } from "./auditLog";
import type { OpportunityRegistryStatus } from "./schema";
import { withScheduledTaskLock } from "./scheduledTaskLock";

const TERMINAL_STATUSES: OpportunityRegistryStatus[] = ["concluida", "recusada", "expirada", "cancelada", "bloqueada", "duplicada"];

/**
 * Tarefa agendada (static/__dev/scheduled-jobs.json): expira descobertas do
 * registro central cuja validade (expires_at) já passou. A maioria das
 * descobertas hoje não tem expires_at preenchido (a interface ainda não
 * coleta esse campo no formulário rápido), então esta tarefa
 * frequentemente não encontra nada — isso é esperado, não é um bug.
 *
 * `withScheduledTaskLock` (achado de auditoria) impede que duas chamadas
 * concorrentes desta função (cron sobreposto, ou reprocessamento manual ao
 * mesmo tempo) executem o corpo simultaneamente. `claimTaskRun` continua
 * inalterado.
 */
export async function expireOpportunities() {
  await withScheduledTaskLock("expireOpportunities", () => runExpireOpportunities());
}

async function runExpireOpportunities() {
  const claim = await claimTaskRun({ taskName: "expireOpportunities" });
  if (!claim.claimed) return;

  try {
    const expired = await db
      .updateTable("opportunityRegistry")
      .set({ status: "expirada", statusReason: "validade vencida (expires_at)", updatedAt: new Date() })
      .where("expiresAt", "is not", null)
      .where("expiresAt", "<", new Date())
      .where("status", "not in", TERMINAL_STATUSES)
      .returning(["id", "title"])
      .execute();

    // Uma única transação para toda a varredura, em vez de uma por
    // descoberta expirada (ver o mesmo ajuste em expireApprovalRequests.tsx
    // e expireReservations.tsx).
    if (expired.length > 0) {
      await db.transaction().execute(async (trx) => {
        for (const opp of expired) {
          await recordAuditLogEntry(
            {
              organizationId: null,
              actorUserId: null,
              action: "descoberta_central.expirada_automaticamente",
              entityType: "opportunity_registry",
              entityId: String(opp.id),
              metadata: { title: opp.title },
            },
            trx
          );
        }
      });
    }

    await finishTaskRun(claim.runId, { expiradas: expired.length });
  } catch (err) {
    await failTaskRun(claim.runId, err);
    throw err;
  }
}
