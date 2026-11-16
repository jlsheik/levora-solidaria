/**
 * Recuperação de senha por e-mail (F1; docs/RECUPERACAO_DE_ACESSO_ESPECIFICACAO.md §3). Reaproveita a identidade existente — não cria um segundo sistema de
 * autenticação: hash de senha (`generatePasswordHash`), política (`newPasswordSchema`), pepper/HMAC versionado (`identityKeys`), MFA (`mfa.tsx`),
 * ordem canônica de locks (`lockOrder.tsx`), auditoria (`auditLog.tsx`), logs seguros (`opLog.tsx`) e o adaptador de e-mail (`emailAdapter.tsx`).
 *
 * Garantias:
 *  - o token (256 bits, `randomBytes`) existe só no e-mail e na URL (FRAGMENTO, nunca query); no banco só o HMAC com o contexto `password-reset:v1:`;
 *  - uso único e atômico: a senha, o consumo do token, a revogação das sessões e a auditoria acontecem na MESMA transação;
 *  - no máximo um token ativo por usuário (índice único parcial) e cooldown no banco contra inundação de e-mails (vale com várias instâncias);
 *  - com MFA ativo o link NÃO basta: a confirmação exige TOTP ou código de recuperação (que é consumido, como no login); o MFA nunca é desativado
 *    nem os códigos regenerados; falhas de segundo fator esgotam o token;
 *  - titulares de acesso de plataforma não usam este caminho (têm o procedimento do Platform Owner): inelegíveis, com a mesma resposta pública;
 *  - nada aqui devolve ou registra e-mail, token, hash ou mensagem de erro: logs só com códigos seguros.
 */
import { randomBytes } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { db } from "./db.js";
import type { DB } from "./schema.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { acceptedPepperVersions, currentPepperVersion, hmacSecret } from "./identityKeys.js";
import { lockUsersInOrder } from "./lockOrder.js";
import { consumeRecoveryCode, getMfaMethod, lockStatus, verifyTotp } from "./mfa.js";
import { generatePasswordHash } from "./generatePasswordHash.js";
import { emailAdapter as defaultEmailAdapter, type EmailAdapter } from "./emailAdapter.js";
import { logEvent, safeErrorCode } from "./opLog.js";
import { compare } from "bcryptjs";

export const RESET_PEPPER_CONTEXT = "password-reset:v1:" as const;
export const RESET_DEFAULT_TTL_MINUTES = 30;
export const RESET_MIN_TTL_MINUTES = 10;
export const RESET_MAX_TTL_MINUTES = 120;
/** Um novo pedido para a mesma conta só gera outro e-mail depois deste intervalo (anti-inundação; reenvio controlado). */
export const RESET_COOLDOWN_SECONDS = 60;
export const RESET_MAX_ATTEMPTS = 5;
export const RESET_RETENTION_DAYS = 7;
/** 32 bytes em base64url = 43 caracteres. */
export const RESET_TOKEN_REGEX = /^[A-Za-z0-9_-]{43}$/;

/** Validade do token (minutos): `PASSWORD_RESET_TTL_MINUTES`, padrão 30, limitada a 10–120; valor inválido volta ao padrão seguro. */
export function resetTtlMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PASSWORD_RESET_TTL_MINUTES;
  if (raw === undefined || raw === "") return RESET_DEFAULT_TTL_MINUTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < RESET_MIN_TTL_MINUTES || n > RESET_MAX_TTL_MINUTES) return RESET_DEFAULT_TTL_MINUTES;
  return n;
}

export const generateResetToken = (): string => randomBytes(32).toString("base64url");
export const hashResetToken = (token: string, version: number): Buffer => hmacSecret(RESET_PEPPER_CONTEXT, token, version);
const acceptedHashes = (token: string): Buffer[] => acceptedPepperVersions().map((v) => hashResetToken(token, v));

export const normalizeResetEmail = (email: string): string => email.trim().toLowerCase();

export type ResetUrlResult = { ok: true; url: string } | { ok: false; code: "APP_URL_AUSENTE" | "APP_URL_INVALIDA" };

/**
 * Monta o link a partir de `APP_PUBLIC_URL` (configuração do servidor) — NUNCA de `Host`, `Origin` ou qualquer dado da requisição, o que impede
 * envenenamento do link para um domínio de terceiros. Exige https (http só para localhost/127.0.0.1/::1 e só fora de produção), sem credenciais,
 * sem caminho/consulta/fragmento na base. O token vai no FRAGMENTO (`#token=`): não chega ao servidor, a logs de proxy nem ao cabeçalho Referer.
 */
