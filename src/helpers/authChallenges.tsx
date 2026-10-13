import { randomBytes } from "node:crypto";
import type { Transaction } from "kysely";
import type { DB } from "./schema.js";
import type { AuthChallengePurpose } from "./schema.js";
import { acceptedPepperVersions, currentPepperVersion, hmacSecret } from "./identityKeys.js";

/**
 * auth_challenges — estado PARCIAL de autenticação (Fase 90; §4.7 e §25.14 da especificação).
 *
 *   credencial primária válida ──► auth_challenge (cookie `levora_challenge`) ──► TOTP/recovery ──► INSERT sessions
 *
 * Um challenge NÃO é uma sessão: vive em tabela própria, em cookie próprio (outro nome, Path restrito a /_api/v1/auth) e
 * `getServerUserSession` só reconhece o cookie de sessão — logo nenhum endpoint de dados aceita um estado intermediário.
 * O segredo do cookie (256 bits) só existe em hash (HMAC com pepper versionado). TTL curto, uso único, tentativas limitadas.
 */

export const CHALLENGE_COOKIE = "levora_challenge";
/** TTL do challenge de login/inscrição de MFA (a pessoa já digitou a senha; precisa só do segundo fator). */
export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** TTL máximo do challenge de bootstrap/recuperação (limitado também pelo vencimento do token de bootstrap). */
export const BOOTSTRAP_CHALLENGE_TTL_MS = 30 * 60 * 1000;
export const CHALLENGE_MAX_ATTEMPTS = 5;

const CHALLENGE_COOKIE_PATH = "/_api/v1/auth";

export interface ChallengeRow {
  id: number;
  purpose: AuthChallengePurpose;
  userId: number | null;
  primaryMethod: string | null;
  bootstrapTokenId: number | null;
  attempts: number;
  maxAttempts: number;
  expiresAt: Date;
  pendingDisplayName: string | null;
  pendingPasswordHash: string | null;
  pendingSecretCiphertext: Buffer | null;
  pendingSecretKeyId: number | null;
  pendingSecretStep: number | null;
}

export function newChallengeSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function challengeHash(secret: string, version: number): Buffer {
  return hmacSecret("challenge:v1:", secret, version);
}

/**
 * Cria um challenge pendente. Challenges pendentes ANTERIORES do mesmo usuário e propósito (login/inscrição) são cancelados:
 * só o mais recente vale, o que limita tentativas paralelas de um atacante que já tenha a senha.
 */
