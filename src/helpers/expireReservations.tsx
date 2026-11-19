import { db } from "./db.js";
import { claimTaskRun, finishTaskRun, failTaskRun } from "./backgroundTasks.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { runMatchingForOpportunity } from "./opportunityMatching.js";
import { withScheduledTaskLock } from "./scheduledTaskLock.js";
import { reopenOpportunityIfNoActiveAllocations } from "./reopenOpportunity.js";
import { concludeOpportunityIfAllTerminalAndReceived } from "./concludeOpportunity.js";
import { recoverStuckOpportunities } from "./recoverStuckOpportunities.js";

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
 *
 * ATOMICIDADE (Fase 95): cada OPORTUNIDADE é uma transação própria — cancelar as reservas vencidas, conclude-ou-reabre e a auditoria são confirmados juntos ou
 * revertidos juntos. Antes, o cancelamento era um UPDATE solto e a auditoria/reabertura vinham em transações separadas: se a auditoria falhasse, as reservas já
 * estavam canceladas, a próxima execução não as achava mais e a oportunidade ficava `reservada` sem atribuição ativa. Agora uma falha reverte tudo (as reservas
 * continuam vencidas e a próxima execução tenta de novo, sem auditoria duplicada). Uma falha numa oportunidade não impede as demais; ao final, se alguma falhou, a
 * execução é registrada como falha (com a lista) e o erro é propagado.
 *
 * Ordem de travas (a mesma de decisão/logística/recebimento): atribuições (as que vão expirar) → linha da oportunidade (dentro dos helpers de conclusão/reabertura)
 * → auditoria por último. Travar as atribuições com `FOR UPDATE` e refiltrar sob a trava faz uma decisão humana concorrente (aceitar/recusar) ou ganhar (a reserva
 * não expira) ou perder (a decisão fica rejeitada porque a atribuição já foi cancelada) — nunca as duas coisas.
 */
export async function expireReservations() {
  await withScheduledTaskLock("expireReservations", () => runExpireReservations());
}

type ExpiredForOpportunity = { expired: number; concluded: boolean; reopened: boolean };

async function expireForOpportunity(opportunityRegistryId: number): Promise<ExpiredForOpportunity> {
  return db.transaction().execute(async (trx) => {
    const expired = await trx
      .selectFrom("opportunityAllocations")
      .select(["id", "organizationId"])
      .where("opportunityRegistryId", "=", opportunityRegistryId)
      .where("status", "=", "proposta")
      .where("autoMatched", "=", true)
      .where("reservedUntil", "is not", null)
      .where("reservedUntil", "<", new Date())
      .orderBy("id")
      .forUpdate()
      .execute();
    // Refiltrado sob a trava: se uma decisão humana mudou a atribuição enquanto esperávamos, ela não aparece mais aqui.
    if (expired.length === 0) return { expired: 0, concluded: false, reopened: false };

    await trx
      .updateTable("opportunityAllocations")
      .set({ status: "cancelada", closedAt: new Date(), closedReason: "reserva_expirada", updatedAt: new Date() })
      .where("id", "in", expired.map((a) => a.id))
      .where("status", "=", "proposta")
      .execute();

    // Mesma ordem dos outros caminhos: conclui primeiro; só tenta reabrir se não concluiu. Ambos travam a linha da oportunidade ANTES de qualquer auditoria.
    const concluded = await concludeOpportunityIfAllTerminalAndReceived(trx, opportunityRegistryId);
    const reopened = concluded ? false : await reopenOpportunityIfNoActiveAllocations(trx, opportunityRegistryId);

    for (const a of expired) {
      await recordAuditLogEntry(
        {
          organizationId: a.organizationId,
          actorUserId: null,
          action: "atribuicao.reserva_expirada",
          entityType: "opportunity_allocation",
          entityId: String(a.id),
          metadata: { opportunityRegistryId },
        },
        trx
      );
    }
    if (concluded) {
      await recordAuditLogEntry(
        { organizationId: null, actorUserId: null, action: "descoberta_central.concluida", entityType: "opportunity_registry", entityId: String(opportunityRegistryId), metadata: {} },
        trx
      );
    }
    return { expired: expired.length, concluded, reopened };
  });
}

const AGGREGATE_ERROR_PREFIX = "expireReservations: ";

async function runExpireReservations() {
  const claim = await claimTaskRun({ taskName: "expireReservations" });
  if (!claim.claimed) return;

  try {
    const due = await db
      .selectFrom("opportunityAllocations")
      .select("opportunityRegistryId")
      .distinct()
      .where("status", "=", "proposta")
      .where("autoMatched", "=", true)
      .where("reservedUntil", "is not", null)
      .where("reservedUntil", "<", new Date())
      .orderBy("opportunityRegistryId")
      .execute();

    let reservasExpiradas = 0;
    const toRematch: number[] = [];
    const failures: Array<{ opportunityId: number; message: string }> = [];
    for (const { opportunityRegistryId } of due) {
      try {
        const r = await expireForOpportunity(opportunityRegistryId);
        reservasExpiradas += r.expired;
        if (r.reopened) toRematch.push(opportunityRegistryId);
      } catch (err) {
        failures.push({ opportunityId: opportunityRegistryId, message: err instanceof Error ? err.message : String(err) });
      }
    }

    // Recuperação: oportunidade presa em `reservada`/`atribuida` sem nenhuma atribuição em andamento (ex.: execução antiga morta no meio).
    const recovery = await recoverStuckOpportunities();
    toRematch.push(...recovery.reopened);
    for (const f of recovery.failed) failures.push(f);

    for (const oppId of toRematch) {
      try {
        await runMatchingForOpportunity(oppId, null, "expiracao");
      } catch (err) {
        // A oportunidade já está `aguardando_destinacao` (transação confirmada): o sweep periódico a avaliará depois.
        failures.push({ opportunityId: oppId, message: `rematch: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    if (failures.length > 0) {
      const error = new Error(`${AGGREGATE_ERROR_PREFIX}${failures.length} oportunidade(s) com falha (as demais foram processadas)`);
      await failTaskRun(claim.runId, error, { falhas: failures.slice(0, 20).map((f) => ({ opportunityId: f.opportunityId, message: f.message.slice(0, 300) })) });
      throw error;
    }

    await finishTaskRun(claim.runId, {
      reservasExpiradas,
      oportunidadesReavaliadas: due.length,
      recuperadasReabertas: recovery.reopened.length,
      recuperadasConcluidas: recovery.concluded.length,
    });
  } catch (err) {
    // O erro agregado já foi gravado acima com a lista de falhas; qualquer outra falha (ex.: a consulta inicial) é registrada aqui.
    if (!(err instanceof Error && err.message.startsWith(AGGREGATE_ERROR_PREFIX))) await failTaskRun(claim.runId, err);
    throw err;
  }
}
