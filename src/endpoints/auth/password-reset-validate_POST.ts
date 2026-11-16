import { buildErrorResponse } from "../../helpers/errorResponse.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../helpers/rateLimit.js";
import { jsonResponse } from "../../helpers/authResponses.js";
import { limiterKeyForIp } from "../../helpers/limiterKey.js";
import { inspectResetToken } from "../../helpers/passwordReset.js";
import { schema } from "./password-reset-validate_POST.schema.js";
import superjson from "superjson";

const IP_LIMIT = { limit: 60, windowMs: 15 * 60 * 1000 };

/** Estado do link de redefinição (valido/expirado/utilizado/invalido). Não consome nada; o token só existe no corpo, nunca na URL. */
export async function handle(request: Request) {
  try {
    const limit = checkRateLimit({ bucket: "password-reset-validate", identifier: limiterKeyForIp(getClientIp(request)), ...IP_LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitas verificações em pouco tempo. Aguarde antes de tentar de novo.");
    const { token } = schema.parse(superjson.parse(await request.text()));
    return jsonResponse(200, await inspectResetToken(token));
  } catch (error: unknown) {
    console.error("Erro ao validar link de redefinição:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível verificar o link");
  }
}