export function buildResetUrl(token: string, env: NodeJS.ProcessEnv = process.env): ResetUrlResult {
  const production = env.NODE_ENV === "production";
  const raw = env.APP_PUBLIC_URL?.trim() || (production ? "" : "http://localhost:5173");
  if (!raw) return { ok: false, code: "APP_URL_AUSENTE" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, code: "APP_URL_INVALIDA" };
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return { ok: false, code: "APP_URL_INVALIDA" };
  if (u.protocol === "https:") {
    if (production && local) return { ok: false, code: "APP_URL_INVALIDA" };
  } else if (u.protocol === "http:") {
    if (production || !local) return { ok: false, code: "APP_URL_INVALIDA" };
  } else {
    return { ok: false, code: "APP_URL_INVALIDA" };
  }
  return { ok: true, url: `${u.origin}/redefinir-senha#token=${token}` };
}

// ---- elegibilidade ---------------------------------------------------------------------------------------------------

/** Conta ativa (não anonimizada), COM senha, e que não seja titular de acesso de plataforma. */
async function loadEligibleUser(trx: Transaction<DB>, where: { email?: string; userId?: number }): Promise<{ id: number; email: string } | undefined> {
  let q = trx
    .selectFrom("users")
    .select(["users.id", "users.email"])
    .where("users.anonymizedAt", "is", null)
    .where((eb) => eb.exists(eb.selectFrom("userPasswords").select("userPasswords.id").whereRef("userPasswords.userId", "=", "users.id")))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("platformAccess").select("platformAccess.userId").whereRef("platformAccess.userId", "=", "users.id").where("platformAccess.status", "=", "active"))));
  if (where.email !== undefined) q = q.where(sql`LOWER(users.email)`, "=", where.email);
  if (where.userId !== undefined) q = q.where("users.id", "=", where.userId);
  return q.limit(1).executeTakeFirst();
}

// ---- trabalho em segundo plano (depois da resposta pública) ---------------------------------------------------------------

const pendingWork = new Set<Promise<unknown>>();
/** Agenda o trabalho do pedido sem atrasar a resposta; `flushPasswordResetWork` existe para testes e para o encerramento. */
export function scheduleResetWork(work: Promise<unknown>): void {
  const tracked = work.catch(() => undefined).finally(() => pendingWork.delete(tracked));
  pendingWork.add(tracked);
}
export async function flushPasswordResetWork(): Promise<void> {
  while (pendingWork.size > 0) await Promise.all([...pendingWork]);
}

// ---- pedido ----------------------------------------------------------------------------------------------------------

export type ResetRequestOutcome = "enviado" | "inelegivel" | "cooldown" | "smtp_nao_configurado" | "url_invalida" | "falha_envio" | "erro";

