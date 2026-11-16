import { claimTaskRun, finishTaskRun, failTaskRun } from "./backgroundTasks.js";
import { withScheduledTaskLock } from "./scheduledTaskLock.js";
import { runAgentEventEngine } from "./agentEventEngine.js";
import type { Json } from "./schema.js";
import { isOptInTaskEnabled } from "./schedulerControl.js";
import { logEvent } from "./opLog.js";

/**
 * Tarefa agendada (a cada 5 min, scheduled-jobs.json): uma passada do motor de eventos dos agentes (M34), SOMENTE SIMULAÇÃO, para todas as organizações. É DESABILITADA por padrão (M46: só roda com AGENT_EVENTS_SCHEDULER_ENABLED=true) e, mesmo habilitada, inerte sem agente
 * REGISTRADO E LIGADO por uma pessoa, não há o que processar. Trava de sessão evita duas passadas da mesma tarefa; a UNIQUE (evento, agente) e as transições compare-and-set continuam protegendo
 * contra outro processo. Cada execução fica em `background_task_runs` só com contagens (sem conteúdo de evento).
 */
export async function processAgentEventsScheduled(): Promise<void> {
  // M46: guarda na própria tarefa (qualquer chamador: cron, reprocessamento manual, outro ponto de entrada). Sem a habilitação explícita não reivindica execução,
  // não lê eventos e não toca em nenhum agente.
  if (!isOptInTaskEnabled("processAgentEvents")) {
    logEvent({ event: "scheduled_task", status: "ignorado", context: { task: "processAgentEvents", reason: "habilitacao_explicita_ausente" } });
    return;
  }
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
