import { sql } from "kysely";
import { db } from "./db.js";
import { claimTaskRun, finishTaskRun, failTaskRun } from "./backgroundTasks.js";
import { runMatchingForOpportunity } from "./opportunityMatching.js";
import { recoverStuckOpportunities } from "./recoverStuckOpportunities.js";
import { withScheduledTaskLock } from "./scheduledTaskLock.js";

/** Oportunidades avaliadas por execução (inalterado: 20). */
export const SWEEP_BATCH_SIZE = 20;
/** Até metade do lote é reservada às oportunidades NUNCA avaliadas (as novas), para que uma oferta recém-chegada não espere a fila rodar inteira. */
export const SWEEP_NEVER_EVALUATED_QUOTA = 10;

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
 *
 * `withScheduledTaskLock` (achado de auditoria) impede que duas chamadas
 * concorrentes desta função executem o corpo simultaneamente — inclusive
 * uma varredura ainda processando as 20 oportunidades quando o próximo
 * tick do cron dispara de novo. `claimTaskRun` continua inalterado.
 *
 * FILA JUSTA (Fase 95). Antes, o lote era sempre "as 20 mais antigas": ofertas sem nenhuma necessidade compatível continuam `aguardando_destinacao`, então as
 * mesmas 20 ocupavam o lote para sempre e uma oferta mais nova e compatível nunca era avaliada (reproduzido: 20 sem correspondência + 1 compatível). Agora:
 *  1. até SWEEP_NEVER_EVALUATED_QUOTA vagas vão às oportunidades que ainda NÃO têm nenhum evento `matching.executado` (nunca avaliadas), da mais antiga para a mais nova;
 *  2. as demais vagas seguem um RODÍZIO por id, retomando depois do último id avaliado pela execução anterior (com volta ao início). O cursor é persistido
 *     no próprio registro da execução em `background_task_runs` (`result.cursor`, ou `error.cursor` se a execução terminou com falha), então sobrevive a
 *     reinicializações; duas execuções nunca rodam juntas (trava consultiva), e se o processo morrer no meio a próxima retoma do último cursor confirmado
 *     (reavaliar é idempotente: a trava da oportunidade e o filtro de organizações já atribuídas impedem atribuição duplicada).
 * Com isso toda oportunidade elegível é avaliada em, no máximo, ceil(N / 20) execuções — um ciclo completo —, e as novas, já na execução seguinte.
 * Cada oportunidade é processada isoladamente: uma que lance erro não trava a fila; as falhas são registradas e a execução termina como falha DEPOIS de
 * processar o lote inteiro.
 *
 * Também roda a recuperação de oportunidades presas em `reservada`/`atribuida` sem atribuição em andamento (ver recoverStuckOpportunities.tsx).
 *
 * Não muda pontuação, limiares (70/90), reserva de 30 min nem estados de decisão.
 */
export async function runMatchingSweep() {
  await withScheduledTaskLock("runMatchingSweep", () => runMatchingSweepBody());
}

/** Último id avaliado pelo rodízio na execução anterior (0 = começar do início). Lê o estado persistido; nunca memória do processo. */
async function readCursor(currentRunId: string): Promise<number> {
  const row = await db
    .selectFrom("backgroundTaskRuns")
    .select(sql<string | null>`COALESCE(result->>'cursor', error->>'cursor')`.as("cursor"))
    .where("taskName", "=", "runMatchingSweep")
    .where("id", "<>", currentRunId)
    .where(sql<boolean>`(result->>'cursor' IS NOT NULL OR error->>'cursor' IS NOT NULL)`)
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  const n = Number(row?.cursor ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export async function selectSweepBatch(cursor: number): Promise<{ fresh: number[]; rotation: number[] }> {
  const fresh = (
    await db
      .selectFrom("opportunityRegistry")
      .select("id")
      .where("status", "=", "aguardando_destinacao")
      .where(sql<boolean>`NOT EXISTS (
        SELECT 1 FROM audit_log al
        WHERE al.entity_type = 'opportunity_registry' AND al.entity_id = opportunity_registry.id::text AND al.action = 'matching.executado'
      )`)
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc")
      .limit(SWEEP_NEVER_EVALUATED_QUOTA)
      .execute()
  ).map((r) => r.id);

  let rotationQuery = db
    .selectFrom("opportunityRegistry")
    .select("id")
    .where("status", "=", "aguardando_destinacao")
    .orderBy(sql`(id <= ${cursor})`, "asc") // primeiro os de id maior que o cursor; depois volta ao início
    .orderBy("id", "asc")
    .limit(SWEEP_BATCH_SIZE - fresh.length);
  if (fresh.length > 0) rotationQuery = rotationQuery.where("id", "not in", fresh);
  const rotation = (await rotationQuery.execute()).map((r) => r.id);
  return { fresh, rotation };
}

async function runMatchingSweepBody() {
  const claim = await claimTaskRun({ taskName: "runMatchingSweep" });
  if (!claim.claimed) return;

  let cursor = 0;
  try {
    cursor = await readCursor(claim.runId);
    const failures: Array<{ opportunityId: number; message: string }> = [];

    const recovery = await recoverStuckOpportunities();
    for (const f of recovery.failed) failures.push(f);

    const { fresh, rotation } = await selectSweepBatch(cursor);
    let processed = 0;
    let matched = 0;
    let unchanged = 0;
    for (const id of [...fresh, ...rotation]) {
      try {
        const result = await runMatchingForOpportunity(id, null, "varredura");
        processed += 1;
        if (!result.skipped && result.allocationsCreated.length > 0) matched += 1;
        if (result.unchanged) unchanged += 1;
      } catch (err) {
        failures.push({ opportunityId: id, message: err instanceof Error ? err.message : String(err) });
      }
    }
    if (rotation.length > 0) cursor = rotation[rotation.length - 1];

    if (failures.length > 0) {
      const error = new Error(`runMatchingSweep: ${failures.length} oportunidade(s) com falha (as demais foram processadas)`);
      await failTaskRun(claim.runId, error, { cursor, falhas: failures.slice(0, 20).map((f) => ({ opportunityId: f.opportunityId, message: f.message.slice(0, 300) })) });
      throw error;
    }

    await finishTaskRun(claim.runId, {
      processadas: processed,
      comAtribuicaoCriada: matched,
      semMudancaRelevante: unchanged,
      novasAvaliadas: fresh.length,
      recuperadasReabertas: recovery.reopened.length,
      recuperadasConcluidas: recovery.concluded.length,
      cursor,
    });
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith("runMatchingSweep: "))) await failTaskRun(claim.runId, err, { cursor });
    throw err;
  }
}