export interface ResetRequestDeps {
  emailAdapter?: EmailAdapter;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

/**
 * Trabalho do pedido — executado DEPOIS de a resposta pública (idêntica para qualquer e-mail) ter sido enviada, para que tempo e conteúdo da resposta
 * não revelem se a conta existe. Nunca lança: devolve um código seguro, que só vai para o log operacional (jamais para o cliente).
 */
export async function processResetRequest(rawEmail: string, deps: ResetRequestDeps = {}): Promise<ResetRequestOutcome> {
  const adapter = deps.emailAdapter ?? defaultEmailAdapter;
  const env = deps.env ?? process.env;
  const now = deps.now ? deps.now() : new Date();
  const email = normalizeResetEmail(rawEmail);
  try {
    // Configuração ausente é detectada ANTES de criar token (nenhum token órfão) e identificada por código seguro nos logs operacionais.
    if (!adapter.isConfigured) {
      logEvent({ event: "password_reset_request", status: "ignorado", context: { reason: "smtp_nao_configurado" } });
      return "smtp_nao_configurado";
    }

    const issued = await db.transaction().execute(async (trx) => {
      const found = await loadEligibleUser(trx, { email });
      if (!found) return { type: "inelegivel" as const };
      // Ordem canônica: users primeiro. Relê a conta SOB o lock (pode ter sido anonimizada/ganhado acesso de plataforma entre as leituras).
      if ((await lockUsersInOrder(trx, [found.id])).length === 0) return { type: "inelegivel" as const };
      const user = await loadEligibleUser(trx, { userId: found.id });
      if (!user) return { type: "inelegivel" as const };

      const recent = await trx
        .selectFrom("passwordResetTokens")
        .select("id")
        .where("userId", "=", user.id)
        .where("usedAt", "is", null)
        .where("invalidatedAt", "is", null)
        .where("createdAt", ">", new Date(now.getTime() - RESET_COOLDOWN_SECONDS * 1000))
        .executeTakeFirst();
      if (recent) return { type: "cooldown" as const };

      // Validar a URL antes de gravar qualquer token.
      const token = generateResetToken();
      const link = buildResetUrl(token, env);
      if (!link.ok) {
        logEvent({ event: "password_reset_request", status: "falha", errorCode: link.code });
        return { type: "url_invalida" as const };
      }

      // Substitui o token anterior (no máximo um ativo) e faz a limpeza oportunista de tokens antigos (retenção curta).
      await trx.updateTable("passwordResetTokens").set({ invalidatedAt: now }).where("userId", "=", user.id).where("usedAt", "is", null).where("invalidatedAt", "is", null).execute();
      await trx
        .deleteFrom("passwordResetTokens")
        .where("createdAt", "<", new Date(now.getTime() - RESET_RETENTION_DAYS * 86_400_000))
        .where((eb) => eb.or([eb("usedAt", "is not", null), eb("invalidatedAt", "is not", null), eb("expiresAt", "<", now)]))
        .execute();
      const version = currentPepperVersion();
      const row = await trx
        .insertInto("passwordResetTokens")
        .values({ userId: user.id, tokenHash: hashResetToken(token, version), pepperVersion: version, createdAt: now, expiresAt: new Date(now.getTime() + resetTtlMinutes(env) * 60_000), maxAttempts: RESET_MAX_ATTEMPTS })
        .returning("id")
        .executeTakeFirstOrThrow();
      await recordAuditLogEntry({ organizationId: null, actorUserId: user.id, action: "usuario.senha_redefinicao_solicitada", entityType: "user", entityId: String(user.id), metadata: {} }, trx);
      return { type: "issued" as const, tokenId: row.id, to: user.email, url: link.url, ttl: resetTtlMinutes(env) };
    });

    if (issued.type === "inelegivel") {
      logEvent({ event: "password_reset_request", status: "ignorado", context: { reason: "inelegivel" } });
      return "inelegivel";
    }
    if (issued.type === "cooldown") {
      logEvent({ event: "password_reset_request", status: "ignorado", context: { reason: "cooldown" } });
      return "cooldown";
    }
    if (issued.type === "url_invalida") return "url_invalida";

    const result = await adapter.send({
      to: issued.to,
      subject: "Redefinição de senha — Levora Solidária",
      text: [
        "Recebemos um pedido para redefinir a senha da sua conta na Levora Solidária.",
        `Para escolher uma nova senha, abra o link abaixo (vale por ${issued.ttl} minutos e só pode ser usado uma vez):`,
        issued.url,
        "Se você não fez este pedido, ignore este e-mail: sua senha não foi alterada e ninguém tem acesso à sua conta por causa dele.",
        "Por segurança, a Levora Solidária nunca pede sua senha por e-mail.",
      ].join("\n\n"),
    });
    if (!result.sent) {
      // Sem entrega: o token não deve ficar ativo (nada a usar nem a bloquear o próximo pedido).
      await db.updateTable("passwordResetTokens").set({ invalidatedAt: new Date() }).where("id", "=", issued.tokenId).where("usedAt", "is", null).where("invalidatedAt", "is", null).execute();
      logEvent({ event: "password_reset_request", status: "falha", errorCode: result.reason === "not_configured" ? "SMTP_NAO_CONFIGURADO" : "ENVIO_FALHOU" });
      return result.reason === "not_configured" ? "smtp_nao_configurado" : "falha_envio";
    }
    logEvent({ event: "password_reset_request", status: "ok", context: { transport: result.synthetic ? "synthetic" : "smtp" } });
    return "enviado";
  } catch (error) {
    logEvent({ event: "password_reset_request", status: "falha", errorCode: safeErrorCode(error) });
    return "erro";
  }
}

// ---- inspeção e confirmação ------------------------------------------------------------------------------------------

export type TokenState = "valido" | "expirado" | "utilizado" | "invalido";
export type InspectResult = { state: "valido"; mfaRequired: boolean } | { state: Exclude<TokenState, "valido"> };

interface TokenRow {
  id: string;
  userId: number;
  expiresAt: Date;
  usedAt: Date | null;
  invalidatedAt: Date | null;
  attempts: number;
  maxAttempts: number;
}

async function findTokenRow(trx: Transaction<DB>, token: string, options: { forUpdate?: boolean } = {}): Promise<TokenRow | undefined> {
  if (!RESET_TOKEN_REGEX.test(token)) return undefined;
  let q = trx
    .selectFrom("passwordResetTokens")
    .select(["id", "userId", "expiresAt", "usedAt", "invalidatedAt", "attempts", "maxAttempts"])
    .where("tokenHash", "in", acceptedHashes(token));
  if (options.forUpdate) q = q.forUpdate();
  return q.executeTakeFirst();
}

function stateOf(row: TokenRow | undefined, now: Date): TokenState {
  if (!row) return "invalido";
  if (row.usedAt) return "utilizado";
  if (row.invalidatedAt) return "invalido";
  if (row.expiresAt.getTime() <= now.getTime()) return "expirado";
  return "valido";
}

/** Estado do link para a tela (não consome nada). Só quem possui o token de 256 bits chega aqui; `mfaRequired` só é revelado para um link VÁLIDO. */
export async function inspectResetToken(token: string, now: Date = new Date()): Promise<InspectResult> {
  return db.transaction().execute(async (trx) => {
    const row = await findTokenRow(trx, token);
    const state = stateOf(row, now);
    if (state !== "valido" || !row) return { state } as InspectResult;
    const user = await loadEligibleUser(trx, { userId: row.userId });
    if (!user) return { state: "invalido" as const };
    return { state: "valido" as const, mfaRequired: (await getMfaMethod(trx, row.userId, "active")) !== undefined };
  });
}

/** Sinal interno: desfaz a transação inteira (nada foi consumido) e devolve `senha_igual`. */
class SamePasswordRollback extends Error {}

export type ConfirmOutcome =
  | { type: "ok"; sessionsRevoked: number; userId: number }
  | { type: "link"; state: Exclude<TokenState, "valido"> }
  | { type: "senha_igual" }
  | { type: "mfa_obrigatorio" }
  | { type: "mfa_invalido"; exhausted: boolean }
  | { type: "mfa_bloqueado"; retryAfterSeconds: number };

export interface ConfirmInput {
  token: string;
  newPassword: string;
  totpCode?: string;
  recoveryCode?: string;
}

/**
 * Confirma a redefinição. O hash da senha nova é calculado ANTES e fora da transação (nenhum lock durante o bcrypt) e SEMPRE — mesmo para link inválido —
 * para que o tempo não distinga o estado do link. Falhas de segundo fator NÃO lançam: o contador de tentativas do token e o do método de MFA são
 * confirmados no commit (mesmo padrão de `mfa-verify`).
 *
 * Locks (ordem canônica, compatível com login/MFA/troca de senha): users → password_reset_tokens → user_passwords → auth_challenges → mfa_methods →
 * mfa_recovery_codes → sessions → audit.
 */
export async function confirmPasswordReset(input: ConfirmInput, now: Date = new Date()): Promise<ConfirmOutcome> {
  const newHash = await generatePasswordHash(input.newPassword);
  try {
    return await confirmInTransaction(input, newHash, now);
  } catch (error) {
    if (error instanceof SamePasswordRollback) return { type: "senha_igual" };
    throw error;
  }
}

function confirmInTransaction(input: ConfirmInput, newHash: string, now: Date): Promise<ConfirmOutcome> {
  return db.transaction().execute(async (trx): Promise<ConfirmOutcome> => {
    const peek = await findTokenRow(trx, input.token);
    if (!peek) return { type: "link", state: "invalido" };
    // 1. users (e a conta ainda existe)
    if ((await lockUsersInOrder(trx, [peek.userId])).length === 0) return { type: "link", state: "invalido" };
    // 2. o token, relido SOB o lock do usuário (duas confirmações simultâneas serializam aqui: só uma vê o token ativo)
    const row = await findTokenRow(trx, input.token, { forUpdate: true });
    const state = stateOf(row, now);
    if (!row || state !== "valido") return { type: "link", state: state === "valido" ? "invalido" : state };
    const user = await loadEligibleUser(trx, { userId: row.userId });
    if (!user) {
      await trx.updateTable("passwordResetTokens").set({ invalidatedAt: now }).where("id", "=", row.id).execute();
      return { type: "link", state: "invalido" };
    }
    // 3. credenciais
    const passwordRows = await trx.selectFrom("userPasswords").select(["id", "passwordHash"]).where("userId", "=", row.userId).orderBy("id", "asc").forUpdate().execute();
    if (passwordRows.length === 0) return { type: "link", state: "invalido" };

    // 4. segundo fator: o link NÃO substitui o MFA.
    const method = await getMfaMethod(trx, row.userId, "active", { forUpdate: true });
    let usedRecovery = false;
    if (method) {
      const usingRecovery = input.recoveryCode !== undefined && input.recoveryCode !== "";
      const usingTotp = input.totpCode !== undefined && input.totpCode !== "";
      if (!usingRecovery && !usingTotp) return { type: "mfa_obrigatorio" };
      const lock = lockStatus(method, now);
      // O bloqueio do TOTP vale só para o TOTP (o código de recuperação é a saída quando o aplicativo falha), como no login.
      if (lock.locked && !usingRecovery) return { type: "mfa_bloqueado", retryAfterSeconds: lock.retryAfterSeconds };
      const result = usingRecovery ? await consumeRecoveryCode(trx, method, input.recoveryCode!, now) : await verifyTotp(trx, method, input.totpCode!, now);
      if (!result.ok) {
        const attempts = row.attempts + 1;
        const exhausted = attempts >= row.maxAttempts;
        await trx.updateTable("passwordResetTokens").set({ attempts, invalidatedAt: exhausted ? now : null }).where("id", "=", row.id).execute();
        await recordAuditLogEntry(
          { organizationId: null, actorUserId: row.userId, action: "usuario.senha_redefinicao_falhou", entityType: "user", entityId: String(row.userId), metadata: { motivo: "mfa_invalido", tipo: usingRecovery ? "recovery_code" : "totp", tokenEsgotado: exhausted } },
          trx
        );
        if (result.reason === "locked") return { type: "mfa_bloqueado", retryAfterSeconds: result.retryAfterSeconds ?? 60 };
        return { type: "mfa_invalido", exhausted };
      }
      usedRecovery = usingRecovery;
    }

    // Depois do MFA (nunca antes: "senha igual à atual" seria um oráculo para quem só tem o link). Se for igual, desfaz TUDO (inclusive o consumo do TOTP/código de
    // recuperação): a pessoa não perde um código de uso único por ter escolhido a senha atual e pode tentar de novo com o mesmo código.
    if (await compare(input.newPassword, passwordRows[0].passwordHash)) throw new SamePasswordRollback();

    // 5. efeitos, todos na mesma transação.
    await trx.updateTable("userPasswords").set({ passwordHash: newHash }).where("userId", "=", row.userId).execute();
    // Desafios de login pendentes (emitidos com a senha ANTIGA) deixam de valer.
    await trx.updateTable("authChallenges").set({ status: "cancelled" }).where("userId", "=", row.userId).where("status", "=", "pending").execute();
    const revoked = await trx.deleteFrom("sessions").where("userId", "=", row.userId).returning(["id"]).execute();
    await trx.updateTable("passwordResetTokens").set({ usedAt: now }).where("id", "=", row.id).execute();
    await trx.updateTable("passwordResetTokens").set({ invalidatedAt: now }).where("userId", "=", row.userId).where("usedAt", "is", null).where("invalidatedAt", "is", null).execute();
    await recordAuditLogEntry(
      { organizationId: null, actorUserId: row.userId, action: "usuario.senha_redefinida", entityType: "user", entityId: String(row.userId), metadata: { sessoesRevogadas: revoked.length, mfaExigido: method !== undefined, codigoDeRecuperacaoUsado: usedRecovery } },
      trx
    );
    return { type: "ok", sessionsRevoked: revoked.length, userId: row.userId };
  });
}

/** Aviso ao titular após a troca (melhor esforço; nunca altera o resultado nem registra e-mail/assunto). */
export async function notifyPasswordChanged(userId: number, deps: { emailAdapter?: EmailAdapter } = {}): Promise<void> {
  const adapter = deps.emailAdapter ?? defaultEmailAdapter;
  try {
    if (!adapter.isConfigured) return;
    const user = await db.selectFrom("users").select("email").where("id", "=", userId).executeTakeFirst();
    if (!user) return;
    await adapter.send({
      to: user.email,
      subject: "Sua senha da Levora Solidária foi alterada",
      text: "A senha da sua conta na Levora Solidária acabou de ser redefinida e todas as sessões foram encerradas.\n\nSe não foi você, peça uma nova redefinição imediatamente e fale com a equipe da plataforma.",
    });
  } catch (error) {
    logEvent({ event: "password_reset_notice", status: "falha", errorCode: safeErrorCode(error) });
  }
}
