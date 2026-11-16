/**
 * Controle explícito de habilitação de tarefas agendadas (M46).
 *
 * Por que existe: `scheduled-jobs.json` é a configuração REAL do agendador. Uma tarefa que processa agentes (`processAgentEvents`) não pode começar a rodar só porque
 * o código foi implantado num ambiente novo. Estas tarefas exigem uma habilitação explícita por variável de ambiente (`enableWith` no JSON); sem ela a tarefa nunca é
 * registrada no cron, não é executada por `handler()` e não pode ser reprocessada manualmente. A mesma função decide nos três pontos de entrada
 * (registro do cron, tarefa em si, reprocessamento manual), então nenhum caminho contorna o controle.
 *
 * Só o valor exato "true" habilita. Ausente, vazio, "1", "yes" ou "TRUE" = desabilitado (estado padrão seguro).
 */

export interface TaskEnablementConfig {
  enabled?: boolean;
  /** Nome da variável de ambiente que precisa valer exatamente "true" para a tarefa poder rodar. */
  enableWith?: string;
}

/** Tarefas que NUNCA rodam sem opt-in, mesmo se o JSON for editado para `enabled: true` sem `enableWith`. */
export const OPT_IN_TASKS: Record<string, string> = {
  processAgentEvents: "AGENT_EVENTS_SCHEDULER_ENABLED",
};

export function requiredEnvFor(taskName: string, config?: TaskEnablementConfig): string | null {
  return OPT_IN_TASKS[taskName] ?? config?.enableWith ?? null;
}

export type TaskEnablement =
  | { enabled: true }
  | { enabled: false; reason: "desabilitada_no_json" | "habilitacao_explicita_ausente"; requiredEnv: string | null };

export function getTaskEnablement(taskName: string, config?: TaskEnablementConfig, env: NodeJS.ProcessEnv = process.env): TaskEnablement {
  const requiredEnv = requiredEnvFor(taskName, config);
  if (requiredEnv) {
    return env[requiredEnv] === "true" ? { enabled: true } : { enabled: false, reason: "habilitacao_explicita_ausente", requiredEnv };
  }
  if (config && config.enabled === false) return { enabled: false, reason: "desabilitada_no_json", requiredEnv: null };
  return { enabled: true };
}

/** Usado pela própria tarefa e pelo reprocessamento manual (que não passam pelo JSON). */
export function isOptInTaskEnabled(taskName: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const requiredEnv = OPT_IN_TASKS[taskName];
  return requiredEnv ? env[requiredEnv] === "true" : true;
}

export interface SchedulerStatusEntry {
  task: string;
  state: "ativa" | "desabilitada";
  reason?: string;
}

/** Estado conhecido das tarefas, preenchido por startScheduler; lido pelo endpoint de prontidão. Contém só nomes de tarefa e estado. */
let schedulerStatus: { started: boolean; tasks: SchedulerStatusEntry[] } = { started: false, tasks: [] };

export function setSchedulerStatus(status: { started: boolean; tasks: SchedulerStatusEntry[] }): void {
  schedulerStatus = status;
}

export function getSchedulerStatus(): { started: boolean; tasks: SchedulerStatusEntry[] } {
  return schedulerStatus;
}
