import { buildErrorResponse } from "../../helpers/errorResponse.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../helpers/rateLimit.js";
import { jsonResponse } from "../../helpers/authResponses.js";
import { limiterKeyForIp } from "../../helpers/limiterKey.js";
import { normalizeResetEmail, processResetRequest, scheduleResetWork } from "../../helpers/passwordReset.js";
import { schema } from "./password-reset-request_POST.schema.js";
import superjson from "superjson";

// Limite por IP (em memória, por processo, IPv6 por /64: com mais de uma instância vale por instância — ver docs/RECUPERACAO_DE_ACESSO_ESPECIFICACAO.md §8.2). O teto por conta é do BANCO.
const IP_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };

export const GENERIC_MESSAGE = "Se existir uma conta com este e-mail, enviaremos as instruções para redefinir a senha em instantes. Confira também a caixa de spam.";

/**
 * Pedido público de redefinição de senha. A resposta é IDÊNTICA (corpo, status, cabeçalhos e, por construção, tempo) para qualquer e-mail
 * bem formado: conta inexistente, inelegível, em cooldown, limite por e-mail esgotado, e-mail não configurado ou envio falho. O trabalho real
 * (consulta, token, envio) roda DEPOIS da resposta. Só o limite por IP responde diferente (429), e ele não depende de a conta existir.
 */
export async function handle(request: Request) {
  try {
    const limit = checkRateLimit({ bucket: "password-reset-request", identifier: limiterKeyForIp(getClientIp(request)), ...IP_LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitos pedidos em pouco tempo. Aguarde antes de tentar de novo.");
    const { email } = schema.parse(superjson.parse(await request.text()));
    const normalized = normalizeResetEmail(email);

    // Sem limite em memória por e-mail: cada e-mail distinto criaria um contador novo (memória sem limite para um atacante que gira e-mails inexistentes — medido na F2).
    // O teto por CONTA é aplicado no BANCO (cooldown de 60 s + 3 tokens/hora), vale entre reinícios e instâncias, e o IP continua limitado acima.
    scheduleResetWork(processResetRequest(normalized));

    return jsonResponse(202, { message: GENERIC_MESSAGE });
  } catch (error: unknown) {
    console.error("Erro no pedido de redefinição de senha:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível processar o pedido");
  }
}
