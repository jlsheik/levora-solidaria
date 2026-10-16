import { claimTaskRun, finishTaskRun, failTaskRun } from "./backgroundTasks.js";
import { withScheduledTaskLock } from "./scheduledTaskLock.js";
import { runFileScanRetries } from "./fileScanQueue.js";
import type { Json } from "./schema.js";

/**
 * Tarefa agendada (a cada 5 min, scheduled-jobs.json): reanálise automática dos arquivos retidos (fila durável em `files`, ver fileScanQueue.tsx). Trava de sessão evita duas execuções
 * simultâneas da MESMA tarefa neste banco; o `FOR UPDATE SKIP LOCKED` + lease continua protegendo contra outro processo mesmo se a trava não valer. Sem scanner configurado (ou com a análise
 * desligada) a execução é registrada como "pulada" e NÃO consome tentativas. Cada execução fica em `background_task_runs` (resultado agregado, sem nomes nem conteúdo de arquivos).
 */
export async function retryFileScansScheduled(): Promise<void> {
  await withScheduledTaskLock("retryFileScans", () => run());
}

async function run(): Promise<void> {
  const claim = await claimTaskRun({ taskName: "retryFileScans" });
  if (!claim.claimed) return;
  try {
    const summary = await runFileScanRetries();
    await finishTaskRun(claim.runId, { kind: summary.skipped ? "skipped" : "retry_run", ...summary } as unknown as Json);
  } catch (error) {
    await failTaskRun(claim.runId, error);
    throw error;
  }
}
