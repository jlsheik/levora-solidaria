import { sql } from "kysely";
import { db } from "./db.js";
import { checkRateLimit, getClientIp } from "./rateLimit.js";
import { ipPrefix } from "./loginAudit.js";
import { setChallengeCookie } from "./authChallenges.js";
import { setServerSession } from "./getSetServerSession.js";
import { createSession, rotateSessionInTx } from "./sessionLifecycle.js";
import { auditInvalidCodeAttempt, provisionUserWithAccessCode } from "./registrationCodes.js";
import { oauthHash, safeEqual } from "./oauthPrimitives.js";
import {
  auditGoogleFailure, auditGoogleInTx, claimOauthAttempt, clearBindingCookie, completePrimaryLogin, finishOauthAttempt, openPkceVerifier, readBindingCookie,
  type OauthAttemptRow,
} from "./oauthFlow.js";
import { lockUsersInOrder } from "./lockOrder.js";
import { getServerUserSession } from "./getServerUserSession.js";
import type { NormalizedIdentity, OauthProviderAdapter } from "./oauthProviders.js";

const IP_LIMIT = { limit: 30, windowMs: 15 * 60 * 1000 };

/** Motivos mostrados ao usuário: um conjunto FECHADO de constantes (nunca texto do provedor, nunca detalhes de validação). */
type Motivo = "nao_vinculada" | "ja_cadastrada" | "codigo_indisponivel" | "cancelado" | "falha" | "limite";

/** Redirecionamento RELATIVO (nunca depende de Host/cabeçalhos do cliente) e sem cache. O cookie de vínculo é sempre apagado. */
function redirect(location: string): Response {
  const response = new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
  clearBindingCookie(response);
  return response;
}
/** Falha de REAUTENTICAÇÃO: volta ao app (o usuário continua logado), nunca à tela de login. */
const reauthFailureRedirect = () => redirect("/?reauth=erro");

/**
 * Callback do Authorization Code Flow (Google/Microsoft). Ordem: rate limit → `state` (consumo ÚNICO, do MESMO provedor) → vínculo de
 * navegador → erro do provedor → troca do `code` (back-channel, PKCE) → validação LOCAL do ID token (a cargo do adaptador) → ENTÃO
 * login, cadastro ou reauth. Nada é criado antes de todas as validações. Login só entra por identidade JÁ vinculada (provider, issuer,
 * subject); cadastro só com o código guardado NA TENTATIVA (o navegador não fornece nem pode trocar código, usuário ou intenção).
 * Nenhuma chamada externa acontece dentro de transação com lock. E-mail/UPN/preferred_username nunca são chave.
 */
