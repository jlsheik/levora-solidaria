import { randomBytes, randomUUID } from "node:crypto";
import type { Transaction } from "kysely";
import type { DB } from "./schema.js";
import { acceptedPepperVersions, currentPepperVersion, decryptSecret, encryptSecret, hmacSecret } from "./identityKeys.js";
import { buildOtpauthUri, base32Encode, matchTotp, generateTotpSecret } from "./totp.js";

/**
 * MFA (TOTP + recovery codes) — Fase 90. Todas as funções recebem uma transação e esperam que o chamador siga a ORDEM
 * CANÔNICA de locks (lockOrder.tsx): users → platform_access → auth_challenges → mfa_methods → mfa_recovery_codes → sessions → audit.
 *
 * Regra de ouro: as funções de VERIFICAÇÃO nunca lançam em falha de código — devolvem `{ ok: false }` para que o contador de
 * falhas seja confirmado (COMMIT) junto com o resto da transação do chamador. Se lançassem, o rollback apagaria a falha.
 */

const AAD = (userId: number) => `mfa:${userId}`;

// ---- política de falhas (persistida no banco; sobrevive a reinício; nunca um bloqueio permanente) -------------------------
/** A partir de N falhas acumuladas em `FAILURE_WINDOW_MS`, o método fica bloqueado por um tempo crescente (teto 15 min). */
export const LOCK_AFTER_FAILURES = 10;
export const FAILURE_WINDOW_MS = 60 * 60 * 1000;
const LOCK_BASE_MS = 30 * 1000;
const LOCK_MAX_MS = 15 * 60 * 1000;

export interface MfaMethodRow {
  id: number;
  userId: number;
  status: "pending" | "active" | "disabled";
  secretCiphertext: Buffer;
  secretKeyId: number;
  lastUsedStep: number | null;
  failedAttempts: number;
  lastFailedAt: Date | null;
  lockedUntil: Date | null;
}

const methodColumns = ["id", "userId", "status", "secretCiphertext", "secretKeyId", "lastUsedStep", "failedAttempts", "lastFailedAt", "lockedUntil"] as const;

export async function getMfaMethod(trx: Transaction<DB>, userId: number, status: "active" | "pending", options: { forUpdate?: boolean } = {}): Promise<MfaMethodRow | undefined> {
  let q = trx.selectFrom("mfaMethods").select([...methodColumns]).where("userId", "=", userId).where("status", "=", status);
  if (options.forUpdate) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) return undefined;
  // BIGINT chega do driver como string: normaliza para number (os passos TOTP cabem folgadamente em 2^53).
  return { ...row, lastUsedStep: row.lastUsedStep === null ? null : Number(row.lastUsedStep) } as MfaMethodRow;
}

export const hasActiveMfa = async (trx: Transaction<DB>, userId: number) => (await getMfaMethod(trx, userId, "active")) !== undefined;

export function decryptMethodSecret(method: Pick<MfaMethodRow, "userId" | "secretCiphertext" | "secretKeyId">): Buffer {
  return decryptSecret(method.secretCiphertext, method.secretKeyId, AAD(method.userId));
}

/** Gera um segredo e o grava CIFRADO como método `pending` (substitui um pending anterior). Nada fica ativo ainda. */
export async function beginTotpSetup(trx: Transaction<DB>, params: { userId: number; accountLabel: string; now?: Date }) {
  await trx.deleteFrom("mfaMethods").where("userId", "=", params.userId).where("status", "=", "pending").execute();
  const secret = generateTotpSecret();
  const { ciphertext, keyId } = encryptSecret(secret, AAD(params.userId));
  await trx
    .insertInto("mfaMethods")
    .values({ userId: params.userId, status: "pending", secretCiphertext: ciphertext, secretKeyId: keyId, createdAt: params.now ?? new Date() })
    .execute();
  return { otpauthUri: buildOtpauthUri({ secret, accountLabel: params.accountLabel }), manualKey: base32Encode(secret) };
}

