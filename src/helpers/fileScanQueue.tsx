/**
 * Fila DURÁVEL de reanálises antimalware: o próprio registro de `files` é a fila (estado `pendente`/`indisponivel`, sem esgotamento, fora do atraso de backoff e sem reivindicação vigente).
 * Reivindicação por `FOR UPDATE SKIP LOCKED` + lease: dois workers nunca recebem o mesmo arquivo; um worker que morre deixa o lease vencer e o arquivo volta a ser elegível (tarefa
 * abandonada recuperável). A tentativa é contada ao REIVINDICAR, então um arquivo que derruba o worker repetidamente também esgota. Nunca entram: `infectado` (final), `aprovado`
 * (final), `dispensado` e `legado_nao_analisado` (reanálise em lote é decisão separada — só manual por arquivo). Esgotar nunca libera.
 * Executada pela tarefa agendada `retryFileScans` (scheduler.tsx + trava de sessão), sem processo novo.
 */
import { sql } from "kysely";
import { db } from "./db.js";
import { scanFile } from "./fileScan.js";
import { UnconfiguredScanner, buildFileScanner, getScanMode } from "./fileScanner.js";
import { getFileScanRetryConfig, type FileScanRetryConfig } from "./fileScanRetry.js";
import { recordAuditLogEntry } from "./auditLog.js";

export interface ClaimedFile {
  id: number;
  organizationId: number;
}

/** Marca como esgotados os arquivos elegíveis que já consumiram todas as tentativas (inclusive por workers que morreram). Não altera scan_status. */
export async function exhaustSpentFiles(cfg: FileScanRetryConfig = getFileScanRetryConfig()): Promise<number> {
  const rows = await db.transaction().execute(async (trx) => {
    const spent = await sql<{ id: number; organizationId: number; attempts: number }>`
      UPDATE files SET scan_exhausted_at = now(), scan_lease_until = NULL, scan_next_attempt_at = NULL
       WHERE id IN (SELECT id FROM files WHERE scan_status IN ('pendente', 'indisponivel') AND scan_exhausted_at IS NULL AND scan_attempts >= ${cfg.maxAttempts}
                       AND (scan_lease_until IS NULL OR scan_lease_until < now()) FOR UPDATE SKIP LOCKED)
      RETURNING id, organization_id, scan_attempts AS attempts`.execute(trx);
    for (const r of spent.rows) {
      await recordAuditLogEntry({ organizationId: r.organizationId, actorUserId: null, action: "arquivo.analise_esgotada", entityType: "file", entityId: String(r.id), metadata: { tentativas: r.attempts, motivo: "tentativas_esgotadas_sem_resultado" } }, trx);
    }
    return spent.rows;
  });
  return rows.length;
}

/** Reivindica até `limit` arquivos elegíveis e incrementa a tentativa. Atômico: o UPDATE só afeta linhas que ESTA chamada travou. */
export async function claimFileScanBatch(limit: number, cfg: FileScanRetryConfig = getFileScanRetryConfig()): Promise<ClaimedFile[]> {
  const rows = await sql<{ id: number; organizationId: number }>`
    UPDATE files SET scan_attempts = scan_attempts + 1, scan_lease_until = now() + make_interval(secs => ${cfg.leaseSeconds})
     WHERE id IN (
       SELECT id FROM files
        WHERE scan_status IN ('pendente', 'indisponivel') AND scan_exhausted_at IS NULL AND scan_attempts < ${cfg.maxAttempts}
          AND (scan_next_attempt_at IS NULL OR scan_next_attempt_at <= now())
          AND (scan_lease_until IS NULL OR scan_lease_until < now())
          AND (scan_status <> 'pendente' OR scan_attempts > 0 OR created_at <= now() - make_interval(secs => ${cfg.pendingGraceSeconds}))
        ORDER BY coalesce(scan_next_attempt_at, created_at), id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING id, organization_id`.execute(db);
  return rows.rows.map((r) => ({ id: Number(r.id), organizationId: Number(r.organizationId) }));
}

export interface RetryRunSummary {
  skipped: "analise_desligada" | "scanner_nao_configurado" | null;
  exhaustedBefore: number;
  claimed: number;
  approved: number;
  infected: number;
  stillUnavailable: number;
  failed: number;
  durationMs: number;
}

/** Uma execução da fila: sem scanner configurado (ou análise desligada) NÃO consome tentativas — o backlog fica visível nas métricas. */
export async function runFileScanRetries(cfg: FileScanRetryConfig = getFileScanRetryConfig()): Promise<RetryRunSummary> {
  const t0 = Date.now();
  const empty = { exhaustedBefore: 0, claimed: 0, approved: 0, infected: 0, stillUnavailable: 0, failed: 0 };
  if (getScanMode() !== "required") return { skipped: "analise_desligada", ...empty, durationMs: Date.now() - t0 };
  if (buildFileScanner() instanceof UnconfiguredScanner) return { skipped: "scanner_nao_configurado", ...empty, durationMs: Date.now() - t0 };

  const exhaustedBefore = await exhaustSpentFiles(cfg);
  const claimed = await claimFileScanBatch(cfg.batchSize, cfg);
  const summary = { skipped: null, exhaustedBefore, claimed: claimed.length, approved: 0, infected: 0, stillUnavailable: 0, failed: 0, durationMs: 0 } as RetryRunSummary;
  let cursor = 0;
  const worker = async () => {
    while (cursor < claimed.length) {
      const f = claimed[cursor++];
      try {
        const r = await scanFile(f.id, f.organizationId, null);
        if (r.status === "aprovado") summary.approved++;
        else if (r.status === "infectado") summary.infected++;
        else summary.stillUnavailable++;
      } catch (e) {
        summary.failed++;
        console.error(`ANALISE_FALHOU fileId=${f.id} organizationId=${f.organizationId} (${e instanceof Error ? e.name : "erro"})`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency, Math.max(claimed.length, 1)) }, worker));
  summary.durationMs = Date.now() - t0;
  return summary;
}
