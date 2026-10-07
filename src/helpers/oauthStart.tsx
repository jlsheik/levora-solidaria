import superjson from "superjson";
import type { z } from "zod";
import { buildErrorResponse } from "./errorResponse.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "./rateLimit.js";
import { ipPrefix } from "./loginAudit.js";
import { jsonResponse } from "./authResponses.js";
import { ACCESS_CODE_UNAVAILABLE_MESSAGE, auditInvalidCodeAttempt, findUsableAccessCode } from "./registrationCodes.js";
import { createOauthAttempt, setBindingCookie } from "./oauthFlow.js";
import { db } from "./db.js";
import { getServerUserSession } from "./getServerUserSession.js";
import { NotAuthenticatedError } from "./getSetServerSession.js";
import type { OauthProviderAdapter } from "./oauthProviders.js";

const IP_LIMIT = { limit: 20, windowMs: 15 * 60 * 1000 };

/**
 * Início do fluxo OAuth (Google/Microsoft). Cria a tentativa (state/nonce/PKCE só no servidor) e devolve a URL de autorização. A URL é
 * montada com o redirect URI e o client id da CONFIGURAÇÃO (nunca de Host/cabeçalhos). `signup` valida o código ANTES (mesma resposta única
 * da Fase 91) e guarda só o id; `login` não carrega código e jamais poderá criar conta; `reauth` usa o usuário da SESSÃO (nunca do corpo).
 */
export async function handleOauthStart<C>(request: Request, adapter: OauthProviderAdapter<C>, schema: z.ZodType<{ intent: "login" | "signup" | "reauth"; accessCode?: string }>) {
  try {
    const ip = getClientIp(request);
    const limit = checkRateLimit({ bucket: adapter.startBucket, identifier: ip, ...IP_LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, adapter.startRateMessage);

    const input = schema.parse(superjson.parse(await request.text()));
    const config = adapter.getConfig();
    if (!config) return jsonResponse(503, adapter.notConfigured);

    let accessCodeId: number | null = null;
    let reauthUserId: number | null = null;
    if (input.intent === "reauth") {
      // o usuário vem da SESSÃO (nunca do corpo); sem sessão ⇒ 401. Só quem tem identidade DESTE provedor pode reautenticar por ela.
      const { user } = await getServerUserSession(request);
      const linked = await db.selectFrom("userIdentities").select("id").where("userId", "=", user.id).where("provider", "=", adapter.provider).executeTakeFirst();
      if (!linked) return jsonResponse(409, { message: `Esta conta não está vinculada ${adapter.provider === "google" ? "ao Google" : "à Microsoft"}.`, code: `${adapter.provider}_nao_vinculado` });
      reauthUserId = user.id;
    }
    if (input.intent === "signup") {
      const found = await findUsableAccessCode(input.accessCode!);
      if (!found.ok) {
        await auditInvalidCodeAttempt({ reason: found.reason, ipPrefix: ipPrefix(ip) });
        return jsonResponse(400, { message: ACCESS_CODE_UNAVAILABLE_MESSAGE, code: "codigo_indisponivel" });
      }
      accessCodeId = found.codeId;
    }

    const attempt = await createOauthAttempt({ provider: adapter.provider, intent: input.intent, accessCodeId, userId: reauthUserId, ipPrefix: ipPrefix(ip) });
    const authorizationUrl = await adapter.buildAuthorizationUrl(config, { state: attempt.state, nonce: attempt.nonce, codeChallenge: attempt.codeChallenge });

    // limpeza oportunista de tentativas velhas (fora do caminho crítico)
    if (Math.random() < 0.1) {
      db.deleteFrom("oauthAttempts").where("expiresAt", "<", new Date(Date.now() - 60 * 60 * 1000)).execute().catch(() => undefined);
    }

    const response = jsonResponse(200, { authorizationUrl });
    setBindingCookie(response, attempt.binding, attempt.expiresAt);
    return response;
  } catch (error: unknown) {
    if (error instanceof NotAuthenticatedError) return jsonResponse(401, { error: "Not authenticated" });
    if (adapter.motivoOf(error)) return jsonResponse(502, adapter.unavailable);
    console.error(`Erro ao iniciar fluxo ${adapter.logName}:`, error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, `Não foi possível iniciar o login com ${adapter.provider === "google" ? "o Google" : "a Microsoft"}`);
  }
}
