/**
 * Indicadores operacionais GLOBAIS da análise antimalware (somente leitura; administração da plataforma). Só contagens, idades e estados: nunca nome de arquivo, organização, chave de
 * armazenamento, URL ou conteúdo. Os alertas são SINAIS calculados (não há envio externo); limiares que dependem de decisão operacional ficam `nao_definido` quando não configurados.
 */
import { sql } from "kysely";
import { db } from "./db.js";
import { getScanMode, getScannerHealth, type ScannerHealth } from "./fileScanner.js";
import { getFileScanRetryConfig } from "./fileScanRetry.js";

export type AlertLevel = "ok" | "alerta" | "nao_definido";
export interface OperationalAlert {
  code: "scanner_sem_resposta" | "assinaturas_antigas" | "assinaturas_desconhecidas" | "backlog_envelhecido" | "tarefas_abandonadas" | "tentativas_esgotadas" | "worker_sem_executar" | "falhas_recentes";
  level: AlertLevel;
  detail: string;
}

export interface FileScanOperations {
  generatedAt: string;
  mode: "required" | "disabled";
  scanner: ScannerHealth;
  backlog: {
    pendente: number;
    indisponivel: number;
    infectado: number;
    legadoNaoAnalisado: number;
    aguardandoNovaTentativa: number;
    abandonadas: number;
    esgotadas: number;
    pendenteMaisAntigoMinutos: number | null;
    indisponivelMaisAntigoMinutos: number | null;
  };
  retry: { maxAttempts: number; baseSeconds: number; maxSeconds: number; batchSize: number; concurrency: number; leaseSeconds: number };
  worker: { lastRunAt: string | null; lastStatus: string | null; lastResult: unknown; runsLast24h: number; failedLast24h: number; lastRunAgeMinutes: number | null };
  analysesLast24h: { aprovadas: number; infectadas: number; indisponiveis: number; duracaoMediaMs: number | null; duracaoMaxMs: number | null };
  alerts: OperationalAlert[];
}

const minutes = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

