import { sql } from "kysely";
import { db } from "./db.js";
import { claimTaskRun, finishTaskRun, failTaskRun } from "./backgroundTasks.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { runMatchingForOpportunity } from "./opportunityMatching.js";
import { withScheduledTaskLock } from "./scheduledTaskLock.js";
import { reopenOpportunityIfNoActiveAllocations } from "./reopenOpportunity.js";
import { concludeOpportunityIfAllTerminalAndReceived } from "./concludeOpportunity.js";
import { REASSIGNMENT_PAUSE_DAYS } from "./assignmentSettings.js";

/**
 * Tarefa agendada (Fase 98): expira atribuições AUTOMÁTICAS de nota alta que ficaram sem movimentação até o prazo de resposta.
 *
 * O QUE EXPIRA (todas as condições, reavaliadas SOB A TRAVA da linha): status 'aceita' (nenhum evento de logística mudou o estado: coleta/transporte/recebimento tiram a
 * atribuição de 'aceita'), auto_matched = true, decided_by_user_id IS NULL (nenhum humano decidiu; uma proposta aceita por pessoa não tem prazo), response_due_at preenchido
 * e já vencido pelo relógio do BANCO (<= now(); o instante exato conta como vencido). response_due_at só é gravado pelo matching ao criar a atribuição automática: manuais,
 * propostas e linhas antigas (sem prazo gravado) nunca são candidatas — nada é presumido retroativamente.
 *
 * O QUE ACONTECE: a atribuição vira 'cancelada' com closed_reason = 'prazo_expirado' e closed_at = now() (isto NÃO é recusa explícita da organização: a exclusão
 * permanente da Fase 97 só lê 'recusada' e o evento 'cancelado' da logística; aqui vale a pausa temporária de 7 dias), conclui-ou-reabre a oportunidade (mesmos helpers de
 * decisão/logística/expiração de reservas) e audita 'atribuicao.prazo_expirado' — tudo na MESMA transação, uma por atribuição. Reabriu → o matching roda de novo (a
 * organização expirada fica em pausa; outras elegíveis podem receber). Falha numa atribuição não impede as demais; a execução termina como falha DEPOIS de processar todas.
 *
 * Ordem de travas (a mesma de decisão/logística/recebimento): atribuição → oportunidade (nos helpers) → auditoria. Idempotente: reexecutar não encontra mais a linha.
 */
export async function expireAssignmentDeadlines() {
  await withScheduledTaskLock("expireAssignmentDeadlines", () => runExpireAssignmentDeadlines());
}

const AGGREGATE_ERROR_PREFIX = "expireAssignmentDeadlines: ";

async function expireOne(allocationId: number): Promise<{ expired: boolean; opportunityRegistryId?: number; reopened?: boolean }> {
  return db.transaction().execute(async (trx) => {
    const a = await trx
      .selectFrom("opportunityAllocations")
      .select(["id", "organizationId", "opportunityRegistryId", "responseDueAt"])
      .where("id", "=", allocationId)
      .where("status", "=", "aceita")
      .where("autoMatched", "=", true)
      .where("decidedByUserId", "is", null)
      .where("responseDueAt", "is not", null)
      .where(sql<boolean>`response_due_at <= now()`)
      .forUpdate()
      .executeTakeFirst();
    // Reavaliado sob a trava: se a organização iniciou a logística ou recebeu enquanto esperávamos, a linha já não é 'aceita' e sai daqui.
    if (!a) return { expired: false };

    await trx
      .updateTable("opportunityAllocations")
      .set({ status: "cancelada", closedAt: sql<Date>`now()`, closedReason: "prazo_expirado", updatedAt: new Date() })
      .where("id", "=", a.id)
      .where("status", "=", "aceita")
      .execute();

    const concluded = await concludeOpportunityIfAllTerminalAndReceived(trx, a.opportunityRegistryId);
    const reopened = concluded ? false : await reopenOpportunityIfNoActiveAllocations(trx, a.opportunityRegistryId);

    await recordAuditLogEntry(
      {
        organizationId: a.organizationId,
        actorUserId: null,
        action: "atribuicao.prazo_expirado",
        entityType: "opportunity_allocation",
        entityId: String(a.id),
        metadata: {
          opportunityRegistryId: a.opportunityRegistryId,
          prazoVencidoEm: a.responseDueAt ? a.responseDueAt.toISOString() : null,
          origem: "sistema",
          motivo: "prazo_de_resposta_sem_movimentacao",
          naoERecusaExplicita: true,
          pausaReatribuicaoDias: REASSIGNMENT_PAUSE_DAYS,
        },
      },
      trx
    );
    if (concluded) {
      await recordAuditLogEntry(
        { organizationId: null, actorUserId: null, action: "descoberta_central.concluida", entityType: "opportunity_registry", entityId: String(a.opportunityRegistryId), metadata: {} },
        trx
      );
    }
    return { expired: true, opportunityRegistryId: a.opportunityRegistryId, reopened };
  });
}

async function runExpireAssignmentDeadlines() {
  const claim = await claimTaskRun({ taskName: "expireAssignmentDeadlines" });
  if (!claim.claimed) return;

  try {
    const due = await db
      .selectFrom("opportunityAllocations")
      .select("id")
      .where("status", "=", "aceita")
      .where("autoMatched", "=", true)
      .where("decidedByUserId", "is", null)
      .where("responseDueAt", "is not", null)
      .where(sql<boolean>`response_due_at <= now()`)
      .orderBy("id")
      .limit(500)
      .execute();

    let expiradas = 0;
    const toRematch = new Set<number>();
    const failures: Array<{ allocationId: number; message: string }> = [];
    for (const { id } of due) {
      try {
        const r = await expireOne(id);
        if (r.expired) expiradas += 1;
        if (r.reopened && r.opportunityRegistryId !== undefined) toRematch.add(r.opportunityRegistryId);
      } catch (err) {
        failures.push({ allocationId: id, message: err instanceof Error ? err.message : String(err) });
      }
    }

    for (const oppId of toRematch) {
      try {
        await runMatchingForOpportunity(oppId, null);
      } catch (err) {
        // A oportunidade já foi reaberta (transação confirmada): o sweep periódico a avaliará depois.
        failures.push({ allocationId: -oppId, message: `rematch da oportunidade ${oppId}: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    if (failures.length > 0) {
      const error = new Error(`${AGGREGATE_ERROR_PREFIX}${failures.length} falha(s) (as demais foram processadas)`);
      await failTaskRun(claim.runId, error, { falhas: failures.slice(0, 20).map((f) => ({ id: f.allocationId, message: f.message.slice(0, 300) })) });
      throw error;
    }

    await finishTaskRun(claim.runId, { expiradas, oportunidadesReavaliadas: toRematch.size });
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith(AGGREGATE_ERROR_PREFIX))) await failTaskRun(claim.runId, err);
    throw err;
  }
}
