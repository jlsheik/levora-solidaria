import { db } from "./db";
import { claimTaskRun, finishTaskRun, failTaskRun } from "./backgroundTasks";
import { runMatchingForOpportunity } from "./opportunityMatching";

/**
 * Tarefa agendada: rede de segurança do matching automático. Toda entrada
 * em "aguardando destinação" já dispara matching na hora (ver
 * opportunity-registry-status_POST). Esta varredura existe para pegar
 * qualquer oportunidade que tenha ficado nesse status sem nenhuma
 * atribuição ativa (ex: matching anterior não encontrou candidato bom o
 * suficiente, e uma necessidade nova pode ter surgido desde então).
 * Processa no máximo 20 por execução, de forma síncrona dentro dos 15
 * minutos de limite do invocador — suficiente para o volume atual; se
 * crescer, isso vira fan-out com `queueTask`.
 */
export async function runMatchingSweep() {
  const claim = await claimTaskRun({ taskName: "runMatchingSweep" });
  if (!claim.claimed) return;

  try {
    const pending = await db
      .selectFrom("opportunityRegistry")
      .select(["id"])
      .where("status", "=", "aguardando_destinacao")
      .orderBy("createdAt", "asc")
      .limit(20)
      .execute();

    let processed = 0;
    let matched = 0;
    for (const opp of pending) {
      const result = await runMatchingForOpportunity(opp.id, null);
      processed += 1;
      if (!result.skipped && result.allocationsCreated.length > 0) matched += 1;
    }

    await finishTaskRun(claim.runId, { processadas: processed, comAtribuicaoCriada: matched });
  } catch (err) {
    await failTaskRun(claim.runId, err);
    throw err;
  }
}