export async function buildFileScanOperations(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<FileScanOperations> {
  const cfg = getFileScanRetryConfig(env);
  const [scanner, counts, lastRun, runStats, analyses] = await Promise.all([
    getScannerHealth(now, env),
    sql<Record<string, string | null>>`
      SELECT count(*) FILTER (WHERE scan_status = 'pendente') AS pendente,
             count(*) FILTER (WHERE scan_status = 'indisponivel') AS indisponivel,
             count(*) FILTER (WHERE scan_status = 'infectado') AS infectado,
             count(*) FILTER (WHERE scan_status = 'legado_nao_analisado') AS legado,
             count(*) FILTER (WHERE scan_status IN ('pendente', 'indisponivel') AND scan_exhausted_at IS NULL AND scan_next_attempt_at > ${now}) AS aguardando,
             count(*) FILTER (WHERE scan_status IN ('pendente', 'indisponivel') AND scan_exhausted_at IS NULL AND scan_lease_until IS NOT NULL AND scan_lease_until < ${now}) AS abandonadas,
             count(*) FILTER (WHERE scan_status IN ('pendente', 'indisponivel') AND scan_exhausted_at IS NOT NULL) AS esgotadas,
             extract(epoch FROM (${now} - min(created_at) FILTER (WHERE scan_status = 'pendente'))) / 60 AS pendente_antigo,
             extract(epoch FROM (${now} - min(created_at) FILTER (WHERE scan_status = 'indisponivel'))) / 60 AS indisponivel_antigo
        FROM files`.execute(db),
    db.selectFrom("backgroundTaskRuns").select(["status", "result", "createdAt", "finishedAt"]).where("taskName", "=", "retryFileScans").orderBy("createdAt", "desc").limit(1).executeTakeFirst(),
    sql<{ runs: string; failed: string }>`SELECT count(*) AS runs, count(*) FILTER (WHERE status = 'falhou') AS failed FROM background_task_runs WHERE task_name = 'retryFileScans' AND created_at > ${new Date(now.getTime() - 24 * 3600_000)}`.execute(db),
    sql<{ aprovadas: string; infectadas: string; indisponiveis: string; media: string | null; maxima: string | null }>`
      SELECT count(*) FILTER (WHERE action = 'arquivo.analise_aprovada') AS aprovadas,
             count(*) FILTER (WHERE action = 'arquivo.bloqueado_por_analise') AS infectadas,
             count(*) FILTER (WHERE action IN ('arquivo.analise_indisponivel', 'arquivo.analise_esgotada')) AS indisponiveis,
             avg((metadata->>'duracaoMs')::numeric) AS media, max((metadata->>'duracaoMs')::numeric) AS maxima
        FROM audit_log WHERE created_at > ${new Date(now.getTime() - 24 * 3600_000)} AND action IN ('arquivo.analise_aprovada', 'arquivo.bloqueado_por_analise', 'arquivo.analise_indisponivel', 'arquivo.analise_esgotada')`.execute(db),
  ]);
  const c = counts.rows[0];
  const backlog = {
    pendente: Number(c.pendente),
    indisponivel: Number(c.indisponivel),
    infectado: Number(c.infectado),
    legadoNaoAnalisado: Number(c.legado),
    aguardandoNovaTentativa: Number(c.aguardando),
    abandonadas: Number(c.abandonadas),
    esgotadas: Number(c.esgotadas),
    pendenteMaisAntigoMinutos: minutes(c.pendenteAntigo),
    indisponivelMaisAntigoMinutos: minutes(c.indisponivelAntigo),
  };
  const lastRunAge = lastRun ? minutes((now.getTime() - lastRun.createdAt.getTime()) / 60_000) : null;
  const stats = runStats.rows[0];
  const a = analyses.rows[0];

  // Limiares dependentes de decisão operacional: variáveis explícitas; ausentes = nao_definido (nunca "ok" por omissão).
  const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const backlogMaxMin = num(env.FILE_SCAN_ALERT_BACKLOG_MINUTES);
  const workerMaxMin = num(env.FILE_SCAN_ALERT_WORKER_MINUTES);
  const oldest = Math.max(backlog.pendenteMaisAntigoMinutos ?? 0, backlog.indisponivelMaisAntigoMinutos ?? 0);
  const alerts: OperationalAlert[] = [
    scanner.configured
      ? { code: "scanner_sem_resposta", level: scanner.reachable ? "ok" : "alerta", detail: scanner.reachable ? "clamd respondeu ao PING" : "clamd sem resposta válida" }
      : { code: "scanner_sem_resposta", level: getScanMode(env) === "required" ? "alerta" : "nao_definido", detail: "scanner não configurado" },
    scanner.freshness === "antigo"
      ? { code: "assinaturas_antigas", level: "alerta", detail: `base carregada com ${scanner.signatureAgeHours} h (limite ${scanner.maxAgeHours} h)` }
      : { code: "assinaturas_antigas", level: scanner.freshness === "atual" ? "ok" : "nao_definido", detail: scanner.freshness === "atual" ? "dentro do limite configurado" : "idade não avaliável" },
    { code: "assinaturas_desconhecidas", level: scanner.freshness === "desconhecido" ? "alerta" : "ok", detail: scanner.freshness === "desconhecido" ? "versão/data da base carregada indisponível ou limite não configurado" : "versão e data conhecidas" },
    backlogMaxMin === null ? { code: "backlog_envelhecido", level: "nao_definido", detail: "FILE_SCAN_ALERT_BACKLOG_MINUTES não definido" } : { code: "backlog_envelhecido", level: oldest > backlogMaxMin ? "alerta" : "ok", detail: `mais antigo: ${oldest} min (limite ${backlogMaxMin})` },
    { code: "tarefas_abandonadas", level: backlog.abandonadas > 0 ? "alerta" : "ok", detail: `${backlog.abandonadas} com lease vencido` },
    { code: "tentativas_esgotadas", level: backlog.esgotadas > 0 ? "alerta" : "ok", detail: `${backlog.esgotadas} aguardando reanálise manual` },
    workerMaxMin === null ? { code: "worker_sem_executar", level: "nao_definido", detail: "FILE_SCAN_ALERT_WORKER_MINUTES não definido" } : { code: "worker_sem_executar", level: lastRunAge === null || lastRunAge > workerMaxMin ? "alerta" : "ok", detail: lastRunAge === null ? "nunca executou" : `última há ${lastRunAge} min (limite ${workerMaxMin})` },
    { code: "falhas_recentes", level: Number(stats.failed) > 0 ? "alerta" : "ok", detail: `${stats.failed} execuções com falha nas últimas 24 h` },
  ];

  return {
    generatedAt: now.toISOString(),
    mode: getScanMode(env),
    scanner,
    backlog,
    retry: { maxAttempts: cfg.maxAttempts, baseSeconds: cfg.baseSeconds, maxSeconds: cfg.maxSeconds, batchSize: cfg.batchSize, concurrency: cfg.concurrency, leaseSeconds: cfg.leaseSeconds },
    worker: { lastRunAt: lastRun ? lastRun.createdAt.toISOString() : null, lastStatus: lastRun?.status ?? null, lastResult: lastRun?.result ?? null, runsLast24h: Number(stats.runs), failedLast24h: Number(stats.failed), lastRunAgeMinutes: lastRunAge },
    analysesLast24h: { aprovadas: Number(a.aprovadas), infectadas: Number(a.infectadas), indisponiveis: Number(a.indisponiveis), duracaoMediaMs: a.media === null ? null : Math.round(Number(a.media)), duracaoMaxMs: a.maxima === null ? null : Math.round(Number(a.maxima)) },
    alerts,
  };
}
