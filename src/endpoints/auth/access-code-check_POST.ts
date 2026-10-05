import { buildErrorResponse } from "../../helpers/errorResponse.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../helpers/rateLimit.js";
import { ACCESS_CODE_UNAVAILABLE_MESSAGE, auditInvalidCodeAttempt, checkAccessCode } from "../../helpers/registrationCodes.js";
import { ipPrefix } from "../../helpers/loginAudit.js";
import { jsonResponse } from "../../helpers/authResponses.js";
import { schema } from "./access-code-check_POST.schema.js";
import superjson from "superjson";

// Defesa por IP contra varredura de códigos (o espaço é de 100 bits; o limite existe contra fuzzing/abuso, não como única defesa).
const IP_LIMIT = { limit: 20, windowMs: 15 * 60 * 1000 };

/**
 * Valida um código de acesso SEM consumi-lo (passo "informe o código" do cadastro). Leitura pura: o código continua livre se a pessoa
 * abandonar. Qualquer código inutilizável (inexistente, formato impossível, expirado, revogado, já utilizado) recebe a MESMA resposta;
 * o motivo exato só vai para a auditoria (volume limitado).
 */
export async function handle(request: Request) {
  try {
    const ip = getClientIp(request);
    const limit = checkRateLimit({ bucket: "access-code-check", identifier: ip, ...IP_LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitas tentativas de validar código. Aguarde antes de tentar de novo.");
    const { accessCode } = schema.parse(superjson.parse(await request.text()));

    const result = await checkAccessCode(accessCode);
    if (!result.ok) {
      await auditInvalidCodeAttempt({ reason: result.reason, ipPrefix: ipPrefix(ip) });
      return jsonResponse(400, { message: ACCESS_CODE_UNAVAILABLE_MESSAGE, code: "codigo_indisponivel" });
    }
    return jsonResponse(200, { valid: true });
  } catch (error: unknown) {
    console.error("Erro ao validar código de acesso:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível validar o código");
  }
}
