/**
 * Orquestra a análise antimalware de UM arquivo já armazenado: baixa o objeto (do provedor gravado), chama o scanner e registra o resultado com atualização CONDICIONAL (só sai de
 * pendente/indisponível/legado) + auditoria na mesma transação. Idempotente e seguro sob concorrência: dois pedidos simultâneos podem analisar; só um grava; o outro devolve o estado
 * gravado. Falha de auditoria desfaz a gravação (o arquivo continua não liberado). Nunca apaga o objeto (infectado/pendente ficam isolados até decisão de retenção).
 *
 * Novas tentativas (fila): cada indisponibilidade mantém `scan_attempts`, agenda `scan_next_attempt_at` (backoff com jitter) e, ao esgotar `FILE_SCAN_RETRY_MAX_ATTEMPTS`, marca
 * `scan_exhausted_at` — o arquivo CONTINUA bloqueado e só volta pela reanálise manual autorizada (`manual: true`). Aprovado/infectado são finais e limpam os campos de fila.
 */
import { db } from "./db.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { adapterForProvider } from "./storageAdapter.js";
import { buildFileScanner, getScanMode, isReleasable, type ScanUnavailableReason } from "./fileScanner.js";
import { getFileScanRetryConfig, nextDelaySeconds } from "./fileScanRetry.js";

export type ScanStatus = "pendente" | "aprovado" | "infectado" | "indisponivel" | "dispensado" | "legado_nao_analisado";
const RESCANNABLE: ScanStatus[] = ["pendente", "indisponivel", "legado_nao_analisado"];

export interface ScanResult {
  status: ScanStatus;
  reason?: ScanUnavailableReason;
  released: boolean;
  exhausted?: boolean;
}

/** Mensagem segura para o usuário (sem detalhes do scanner). */
export function scanMessage(status: string): string {
  switch (status) {
    case "aprovado":
    case "dispensado":
      return "Arquivo liberado.";
    case "infectado":
      return "O arquivo foi bloqueado por segurança e não pode ser usado. Envie outro arquivo.";
    case "indisponivel":
      return "A análise de segurança está temporariamente indisponível. O arquivo ficou retido; tente analisar novamente em instantes ou procure um administrador.";
    default:
      return "O arquivo aguarda a análise de segurança e ainda não foi liberado.";
  }
}

export interface ScanOptions {
  /** Reanálise MANUAL autorizada: zera tentativas/esgotamento antes de analisar. */
  manual?: boolean;
  /** Injeção para testes (jitter determinístico). */
  random?: () => number;
}

