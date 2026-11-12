import { claimTaskRun, finishTaskRun, failTaskRun } from "./backgroundTasks.js";
import { withScheduledTaskLock } from "./scheduledTaskLock.js";
import { runAgentEventEngine } from "./agentEventEngine.js";
import type { Json } from "./schema.js";

/**
 * Tarefa agendada (a cada 5 min, scheduled-jobs.json): uma passada do motor de eventos dos agentes (M34), SOMENTE SIMULAÇÃO, para todas as organizações. É inerte por padrão: sem agente
 * REGISTRADO E LIGADO por uma pessoa, não há o que processar. Trava de sessão evita duas passadas da mesma tarefa; a UNIQUE (evento, agente) e as transições compare-and-set continuam protegendo
 * contra outro processo. Cada execução fica em `background_task_runs` só com contagens (sem conteúdo de evento).
 */
export async function processAgentEventsScheduled(): Promise<void> {
  await withScheduledTaskLock("processAgentEvents", () => run());
}

async function run(): Promise<void> {
  const claim = await claimTaskRun({ taskName: "processAgentEvents" });
  if (!claim.claimed) return;
  try {
    const summary = await runAgentEventEngine({ batchSize: 100 });
    await finishTaskRun(claim.runId, { kind: "agent_events", simulated: true, ...summary } as unknown as Json);
  } catch (error) {
    await failTaskRun(claim.runId, error);
    throw error;
  }
}