export type VerifyResult = { ok: true; step: number } | { ok: false; reason: "invalid" | "locked"; retryAfterSeconds?: number };

function lockDuration(failures: number): number {
  const exponent = Math.min(failures - LOCK_AFTER_FAILURES, 10);
  return Math.min(LOCK_BASE_MS * 2 ** Math.max(0, exponent), LOCK_MAX_MS);
}

/** Estado de falhas vigente (falhas antigas, fora da janela, deixam de contar — o bloqueio nunca é permanente). */
function effectiveFailures(method: MfaMethodRow, now: Date): number {
  if (method.lastFailedAt && now.getTime() - method.lastFailedAt.getTime() > FAILURE_WINDOW_MS) return 0;
  return method.failedAttempts;
}

export function lockStatus(method: MfaMethodRow, now: Date): { locked: boolean; retryAfterSeconds: number } {
  if (method.lockedUntil && method.lockedUntil.getTime() > now.getTime()) {
    return { locked: true, retryAfterSeconds: Math.ceil((method.lockedUntil.getTime() - now.getTime()) / 1000) };
  }
  return { locked: false, retryAfterSeconds: 0 };
}

async function recordMethodFailure(trx: Transaction<DB>, method: MfaMethodRow, now: Date): Promise<VerifyResult> {
  const failures = effectiveFailures(method, now) + 1;
  const lockedUntil = failures >= LOCK_AFTER_FAILURES ? new Date(now.getTime() + lockDuration(failures)) : null;
  await trx.updateTable("mfaMethods").set({ failedAttempts: failures, lastFailedAt: now, lockedUntil }).where("id", "=", method.id).execute();
  return lockedUntil
    ? { ok: false, reason: "locked", retryAfterSeconds: Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000) }
    : { ok: false, reason: "invalid" };
}

/**
 * Verifica um TOTP contra o método (linha JÁ travada FOR UPDATE pelo chamador). Sucesso grava `last_used_step` (anti-replay:
 * o mesmo passo nunca vale duas vezes e a linha travada impede dois sucessos simultâneos) e zera as falhas.
 */
export async function verifyTotp(trx: Transaction<DB>, method: MfaMethodRow, code: string, now: Date = new Date()): Promise<VerifyResult> {
  const lock = lockStatus(method, now);
  if (lock.locked) return { ok: false, reason: "locked", retryAfterSeconds: lock.retryAfterSeconds };
  const step = matchTotp(decryptMethodSecret(method), code, now.getTime(), method.lastUsedStep);
  if (step === null) return recordMethodFailure(trx, method, now);
  await trx
    .updateTable("mfaMethods")
    .set({ lastUsedStep: step, lastUsedAt: now, failedAttempts: 0, lastFailedAt: null, lockedUntil: null })
    .where("id", "=", method.id)
    .execute();
  return { ok: true, step };
}

// ---- recovery codes -------------------------------------------------------------------------------------------------

export const RECOVERY_CODE_COUNT = 10;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // sem I, L, O, U

/** `XXXX-XXXX-XXXX-XXXX` — 16 símbolos Crockford = 80 bits. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += CROCKFORD[bytes[i] % 32];
    if (i % 4 === 3 && i < 15) out += "-";
  }
  return out;
}

/** Normaliza a entrada (caixa, hífens/espaços, I/L→1, O→0). `null` se o formato for impossível (não consulta o banco). */
export function normalizeRecoveryCode(input: string): string | null {
  const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(clean) ? clean : null;
}

const recoveryHash = (normalized: string, version: number) => hmacSecret("recovery:v1:", normalized, version);

/**
 * Emite um lote NOVO de recovery codes e invalida (`invalidated_at`) os abertos anteriores — na mesma transação do chamador.
 * Devolve os códigos em texto puro UMA vez; só o HMAC (pepper versionado) é gravado.
 */
