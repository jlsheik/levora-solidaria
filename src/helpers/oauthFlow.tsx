import type { Transaction } from "kysely";
import { db } from "./db.js";
import type { DB } from "./schema.js";
import { acceptedPepperVersions, currentPepperVersion, decryptSecret, encryptSecret, isPlatformMfaRequired } from "./identityKeys.js";
import { newOauthSecret, newPkceVerifier, oauthHash, pkceChallenge } from "./oauthPrimitives.js";
import { createChallenge } from "./authChallenges.js";
import { createSession, type CreatedSession } from "./sessionLifecycle.js";
import { getMfaMethod } from "./mfa.js";
import { lockUsersInOrder } from "./lockOrder.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { checkRateLimit } from "./rateLimit.js";

/**
 * Estado SERVIDOR de um fluxo OAuth (Fase 92; Google e Microsoft compartilham a MESMA tabela e a MESMA máquina de estados, separados por `provider`). O navegador só carrega dois valores opacos: o `state` (na URL do provedor) e o
 * cookie de vínculo `levora_oauth` (HttpOnly). Tudo o mais — intent, id do código de acesso, nonce, verifier PKCE — vive na
 * linha de `oauth_attempts`; nada disso vem do cliente no callback.
 */

export const OAUTH_COOKIE = "levora_oauth";
export const OAUTH_COOKIE_PATH = "/_api/v1/auth";
export const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;

export type OauthProvider = "google" | "microsoft";

export interface OauthAttemptRow {
  id: number;
  provider: OauthProvider;
  intent: string;
  accessCodeId: number | null;
  userId: number | null;
  stateHash: Buffer;
  bindingHash: Buffer;
  nonceHash: Buffer;
  pepperVersion: number;
  pkceVerifierCt: Buffer;
  pkceKeyId: number;
}

const pkceAad = (stateHash: Buffer) => `oauth-pkce:v1:${stateHash.toString("hex")}`;