export async function handleOauthCallback<C>(request: Request, adapter: OauthProviderAdapter<C>) {
  const ip = getClientIp(request);
  const prefix = ipPrefix(ip);
  let attempt: OauthAttemptRow | null = null;
  const failureRedirect = (motivo: Motivo) => redirect(`/login?${adapter.param}=erro&motivo=${motivo}`);

  const fail = async (motivo: Motivo, reason: string, kind: "identity" | "business" = "business"): Promise<Response> => {
    if (attempt) await finishOauthAttempt(attempt.id, "failed").catch(() => undefined);
    const signup = attempt?.intent === "signup";
    await auditGoogleFailure({
      action: kind === "identity" ? adapter.actions.rejected : signup ? adapter.actions.signupFailed : attempt?.intent === "reauth" ? adapter.actions.reauthFailed : adapter.actions.loginFailed,
      motivo: reason,
      ipPrefix: prefix,
    }).catch(() => undefined);
    return attempt?.intent === "reauth" ? reauthFailureRedirect() : failureRedirect(motivo);
  };

  try {
    const limit = checkRateLimit({ bucket: adapter.callbackBucket, identifier: ip, ...IP_LIMIT });
    if (!limit.allowed) return failureRedirect("limite");

    const params = new URL(request.url).searchParams;
    const state = params.get("state");
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state)) return await fail("falha", "state_invalido", "identity");

    attempt = await claimOauthAttempt(state, adapter.provider);
    if (!attempt) return await fail("falha", "state_invalido", "identity"); // inexistente, expirado, já usado (replay) ou de outro fluxo/provedor: igual

    const binding = readBindingCookie(request);
    if (!binding || !safeEqual(oauthHash("binding", binding, attempt.pepperVersion), attempt.bindingHash)) return await fail("falha", "vinculo_invalido", "identity");

    const providerError = params.get("error");
    if (providerError) return await fail(providerError === "access_denied" ? "cancelado" : "falha", providerError === "access_denied" ? "cancelado_pelo_usuario" : "erro_do_provedor");

    const code = params.get("code");
    if (!code || code.length > 2048) return await fail("falha", "code_ausente", "identity");

    const config = adapter.getConfig();
    if (!config) return await fail("falha", "nao_configurado");

    let identity: NormalizedIdentity;
    try {
      identity = await adapter.exchangeAndVerify(config, code, openPkceVerifier(attempt), attempt.nonceHash, attempt.pepperVersion);
    } catch (error) {
      return await fail("falha", adapter.motivoOf(error) ?? "erro_na_validacao", "identity");
    }

    const now = new Date();
    const existing = await db
      .selectFrom("userIdentities as i")
      .innerJoin("users as u", "u.id", "i.userId")
      .select(["i.id as identityId", "i.providerMetadata", "u.id as userId", "u.anonymizedAt"])
      .where("i.provider", "=", adapter.provider)
      .where("i.issuer", "=", identity.issuer)
      .where("i.subject", "=", identity.subject)
      .executeTakeFirst();
    // identidade conhecida cujos metadados contradizem o token (ex.: `oid` diferente para o mesmo issuer+sub) é anômala: não entra, não reautentica
    if (existing && adapter.metadataConflict?.((existing.providerMetadata ?? {}) as Record<string, unknown>, identity.metadata)) return await fail("falha", "metadata_divergente", "identity");
    const hasMetadata = Object.keys(identity.metadata).length > 0;

    // ---------------------------------------------------------------- REAUTH: confirma a identidade do PRÓPRIO usuário ------
    if (attempt.intent === "reauth") {
      // A tentativa pertence a UM usuário (user_id gravado no servidor no início); a identidade validada tem de ser DELE.
      if (attempt.userId === null) return await fail("falha", "tentativa_sem_usuario");
      if (!existing || existing.userId !== attempt.userId || existing.anonymizedAt) return await fail("falha", "identidade_de_outro_usuario", "identity");
      let current;
      try {
        current = await getServerUserSession(request);
      } catch {
        return await fail("falha", "sessao_ausente");
      }
      if (current.user.id !== attempt.userId) return await fail("falha", "sessao_de_outro_usuario", "identity");
      const sessionId = current.session.id;
      const rotated = await db
        .transaction()
        .execute(async (trx) => {
          await lockUsersInOrder(trx, [attempt!.userId!]);
          await trx.updateTable("userIdentities").set({ lastUsedAt: now }).where("id", "=", existing.identityId).execute();
          const next = await rotateSessionInTx(trx, sessionId, { primaryReauth: true }); // lança se a sessão foi encerrada (reauth × logout)
          await auditGoogleInTx(trx, { action: adapter.actions.reauth, userId: attempt!.userId, metadata: { ipPrefix: prefix } });
          return next;
        })
        .catch(() => null);
      if (!rotated) return await fail("falha", "sessao_encerrada");
      await finishOauthAttempt(attempt.id, "completed");
      const res = redirect("/?reauth=ok");
      await setServerSession(res, { id: rotated.newId, createdAt: rotated.createdAt.getTime(), lastAccessed: now.getTime() }, { absoluteExpiresAt: rotated.absoluteExpiresAt });
      clearBindingCookie(res);
      return res;
    }

    // ---------------------------------------------------------------- LOGIN: nunca cria conta -------------------------------
    if (attempt.intent === "login") {
      if (!existing || existing.anonymizedAt) return await fail("nao_vinculada", "identidade_nao_vinculada");
      const outcome = await db.transaction().execute(async (trx) => {
        await lockUsersInOrder(trx, [existing.userId]);
        const owner = await trx.selectFrom("users").select("anonymizedAt").where("id", "=", existing.userId).executeTakeFirst();
        // atributos (e-mail do provedor) são só snapshot da identidade já autenticada; nunca tocam em users.email
        const touched = await trx
          .updateTable("userIdentities")
          .set({ lastUsedAt: now, emailSnapshot: identity.email, emailVerified: identity.emailVerified, ...(hasMetadata ? { providerMetadata: identity.metadata } : {}) })
          .where("id", "=", existing.identityId)
          .returning("id")
          .executeTakeFirst();
        if (!owner || owner.anonymizedAt || !touched) return null; // conta excluída/identidade removida entre a leitura e o lock
        const result = await completePrimaryLogin(trx, { userId: existing.userId, method: adapter.provider, now });
        await auditGoogleInTx(trx, { action: adapter.actions.login, userId: existing.userId, metadata: { etapa: result.type === "session" ? "sessao" : "mfa", ipPrefix: prefix } });
        return { result, userId: existing.userId };
      });
      if (!outcome) return await fail("nao_vinculada", "identidade_removida");
      await finishOauthAttempt(attempt.id, "completed");

      if (outcome.result.type === "challenge") {
        const res = redirect(outcome.result.kind === "verify" ? `/login?${adapter.param}=mfa` : `/login?${adapter.param}=mfa_setup`);
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
          .values({
            userId: user.id, provider: adapter.provider, issuer: identity.issuer, subject: identity.subject, emailSnapshot: identity.email, emailVerified: identity.emailVerified,
            providerMetadata: identity.metadata, lastUsedAt: now,
          })
          .execute();
        // conta nova: sem MFA e sem platform_access (o código cria sempre role='user') ⇒ sessão plena, dentro da MESMA transação
        const created = await createSession(trx, { userId: user.id, primaryMethod: adapter.provider, now });
        session = { id: created.id, absoluteExpiresAt: created.absoluteExpiresAt };
        return user.id;
      },
      now,
      { afterRedeem: (trx, { userId }) => auditGoogleInTx(trx, { action: adapter.actions.signup, userId, metadata: { emailVerificado: identity.emailVerified, ipPrefix: prefix } }) }
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
    // nunca ecoa detalhes (stack, SQL, resposta do provedor); registra só o nome do erro
    console.error(`Erro no callback do ${adapter.logName}:`, error instanceof Error ? error.name : "erro");
    if (attempt) await finishOauthAttempt(attempt.id, "failed").catch(() => undefined);
    return failureRedirect("falha");
  }
}