export async function createChallenge(
  trx: Transaction<DB>,
  params: {
    purpose: AuthChallengePurpose;
    userId: number | null;
    primaryMethod?: string | null;
    ttlMs?: number;
    bootstrapTokenId?: number | null;
    now?: Date;
  }
): Promise<{ id: number; secret: string; expiresAt: Date }> {
  const now = params.now ?? new Date();
  const ttl = params.ttlMs ?? (params.purpose === "mfa_login" || params.purpose === "mfa_enroll" ? MFA_CHALLENGE_TTL_MS : BOOTSTRAP_CHALLENGE_TTL_MS);
  const expiresAt = new Date(now.getTime() + ttl);
  const secret = newChallengeSecret();
  const version = currentPepperVersion();

  if (params.userId !== null && (params.purpose === "mfa_login" || params.purpose === "mfa_enroll")) {
    await trx
      .updateTable("authChallenges")
      .set({ status: "cancelled" })
      .where("userId", "=", params.userId)
      .where("purpose", "in", ["mfa_login", "mfa_enroll"])
      .where("status", "=", "pending")
      .execute();
  }

  const row = await trx
    .insertInto("authChallenges")
    .values({
      secretHash: challengeHash(secret, version),
      pepperVersion: version,
      purpose: params.purpose,
      userId: params.userId,
      primaryMethod: params.primaryMethod ?? null,
      bootstrapTokenId: params.bootstrapTokenId ?? null,
      maxAttempts: CHALLENGE_MAX_ATTEMPTS,
      createdAt: now,
      expiresAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, secret, expiresAt };
}

/** Lê o segredo do challenge do cookie da requisição (ou null). */
export function readChallengeSecret(request: Request): string | null {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CHALLENGE_COOKIE && rest.length > 0) {
      const value = decodeURIComponent(rest.join("="));
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}

export function setChallengeCookie(response: Response, secret: string, expiresAt: Date, now: Date = new Date()): void {
  const maxAge = Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  const cookie = [`${CHALLENGE_COOKIE}=${secret}`, "HttpOnly", "Secure", "SameSite=Lax", `Path=${CHALLENGE_COOKIE_PATH}`, `Max-Age=${maxAge}`].join("; ");
  response.headers.append("Set-Cookie", cookie);
}

export function clearChallengeCookie(response: Response): void {
  const cookie = [`${CHALLENGE_COOKIE}=`, "HttpOnly", "Secure", "SameSite=Lax", `Path=${CHALLENGE_COOKIE_PATH}`, "Max-Age=0"].join("; ");
  response.headers.append("Set-Cookie", cookie);
}

const challengeColumns = [
  "id",
  "purpose",
  "userId",
  "primaryMethod",
  "bootstrapTokenId",
  "attempts",
  "maxAttempts",
  "expiresAt",
  "pendingDisplayName",
  "pendingPasswordHash",
  "pendingSecretCiphertext",
  "pendingSecretKeyId",
  "pendingSecretStep",
] as const;

/** Passo 1 (sem lock): descobre o dono do challenge, para travar `users` ANTES do challenge (ordem canônica de locks). */
export async function peekChallengeUserId(trx: Transaction<DB>, secret: string): Promise<number | null | undefined> {
  const hashes = acceptedPepperVersions().map((v) => challengeHash(secret, v));
  const row = await trx.selectFrom("authChallenges").select("userId").where("secretHash", "in", hashes).executeTakeFirst();
  return row === undefined ? undefined : row.userId;
}

/**
 * Carrega e TRAVA (FOR UPDATE) o challenge se — e somente se — estiver pendente, dentro do prazo e com um dos propósitos
 * esperados. Qualquer outro caso (inexistente, expirado, consumido, cancelado, propósito errado) devolve null: o chamador
 * responde sempre a MESMA coisa, sem distinguir.
 */
export async function loadPendingChallengeForUpdate(
  trx: Transaction<DB>,
  secret: string,
  purposes: AuthChallengePurpose[],
  now: Date = new Date()
): Promise<ChallengeRow | null> {
  const hashes = acceptedPepperVersions().map((v) => challengeHash(secret, v));
  const row = await trx
    .selectFrom("authChallenges")
    .select([...challengeColumns, "status"])
    .where("secretHash", "in", hashes)
    .forUpdate()
    .executeTakeFirst();
  if (!row) return null;
  if (row.status !== "pending") return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  if (!purposes.includes(row.purpose)) return null;
  const { status: _status, ...rest } = row;
  void _status;
  return rest;
}

/** Conta uma tentativa errada; ao atingir o máximo o challenge morre (`failed`) e a pessoa precisa entrar de novo. */
export async function recordChallengeFailure(trx: Transaction<DB>, challenge: ChallengeRow): Promise<{ exhausted: boolean }> {
  const attempts = challenge.attempts + 1;
  const exhausted = attempts >= challenge.maxAttempts;
  await trx
    .updateTable("authChallenges")
    .set({ attempts, ...(exhausted ? { status: "failed" as const } : {}) })
    .where("id", "=", challenge.id)
    .execute();
  return { exhausted };
}

/** Consumo ÚNICO: só um UPDATE condicional vence; 0 linhas ⇒ já consumido/expirado/cancelado. */
export async function consumeChallenge(trx: Transaction<DB>, challengeId: number, now: Date = new Date()): Promise<boolean> {
  const row = await trx
    .updateTable("authChallenges")
    .set({ status: "consumed", consumedAt: now })
    .where("id", "=", challengeId)
    .where("status", "=", "pending")
    .where("expiresAt", ">", now)
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}