export async function createOauthAttempt(params: { provider?: OauthProvider; intent: "login" | "signup" | "reauth"; accessCodeId: number | null; userId?: number | null; ipPrefix: string; now?: Date }) {
  const now = params.now ?? new Date();
  const version = currentPepperVersion();
  const state = newOauthSecret();
  const binding = newOauthSecret();
  const nonce = newOauthSecret();
  const verifier = newPkceVerifier();
  const stateHash = oauthHash("state", state, version);
  const { ciphertext, keyId } = encryptSecret(Buffer.from(verifier, "ascii"), pkceAad(stateHash));
  const expiresAt = new Date(now.getTime() + OAUTH_ATTEMPT_TTL_MS);
  const row = await db
    .insertInto("oauthAttempts")
    .values({
      stateHash,
      bindingHash: oauthHash("binding", binding, version),
      nonceHash: oauthHash("nonce", nonce, version),
      pepperVersion: version,
      pkceVerifierCt: ciphertext,
      pkceKeyId: keyId,
      provider: params.provider ?? "google",
      intent: params.intent,
      accessCodeId: params.accessCodeId,
      userId: params.userId ?? null,
      ipPrefix: params.ipPrefix,
      createdAt: now,
      expiresAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, state, binding, nonce, codeChallenge: pkceChallenge(verifier), expiresAt };
}

/**
 * Consumo ÚNICO do `state`: UPDATE condicional `started → processing`. Replay, state inexistente, expirado, já usado ou de outro
 * fluxo ⇒ 0 linhas ⇒ `null` (a mesma resposta para todos). Tenta todas as versões de pepper aceitas.
 */
export async function claimOauthAttempt(state: string, provider: OauthProvider, now: Date = new Date()): Promise<OauthAttemptRow | null> {
  const hashes = acceptedPepperVersions().map((v) => oauthHash("state", state, v));
  const row = await db
    .updateTable("oauthAttempts")
    .set({ status: "processing" })
    .where("stateHash", "in", hashes)
    .where("provider", "=", provider) // um state de OUTRO provedor nunca é consumido nem aceito aqui
    .where("status", "=", "started")
    .where("expiresAt", ">", now)
    .returning(["id", "provider", "intent", "accessCodeId", "userId", "bindingHash", "nonceHash", "pepperVersion", "pkceVerifierCt", "pkceKeyId", "stateHash"])
    .executeTakeFirst();
  return row ? { ...row, provider: row.provider as OauthProvider } : null;
}

export function openPkceVerifier(attempt: OauthAttemptRow): string {
  return decryptSecret(attempt.pkceVerifierCt, attempt.pkceKeyId, pkceAad(attempt.stateHash)).toString("ascii");
}

export async function finishOauthAttempt(id: number, status: "completed" | "failed", now: Date = new Date()) {
  await db.updateTable("oauthAttempts").set({ status, finishedAt: now }).where("id", "=", id).where("status", "=", "processing").execute();
}

// ---- cookie de vínculo -----------------------------------------------------------------------------------------------------------

export function readBindingCookie(request: Request): string | null {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === OAUTH_COOKIE && rest.length > 0) {
      const value = decodeURIComponent(rest.join("="));
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}

export function setBindingCookie(response: Response, binding: string, expiresAt: Date, now: Date = new Date()) {
  const maxAge = Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  response.headers.append("Set-Cookie", [`${OAUTH_COOKIE}=${binding}`, "HttpOnly", "Secure", "SameSite=Lax", `Path=${OAUTH_COOKIE_PATH}`, `Max-Age=${maxAge}`].join("; "));
}

export function clearBindingCookie(response: Response) {
  response.headers.append("Set-Cookie", [`${OAUTH_COOKIE}=`, "HttpOnly", "Secure", "SameSite=Lax", `Path=${OAUTH_COOKIE_PATH}`, "Max-Age=0"].join("; "));
}

// ---- login primário (mesma regra do login por senha: o MFA LEVORA continua obrigatório) ----------------------------------

export type PrimaryLoginResult =
  | { type: "session"; session: CreatedSession; platformLevel: string | null }
  | { type: "challenge"; challenge: { id: number; secret: string; expiresAt: Date }; kind: "verify" | "enroll" };

/**
 * Autenticação primária concluída (identidade Google/Microsoft já vinculada). Sob o lock da linha do usuário decide, com o estado REAL no
 * banco, entre sessão plena e `auth_challenge` de MFA — exatamente como o login por senha (Fase 90): o provedor NÃO substitui o 2º fator.
 * Corrida login × ativação/desativação de MFA: a decisão e a criação da sessão acontecem sob o mesmo lock.
 */
export async function completePrimaryLogin(trx: Transaction<DB>, params: { userId: number; method: OauthProvider; now: Date }): Promise<PrimaryLoginResult> {
  await lockUsersInOrder(trx, [params.userId]);
  const access = await trx.selectFrom("platformAccess").select("level").where("userId", "=", params.userId).where("status", "=", "active").executeTakeFirst();
  const mfa = await getMfaMethod(trx, params.userId, "active");
  const needsEnrollment = !mfa && Boolean(access) && isPlatformMfaRequired();
  if (mfa || needsEnrollment) {
    const challenge = await createChallenge(trx, { purpose: mfa ? "mfa_login" : "mfa_enroll", userId: params.userId, primaryMethod: params.method, now: params.now });
    return { type: "challenge", challenge, kind: mfa ? "verify" : "enroll" };
  }
  const session = await createSession(trx, { userId: params.userId, primaryMethod: params.method, now: params.now });
  return { type: "session", session, platformLevel: access?.level ?? null };
}

// ---- auditoria (nunca grava code, tokens, nonce, verifier, segredos nem o e-mail) ---------------------------------------------

export type OauthAuditAction =
  | "usuario.login_google"
  | "usuario.login_google_falhou"
  | "usuario.cadastro_google"
  | "usuario.cadastro_google_falhou"
  | "usuario.reauth_google"
  | "usuario.reauth_google_falhou"
  | "usuario.google_identity_rejected"
  | "usuario.login_microsoft"
  | "usuario.login_microsoft_falhou"
  | "usuario.cadastro_microsoft"
  | "usuario.cadastro_microsoft_falhou"
  | "usuario.reauth_microsoft"
  | "usuario.reauth_microsoft_falhou"
  | "usuario.microsoft_identity_rejected";
export type GoogleAuditAction = OauthAuditAction;

/** Sucesso: dentro da transação do negócio, como ÚLTIMO passo. */
export async function auditGoogleInTx(trx: Transaction<DB>, params: { action: OauthAuditAction; userId: number | null; metadata: Record<string, string | number | boolean | null> }) {
  await recordAuditLogEntry(
    { organizationId: null, actorUserId: params.userId, action: params.action, entityType: "user", entityId: params.userId === null ? null : String(params.userId), metadata: params.metadata },
    trx
  );
}

/** Falhas: 1 evento por (ação, motivo, rede) a cada 10 min — um atacante não infla nem serializa a hash-chain. */
export async function auditGoogleFailure(params: { action: OauthAuditAction; motivo: string; ipPrefix: string; userId?: number | null }) {
  const gate = checkRateLimit({ bucket: "google-failure-audit", identifier: `${params.action}:${params.motivo}:${params.ipPrefix}`, limit: 1, windowMs: 10 * 60 * 1000 });
  if (!gate.allowed) return;
  await db.transaction().execute((trx) => auditGoogleInTx(trx, { action: params.action, userId: params.userId ?? null, metadata: { motivo: params.motivo, ipPrefix: params.ipPrefix } }));
}

/** Os helpers de auditoria valem para qualquer provedor OAuth (nomes neutros; os `audit*Google*` ficam por compatibilidade). */
export const auditOauthInTx = auditGoogleInTx;
export const auditOauthFailure = auditGoogleFailure;
