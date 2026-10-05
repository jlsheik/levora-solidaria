import superjson from "superjson";
import { buildErrorResponse } from "../../helpers/errorResponse.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../helpers/rateLimit.js";
import { ipPrefix } from "../../helpers/loginAudit.js";
import { jsonResponse } from "../../helpers/authResponses.js";
import { ACCESS_CODE_UNAVAILABLE_MESSAGE, auditInvalidCodeAttempt, findUsableAccessCode } from "../../helpers/registrationCodes.js";
import { buildAuthorizationUrl, getGoogleConfig, GoogleOidcError } from "../../helpers/googleOidc.js";
import { createOauthAttempt, setBindingCookie } from "../../helpers/oauthFlow.js";
import { db } from "../../helpers/db.js";
import { schema } from "./google-start_POST.schema.js";

const IP_LIMIT = { limit: 20, windowMs: 15 * 60 * 1000 };

/**
 * Cria a tentativa OAuth (state/nonce/PKCE só no servidor) e devolve a URL de autorização do Google. A URL é montada com o redirect
 * URI e o client id da CONFIGURAÇÃO (nunca de Host/cabeçalhos). `signup` valida o código ANTES (mesma resposta única da Fase 91) e
 * guarda só o id; `login` não carrega código e jamais poderá criar conta.
 */
export async function handle(request: Request) {
  try {
    const ip = getClientIp(request);
    const limit = checkRateLimit({ bucket: "google-start", identifier: ip, ...IP_LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitas tentativas de entrar com o Google. Aguarde antes de tentar de novo.");

    const input = schema.parse(superjson.parse(await request.text()));
    const config = getGoogleConfig();
    if (!config) return jsonResponse(503, { message: "Entrar com o Google não está disponível neste ambiente.", code: "google_nao_configurado" });

    let accessCodeId: number | null = null;
    if (input.intent === "signup") {
      const found = await findUsableAccessCode(input.accessCode!);
      if (!found.ok) {
        await auditInvalidCodeAttempt({ reason: found.reason, ipPrefix: ipPrefix(ip) });
        return jsonResponse(400, { message: ACCESS_CODE_UNAVAILABLE_MESSAGE, code: "codigo_indisponivel" });
      }
      accessCodeId = found.codeId;
    }

    const attempt = await createOauthAttempt({ intent: input.intent, accessCodeId, ipPrefix: ipPrefix(ip) });
    const authorizationUrl = await buildAuthorizationUrl(config, { state: attempt.state, nonce: attempt.nonce, codeChallenge: attempt.codeChallenge });

    // limpeza oportunista de tentativas velhas (fora do caminho crítico)
    if (Math.random() < 0.1) {
      db.deleteFrom("oauthAttempts").where("expiresAt", "<", new Date(Date.now() - 60 * 60 * 1000)).execute().catch(() => undefined);
    }

    const response = jsonResponse(200, { authorizationUrl });
    setBindingCookie(response, attempt.binding, attempt.expiresAt);
    return response;
  } catch (error: unknown) {
    if (error instanceof GoogleOidcError) return jsonResponse(502, { message: "Não foi possível iniciar o login com o Google. Tente novamente.", code: "google_indisponivel" });
    console.error("Erro ao iniciar fluxo Google:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível iniciar o login com o Google");
  }
}