export async function scanFile(fileId: number, organizationId: number, actorUserId: number | null, options: ScanOptions = {}): Promise<ScanResult> {
  const file = await db.selectFrom("files").select(["id", "organizationId", "storageProvider", "storageKey", "scanStatus"]).where("id", "=", fileId).where("organizationId", "=", organizationId).executeTakeFirst();
  if (!file) throw new Error("arquivo inexistente");
  const current = file.scanStatus as ScanStatus;
  if (!RESCANNABLE.includes(current)) return { status: current, released: isReleasable(current) };

  if (options.manual) {
    // retomada manual autorizada: o esgotamento/atraso não valem mais; o estado de liberação não muda aqui
    await db.transaction().execute(async (trx) => {
      const r = await trx
        .updateTable("files")
        .set({ scanAttempts: 0, scanNextAttemptAt: null, scanExhaustedAt: null, scanLeaseUntil: null } as never)
        .where("id", "=", fileId)
        .where("organizationId", "=", organizationId)
        .where("scanStatus", "in", RESCANNABLE)
        .where("scanExhaustedAt", "is not", null)
        .returning(["id"])
        .executeTakeFirst();
      if (r) await recordAuditLogEntry({ organizationId, actorUserId, action: "arquivo.analise_retomada_manual", entityType: "file", entityId: String(fileId), metadata: { modo: getScanMode() } }, trx);
    });
  }

  const scanner = buildFileScanner();
  const started = Date.now();
  let outcome: Awaited<ReturnType<typeof scanner.scan>>;
  try {
    const buffer = await adapterForProvider(file.storageProvider).download(file.storageKey);
    outcome = await scanner.scan(buffer);
  } catch {
    outcome = { status: "indisponivel", reason: "erro_inesperado" };
  }
  const durationMs = Date.now() - started;

  const next: ScanStatus = outcome.status === "limpo" ? "aprovado" : outcome.status === "infectado" ? "infectado" : "indisponivel";
  const engine = outcome.status === "indisponivel" ? scanner.name : `${scanner.name}${outcome.engine ? ` ${outcome.engine}` : ""}`.slice(0, 200);
  const cfg = getFileScanRetryConfig();
  const written = await db.transaction().execute(async (trx) => {
    // trava a linha: o estado é relido sob a trava e a gravação só vale se o arquivo ainda está em estado reanalisável e é o MESMO objeto analisado
    const row = await trx
      .selectFrom("files")
      .select(["scanStatus", "scanAttempts", "scanExhaustedAt", "storageKey"])
      .where("id", "=", fileId)
      .where("organizationId", "=", organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || !RESCANNABLE.includes(row.scanStatus as ScanStatus) || row.storageKey !== file.storageKey) return null;

    const unavailable = outcome.status === "indisponivel";
    const attempts = unavailable ? Math.max(row.scanAttempts, 1) : row.scanAttempts;
    const exhausted = unavailable && attempts >= cfg.maxAttempts;
    const newlyExhausted = exhausted && row.scanExhaustedAt === null;
    const patch: Record<string, unknown> = {
      scanStatus: next,
      scanCheckedAt: new Date(),
      scanEngine: engine,
      scanSignature: outcome.status === "infectado" ? outcome.signature : null,
      scanLeaseUntil: null,
      scanAttempts: attempts,
      scanLastReason: outcome.status === "indisponivel" ? outcome.reason : null,
      scanNextAttemptAt: unavailable && !exhausted ? new Date(Date.now() + nextDelaySeconds(attempts, cfg, options.random) * 1000) : null,
      scanExhaustedAt: exhausted ? (row.scanExhaustedAt ?? new Date()) : null,
    };
    const updated = await trx.updateTable("files").set(patch as never).where("id", "=", fileId).where("organizationId", "=", organizationId).where("scanStatus", "in", RESCANNABLE).returning(["id"]).executeTakeFirst();
    if (!updated) return null;

    // auditoria sem repetição: aprovado/infectado sempre (resultado final); indisponível só na primeira queda e no esgotamento — as tentativas intermediárias ficam em scan_attempts
    const firstUnavailable = unavailable && row.scanStatus !== "indisponivel";
    if (!unavailable || firstUnavailable || newlyExhausted) {
      await recordAuditLogEntry(
        {
          organizationId,
          actorUserId,
          action: next === "aprovado" ? "arquivo.analise_aprovada" : next === "infectado" ? "arquivo.bloqueado_por_analise" : newlyExhausted ? "arquivo.analise_esgotada" : "arquivo.analise_indisponivel",
          entityType: "file",
          entityId: String(fileId),
          metadata: { resultado: next, motor: engine, duracaoMs: durationMs, tentativas: attempts, ...(outcome.status === "infectado" ? { assinatura: outcome.signature } : {}), ...(outcome.status === "indisponivel" ? { motivo: outcome.reason } : {}), modo: getScanMode() },
        },
        trx
      );
    }
    return { exhausted };
  });
  if (!written) {
    const now = await db.selectFrom("files").select("scanStatus").where("id", "=", fileId).executeTakeFirstOrThrow();
    return { status: now.scanStatus as ScanStatus, released: isReleasable(now.scanStatus) };
  }
  return { status: next, ...(outcome.status === "indisponivel" ? { reason: outcome.reason } : {}), released: isReleasable(next), exhausted: written.exhausted };
}
