/**
 * Política de NOVAS TENTATIVAS da análise antimalware. Todos os valores são CONFIGURAÇÃO explícita com padrões de engenharia; **nenhum foi aprovado como política operacional** (ver
 * docs/PLANO_IMPLANTACAO_SCANNER.md, "Decisões operacionais pendentes"). Esgotar as tentativas NUNCA libera o arquivo.
 */
export interface FileScanRetryConfig {
  /** Tentativas automáticas antes de esgotar (depois só a reanálise manual autorizada). */
  maxAttempts: number;
  /** Base do backoff exponencial, em segundos. */
  baseSeconds: number;
  /** Teto do atraso, em segundos. */
  maxSeconds: number;
  /** Arquivos reivindicados por execução. */
  batchSize: number;
  /** Análises simultâneas dentro de uma execução. */
  concurrency: number;
  /** Duração da reivindicação (lease) de um arquivo; vencida = tarefa abandonada, elegível de novo. */
  leaseSeconds: number;
  /** Arquivo `pendente` recém-enviado só entra na fila depois deste tempo (a análise do próprio upload ainda pode estar em curso). */
  pendingGraceSeconds: number;
}

const int = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : d;
};

export function getFileScanRetryConfig(env: NodeJS.ProcessEnv = process.env): FileScanRetryConfig {
  return {
    maxAttempts: int(env.FILE_SCAN_RETRY_MAX_ATTEMPTS, 8, 1, 100),
    baseSeconds: int(env.FILE_SCAN_RETRY_BASE_SECONDS, 60, 1, 86_400),
    maxSeconds: int(env.FILE_SCAN_RETRY_MAX_SECONDS, 3600, 1, 604_800),
    batchSize: int(env.FILE_SCAN_RETRY_BATCH, 10, 1, 200),
    concurrency: int(env.FILE_SCAN_RETRY_CONCURRENCY, 2, 1, 16),
    leaseSeconds: int(env.FILE_SCAN_LEASE_SECONDS, 300, 30, 3600),
    pendingGraceSeconds: int(env.FILE_SCAN_PENDING_GRACE_SECONDS, 120, 0, 3600),
  };
}

/** Atraso (s) antes da tentativa seguinte, depois de `attempts` tentativas: base·2^(n−1) limitado ao teto, com jitter de 50–100% (injetável nos testes). */
export function nextDelaySeconds(attempts: number, cfg: FileScanRetryConfig, random: () => number = Math.random): number {
  const raw = cfg.baseSeconds * 2 ** Math.max(0, attempts - 1);
  const capped = Math.min(cfg.maxSeconds, raw);
  return Math.max(1, Math.round(capped * (0.5 + 0.5 * random())));
}
