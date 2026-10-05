import { timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import { db } from "../../helpers/db.js";
import { checkRateLimit, getClientIp } from "../../helpers/rateLimit.js";
import { ipPrefix } from "../../helpers/loginAudit.js";
import { setChallengeCookie } from "../../helpers/authChallenges.js";
import { setServerSession } from "../../helpers/getSetServerSession.js";
import { createSession } from "../../helpers/sessionLifecycle.js";
import { auditInvalidCodeAttempt, provisionUserWithAccessCode } from "../../helpers/registrationCodes.js";
import { exchangeCodeForIdToken, getGoogleConfig, GoogleOidcError, oauthHash, verifyGoogleIdToken, type GoogleIdentity } from "../../helpers/googleOidc.js";
import {
  auditGoogleFailure, auditGoogleInTx, claimOauthAttempt, clearBindingCookie, completePrimaryLogin, finishOauthAttempt, openPkceVerifier, readBindingCookie,
  type OauthAttemptRow,
} from "../../helpers/oauthFlow.js";
import { lockUsersInOrder } from "../../helpers/lockOrder.js";

const IP_LIMIT = { limit: 30, windowMs: 15 * 60 * 1000 };

/** Motivos mostrados ao usuário: um conjunto FECHADO de constantes (nunca texto do Google, nunca detalhes de validação). */
type Motivo = "nao_vinculada" | "ja_cadastrada" | "codigo_indisponivel" | "cancelado" | "falha" | "limite";

/** Redirecionamento RELATIVO (nunca depende de Host/cabeçalhos do cliente) e sem cache. O cookie de vínculo é sempre apagado. */
function redirect(location: string): Response {
  const response = new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
  clearBindingCookie(response);
  return response;
}
const failureRedirect = (motivo: Motivo) => redirect(`/login?google=erro&motivo=${motivo}`);

const safeEqual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/**
 * Callback do Authorization Code Flow (Fase 92). Ordem: rate limit → `state` (consumo ÚNICO) → vínculo de navegador → erro do provedor
 * → troca do `code` (back-channel, PKCE) → validação LOCAL do ID token (assinatura/JWKS, iss, aud, azp, exp, iat, nonce, sub) →
 * ENTÃO login ou cadastro. Nada é criado antes de todas as validações. Login só entra por identidade JÁ vinculada; cadastro só com
 * o código guardado NA TENTATIVA (o navegador não fornece nem pode trocar código, usuário ou intenção). Nenhuma chamada externa
 * acontece dentro de transação com lock.
 */
export async function handle(request: Request) {
  const ip = getClientIp(request);
  const prefix = ipPrefix(ip);
  let attempt: OauthAttemptRow | null = null;

  const fail = async (motivo: Motivo, reason: string, kind: "identity" | "business" = "business"): Promise<Response> => {
    if (attempt) await finishOauthAttempt(attempt.id, "failed").catch(() => undefined);
    const signup = attempt?.intent === "signup";
    await auditGoogleFailure({
      action: kind === "identity" ? "usuario.google_identity_rejected" : signup ? "usuario.cadastro_google_falhou" : "usuario.login_google_falhou",
      motivo: reason,
      ipPrefix: prefix,
    }).catch(() => undefined);
    return failureRedirect(motivo);
  };

  try {
    const limit = checkRateLimit({ bucket: "google-callback", identifier: ip, ...IP_LIMIT });
    if (!limit.allowed) return failureRedirect("limite");

    const params = new URL(request.url).searchParams;
    const state = params.get("state");
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state)) return await fail("falha", "state_invalido", "identity");

    attempt = await claimOauthAttempt(state);
    if (!attempt) return await fail("falha", "state_invalido", "identity"); // inexistente, expirado, já usado (replay) ou de outro fluxo: igual

    const binding = readBindingCookie(request);
    if (!binding || !safeEqual(oauthHash("binding", binding, attempt.pepperVersion), attempt.bindingHash)) return await fail("falha", "vinculo_invalido", "identity");

    const providerError = params.get("error");
    if (providerError) return await fail(providerError === "access_denied" ? "cancelado" : "falha", providerError === "access_denied" ? "cancelado_pelo_usuario" : "erro_do_provedor");

    const code = params.get("code");
    if (!code || code.length > 2048) return await fail("falha", "code_ausente", "identity");

    const config = getGoogleConfig();
    if (!config) return await fail("falha", "nao_configurado");

    let identity: GoogleIdentity;
    try {
      const idToken = await exchangeCodeForIdToken(config, code, openPkceVerifier(attempt));
      identity = await verifyGoogleIdToken(config, idToken, attempt.nonceHash, attempt.pepperVersion);
    } catch (error) {
      return await fail("falha", error instanceof GoogleOidcError ? error.motivo : "erro_na_validacao", "identity");
    }

    const now = new Date();
    const existing = await db
      .selectFrom("userIdentities as i")
      .innerJoin("users as u", "u.id", "i.userId")
      .select(["i.id as identityId", "u.id as userId", "u.anonymizedAt"])
      .where("i.provider", "=", "google")
      .where("i.issuer", "=", identity.issuer)
      .where("i.subject", "=", identity.subject)
      .executeTakeFirst();

    // ---------------------------------------------------------------- LOGIN: nunca cria conta -------------------------------
    if (attempt.intent === "login") {
      if (!existing || existing.anonymizedAt) return await fail("nao_vinculada", "identidade_nao_vinculada");
      const outcome = await db.transaction().execute(async (trx) => {
        await lockUsersInOrder(trx, [existing.userId]);
        const owner = await trx.selectFrom("users").select("anonymizedAt").where("id", "=", existing.userId).executeTakeFirst();
        // atributos (e-mail do provedor) são só snapshot da identidade já autenticada; nunca tocam em users.email
        const touched = await trx
          .updateTable("userIdentities")
          .set({ lastUsedAt: now, emailSnapshot: identity.email, emailVerified: identity.emailVerified })
          .where("id", "=", existing.identityId)
          .returning("id")
          .executeTakeFirst();
        if (!owner || owner.anonymizedAt || !touched) return null; // conta excluída/identidade removida entre a leitura e o lock
        const result = await completePrimaryLogin(trx, { userId: existing.userId, method: "google", now });
        await auditGoogleInTx(trx, { action: "usuario.login_google", userId: existing.userId, metadata: { etapa: result.type === "session" ? "sessao" : "mfa", ipPrefix: prefix } });
        return { result, userId: existing.userId };
      });
      if (!outcome) return await fail("nao_vinculada", "identidade_removida");
      await finishOauthAttempt(attempt.id, "completed");

      if (outcome.result.type === "challenge") {
        const res = redirect(outcome.result.kind === "verify" ? "/login?google=mfa" : "/login?google=mfa_setup");
        setChallengeCookie(res, outcome.result.challenge.secret, outcome.result.challenge.expiresAt, now);
        return res;
      }
      const res = redirect("/");
      await setServerSession(res, { id: outcome.result.session.id, createdAt: now.getTime(), lastAccessed: now.getTime() }, { absoluteExpiresAt: outcome.result.session.absoluteExpiresAt });
      clearBindingCookie(res); // setServerSession substitui os Set-Cookie: reaplica a limpeza do vínculo
      return res;
    }

    // ---------------------------------------------------------------- CADASTRO: só com o código guardado na tentativa -------
    if (attempt.accessCodeId === null) return await fail("falha", "tentativa_sem_codigo"); // inalcançável (CHECK no banco); defesa em profundidade
    if (existing) return await fail("ja_cadastrada", "identidade_ja_cadastrada"); // nada é criado e o código NÃO é consumido
    if (!identity.email) return await fail("falha", "email_ausente");

    let session: { id: string; absoluteExpiresAt: Date } | null = null;
    const email = identity.email;
    const provision = await provisionUserWithAccessCode(
      { codeId: attempt.accessCodeId },
      async (trx, { codeId }) => {
        // O e-mail NÃO é identidade e NÃO vincula: se já pertence a alguém, nada é criado nem consumido (sem auto-link, sem enumeração).
        const taken = await trx.selectFrom("users").select("id").where(sql`LOWER(email)`, "=", email).executeTakeFirst();
        if (taken) return null;
        const user = await trx
          .insertInto("users")
          .values({ email, displayName: identity.name ?? email.split("@")[0], role: "user", registeredViaCodeId: codeId })
          .returning("id")
          .executeTakeFirstOrThrow();
        await trx
          .insertInto("userIdentities")
          .values({ userId: user.id, provider: "google", issuer: identity.issuer, subject: identity.subject, emailSnapshot: identity.email, emailVerified: identity.emailVerified, lastUsedAt: now })
          .execute();
        // conta nova: sem MFA e sem platform_access (o código cria sempre role='user') ⇒ sessão plena, dentro da MESMA transação
        const created = await createSession(trx, { userId: user.id, primaryMethod: "google", now });
        session = { id: created.id, absoluteExpiresAt: created.absoluteExpiresAt };
        return user.id;
      },
      now,
      { afterRedeem: (trx, { userId }) => auditGoogleInTx(trx, { action: "usuario.cadastro_google", userId, metadata: { emailVerificado: identity.emailVerified, ipPrefix: prefix } }) }
    );

    if (!provision.ok) {
      if (provision.reason === "email_em_uso") return await fail("falha", "email_indisponivel");
      if (provision.reason === "identidade_em_uso") return await fail("ja_cadastrada", "identidade_ja_cadastrada");
      await auditInvalidCodeAttempt({ reason: provision.reason, ipPrefix: prefix });
      return await fail("codigo_indisponivel", `codigo_${provision.reason}`);
    }
    await finishOauthAttempt(attempt.id, "completed");
    const created = session as { id: string; absoluteExpiresAt: Date } | null;
    if (!created) return await fail("falha", "sessao_nao_criada");
    const res = redirect("/");
    await setServerSession(res, { id: created.id, createdAt: now.getTime(), lastAccessed: now.getTime() }, { absoluteExpiresAt: created.absoluteExpiresAt });
    clearBindingCookie(res);
    return res;
  } catch (error) {
    // nunca ecoa detalhes (stack, SQL, resposta do Google); registra só o nome do erro
    console.error("Erro no callback do Google:", error instanceof Error ? error.name : "erro");
    if (attempt) await finishOauthAttempt(attempt.id, "failed").catch(() => undefined);
    return failureRedirect("falha");
  }
}