export async function issueRecoveryCodes(trx: Transaction<DB>, userId: number, now: Date = new Date()): Promise<string[]> {
  await trx.updateTable("mfaRecoveryCodes").set({ invalidatedAt: now }).where("userId", "=", userId).where("usedAt", "is", null).where("invalidatedAt", "is", null).execute();
  const version = currentPepperVersion();
  const batchId = randomUUID();
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  await trx
    .insertInto("mfaRecoveryCodes")
    .values(codes.map((c) => ({ userId, batchId, codeHash: recoveryHash(normalizeRecoveryCode(c)!, version), pepperVersion: version, createdAt: now })))
    .execute();
  return codes;
}

export async function countOpenRecoveryCodes(trx: Transaction<DB>, userId: number): Promise<number> {
  const row = await trx
    .selectFrom("mfaRecoveryCodes")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("userId", "=", userId)
    .where("usedAt", "is", null)
    .where("invalidatedAt", "is", null)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/**
 * Consome um recovery code do USUÁRIO (um código de outro usuário nunca casa). O consumo é um UPDATE condicional
 * (`used_at IS NULL`): dois usos simultâneos do mesmo código ⇒ um vence, o outro vê 0 linhas. O `method` deve estar travado.
 *
 * Fase 90.1 — o recovery code é o ÚNICO caminho de volta quando o TOTP está bloqueado (ou o aplicativo se perdeu): por isso ele
 * NÃO é barrado pelo bloqueio do TOTP e suas falhas NÃO alimentam o contador do TOTP (um atacante que só quer travar o dono
 * não consegue travar também a recuperação). Chutar um código é inviável (80 bits) e continua limitado pelas tentativas do
 * challenge (5), pelo limite por IP e, no step-up, pelo limite por usuário. Um sucesso LIMPA o bloqueio do TOTP.
 */
export async function consumeRecoveryCode(trx: Transaction<DB>, method: MfaMethodRow, rawCode: string, now: Date = new Date()): Promise<VerifyResult> {
  void now;
  const normalized = normalizeRecoveryCode(rawCode);
  if (normalized === null) return { ok: false, reason: "invalid" };
  const hashes = acceptedPepperVersions().map((v) => recoveryHash(normalized, v));
  const used = await trx
    .updateTable("mfaRecoveryCodes")
    .set({ usedAt: now })
    .where("userId", "=", method.userId)
    .where("codeHash", "in", hashes)
    .where("usedAt", "is", null)
    .where("invalidatedAt", "is", null)
    .returning("id")
    .executeTakeFirst();
  if (!used) return { ok: false, reason: "invalid" };
  await trx.updateTable("mfaMethods").set({ failedAttempts: 0, lastFailedAt: null, lockedUntil: null }).where("id", "=", method.id).execute();
  return { ok: true, step: -1 };
}

/** Ativa o método pendente (código já validado) e emite os recovery codes. Nada de "QR gerado = ativo". */
export async function activatePendingMethod(trx: Transaction<DB>, params: { method: MfaMethodRow; step: number; now: Date }): Promise<string[]> {
  await trx
    .updateTable("mfaMethods")
    .set({ status: "active", confirmedAt: params.now, lastUsedStep: params.step, lastUsedAt: params.now, failedAttempts: 0, lastFailedAt: null, lockedUntil: null })
    .where("id", "=", params.method.id)
    .execute();
  return issueRecoveryCodes(trx, params.method.userId, params.now);
}

/** Valida o código da INSCRIÇÃO contra o pendente (falha conta no pendente; 5 erros o descartam). */
export async function verifyPendingSetup(trx: Transaction<DB>, method: MfaMethodRow, code: string, now: Date): Promise<{ ok: true; step: number } | { ok: false; discarded: boolean }> {
  const step = matchTotp(decryptMethodSecret(method), code, now.getTime(), null);
  if (step !== null) return { ok: true, step };
  const failures = method.failedAttempts + 1;
  const discarded = failures >= 5;
  await trx
    .updateTable("mfaMethods")
    .set(discarded ? { status: "disabled", disabledAt: now, failedAttempts: failures } : { failedAttempts: failures, lastFailedAt: now })
    .where("id", "=", method.id)
    .execute();
  return { ok: false, discarded };
}
