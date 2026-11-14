/**
 * Disparo real das tarefas agendadas listadas em
 * src/static/__dev/scheduled-jobs.json.
 *
 * IMPORTANTE — lacuna que este arquivo fecha: no Floot original, um
 * mecanismo de plataforma (fora deste repositório) lia esse JSON e
 * disparava cada tarefa no horário configurado. Essa peça nunca foi
 * portada na migração para Express — o JSON continuava existindo, as
 * funções de tarefa (expireReservations, expireOpportunities,
 * runMatchingSweep) continuavam existindo e corretas, mas **nada as
 * chamava periodicamente**. Reservas de matching "expiram em 30 minutos"
 * e oportunidades "expiram" eram promessas na documentação que não se
 * cumpriam sozinhas fora de um reprocessamento manual pelo admin da
 * plataforma. Isto é exatamente o tipo de lacuna que a regra do projeto
 * contra "fake features" proíbe deixar sem sinalização — por isso este
 * arquivo existe: um agendador real, em processo, usando node-cron.
 *
 * Uma falha em uma execução é logada e isolada (não derruba o processo
 * nem as outras tarefas agendadas) — cada função de tarefa já registra
 * seu próprio backgroundTaskRuns/failTaskRun internamente.
 */
import cron from "node-cron";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TASK_HANDLERS } from "./taskHandlers.js";
import { getTaskEnablement, setSchedulerStatus, type SchedulerStatusEntry, type TaskEnablementConfig } from "./schedulerControl.js";
import { logEvent, newOperationId, safeErrorCode } from "./opLog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ScheduledJobConfig extends TaskEnablementConfig {
  enabled: boolean;
  schedule: string;
  timezone?: string;
}

export function startScheduler(): void {
  const configPath = path.resolve(__dirname, "../static/__dev/scheduled-jobs.json");
  let config: Record<string, ScheduledJobConfig>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (error) {
    console.error(`Agendador não iniciado: falha ao ler ${configPath}:`, error);
    return;
  }

  let started = 0;
  const status: SchedulerStatusEntry[] = [];
  for (const [taskName, jobConfig] of Object.entries(config)) {
    // M46: habilitação explícita. Tarefas com opt-in (processAgentEvents) só entram no cron com a variável de ambiente exata; o estado padrão é desabilitado.
    const enablement = getTaskEnablement(taskName, jobConfig);
    if (!enablement.enabled) {
      status.push({ task: taskName, state: "desabilitada", reason: enablement.reason });
      logEvent({ event: "scheduler_task_disabled", status: "ignorado", context: { task: taskName, reason: enablement.reason } });
      continue;
    }

    const handler = TASK_HANDLERS[taskName];
    if (!handler) {
      console.warn(`Agendador: "${taskName}" está em scheduled-jobs.json mas não tem handler registrado em scheduler.tsx — ignorando.`);
      continue;
    }

    if (!cron.validate(jobConfig.schedule)) {
      console.error(`Agendador: expressão cron inválida para "${taskName}": "${jobConfig.schedule}" — ignorando.`);
      continue;
    }

    cron.schedule(
      jobConfig.schedule,
      () => {
        const operationId = newOperationId();
        const startedAt = Date.now();
        handler()
          .then(() => logEvent({ event: "scheduled_task", status: "ok", operationId, durationMs: Date.now() - startedAt, context: { task: taskName } }))
          .catch((err) => {
            // As funções de tarefa já gravam a falha em background_task_runs
            // (failTaskRun); aqui só evitamos que uma exceção não tratada
            // derrube o processo do servidor. O log leva só um código seguro (nunca a mensagem do erro).
            logEvent({ event: "scheduled_task", status: "falha", operationId, durationMs: Date.now() - startedAt, errorCode: safeErrorCode(err), context: { task: taskName } });
          });
      },
      { timezone: jobConfig.timezone ?? "UTC" }
    );
    started += 1;
    status.push({ task: taskName, state: "ativa" });
    console.log(`Agendador: "${taskName}" registrado (${jobConfig.schedule}, ${jobConfig.timezone ?? "UTC"})`);
  }

  setSchedulerStatus({ started: true, tasks: status });
  console.log(`Agendador: ${started} tarefa(s) agendada(s) ativa(s).`);
}
