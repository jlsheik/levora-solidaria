import React from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, RefreshCw } from "lucide-react";
import { getFileScanOperations } from "../endpoints/file-scan-operations_GET.schema";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Skeleton } from "./Skeleton";
import { ALERT_COPY, LEVEL_COPY, backlogMetrics, formatDurationMs, formatInstant, formatMinutes, modeLabel, scannerLine, summarize, type Tone } from "./fileScanOperationsView";
import styles from "./FileScanOperationsPanel.module.css";

const badgeVariant = (tone: Tone) => (tone === "ok" ? "success" : tone === "attention" ? "destructive" : "warning") as "success" | "destructive" | "warning";
const toneLabel = (tone: Tone) => (tone === "ok" ? "Em ordem" : tone === "attention" ? "Atenção" : "Pendente de definição");

/**
 * M32 — Saúde da análise antimalware de arquivos (somente administração da plataforma). Mostra, a partir de `GET /file-scan-operations`, o estado do serviço de análise, a fila de arquivos
 * retidos, o reprocessamento automático e os sinais operacionais. Somente leitura: não existe ação aqui (a reanálise por arquivo continua no fluxo do próprio comprovante) e nenhum nome de
 * arquivo, organização ou chave de armazenamento é exibido — o endpoint só devolve contagens, idades e estados. “Limiar não definido” nunca é apresentado como verde.
 */
export function FileScanOperationsPanel() {
  const query = useQuery({ queryKey: ["file-scan-operations"], queryFn: () => getFileScanOperations(), retry: false, refetchInterval: 60_000, refetchIntervalInBackground: false });
  const data = query.data;
  const summary = data ? summarize(data) : null;
  const scanner = data ? scannerLine(data) : null;

  return (
    <section className={styles.section} aria-labelledby="scan-ops-titulo" aria-busy={query.isFetching}>
      <div className={styles.header}>
        <h2 id="scan-ops-titulo" className={styles.title}><ShieldCheck size={18} aria-hidden="true" /> Análise antimalware de arquivos</h2>
        <div className={styles.headerActions}>
          {data && <span className={styles.updated}>Atualizado em {formatInstant(data.generatedAt)}</span>}
          <Button type="button" size="sm" variant="outline" onClick={() => query.refetch()} disabled={query.isFetching} aria-label="Atualizar indicadores da análise de arquivos">
            <RefreshCw size={14} aria-hidden="true" /> {query.isFetching ? "Atualizando..." : "Atualizar"}
          </Button>
        </div>
      </div>
      <p className={styles.help}>
        Arquivos enviados só são liberados depois de aprovados pela análise. Aqui você acompanha o serviço de análise, a fila de arquivos retidos e o reprocessamento automático.
        Os números são globais e não mostram nomes de arquivos nem de organizações.
      </p>

      {query.isError ? (
        <div className={styles.error}>
          <p className={styles.errorText} role="alert">Não foi possível carregar os indicadores. {query.error instanceof Error ? query.error.message : ""}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>Tentar de novo</Button>
        </div>
      ) : !data || !summary || !scanner ? (
        <Skeleton className={styles.skeleton} />
      ) : (
        <>
          <div className={`${styles.summary} ${summary.tone === "attention" ? styles.summaryAttention : summary.tone === "undefined" ? styles.summaryUndefined : ""}`} role="status" aria-live="polite">
            <Badge variant={badgeVariant(summary.tone)}>{toneLabel(summary.tone)}</Badge>
            <span className={styles.summaryText}>{summary.headline}</span>
          </div>

          <h3 className={styles.subTitle}>Serviço de análise</h3>
          <div className={styles.scanner}>
            <span className={styles.scannerState}>{scanner.state} <Badge variant={badgeVariant(scanner.tone)}>{toneLabel(scanner.tone)}</Badge></span>
            <span className={styles.scannerDetail}>{scanner.detail}</span>
            <span className={styles.scannerDetail}>Análise: {modeLabel(data.mode)}</span>
          </div>

          <h3 className={styles.subTitle}>Fila de arquivos retidos</h3>
          <dl className={styles.grid}>
            {backlogMetrics(data.backlog).map((m) => (
              <div key={m.key} className={`${styles.metric} ${m.tone === "attention" ? styles.metricAttention : ""}`}>
                <dt className={styles.metricLabel}>{m.label}</dt>
                <dd className={styles.metricValue}>{m.value}</dd>
                {m.hint && <dd className={styles.metricHint}>{m.hint}</dd>}
              </div>
            ))}
          </dl>

          <h3 className={styles.subTitle}>Reprocessamento automático e últimas 24 h</h3>
          <dl className={styles.grid}>
            <div className={styles.metric}><dt className={styles.metricLabel}>Última execução do worker</dt><dd className={styles.metricValue}>{data.worker.lastRunAt ? formatInstant(data.worker.lastRunAt) : "Nunca executou"}</dd><dd className={styles.metricHint}>{data.worker.lastRunAgeMinutes !== null ? `há ${formatMinutes(data.worker.lastRunAgeMinutes)} · ${data.worker.lastStatus ?? "sem status"}` : "Sem execução registrada"}</dd></div>
            <div className={styles.metric}><dt className={styles.metricLabel}>Execuções / falhas (24 h)</dt><dd className={styles.metricValue}>{data.worker.runsLast24h} / {data.worker.failedLast24h}</dd></div>
            <div className={styles.metric}><dt className={styles.metricLabel}>Aprovadas (24 h)</dt><dd className={styles.metricValue}>{data.analysesLast24h.aprovadas.toLocaleString("pt-BR")}</dd></div>
            <div className={styles.metric}><dt className={styles.metricLabel}>Infectadas (24 h)</dt><dd className={styles.metricValue}>{data.analysesLast24h.infectadas.toLocaleString("pt-BR")}</dd></div>
            <div className={styles.metric}><dt className={styles.metricLabel}>Indisponíveis (24 h)</dt><dd className={styles.metricValue}>{data.analysesLast24h.indisponiveis.toLocaleString("pt-BR")}</dd></div>
            <div className={styles.metric}><dt className={styles.metricLabel}>Duração da análise (média / máx.)</dt><dd className={styles.metricValue}>{formatDurationMs(data.analysesLast24h.duracaoMediaMs)} / {formatDurationMs(data.analysesLast24h.duracaoMaxMs)}</dd></div>
          </dl>

          <h3 className={styles.subTitle}>Sinais operacionais</h3>
          <ul className={styles.alerts}>
            {data.alerts.map((a) => {
              const copy = ALERT_COPY[a.code];
              const level = LEVEL_COPY[a.level];
              return (
                <li key={a.code} className={styles.alertRow}>
                  <Badge variant={badgeVariant(level.tone)}>{level.label}</Badge>
                  <div className={styles.alertBody}>
                    <strong>{copy.title}</strong>
                    <span>{a.detail}</span>
                    <span>{copy.help}</span>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className={styles.footnote}>
            Os limites de “envelhecimento” e de “worker sem executar” dependem de decisão operacional (variáveis <code>FILE_SCAN_ALERT_BACKLOG_MINUTES</code> e <code>FILE_SCAN_ALERT_WORKER_MINUTES</code>); enquanto não forem definidos, aparecem como
            “Limiar não definido” — isso não significa que esteja tudo bem. Este painel apenas mostra sinais: não envia alertas a ninguém.
          </p>
        </>
      )}
    </section>
  );
}
