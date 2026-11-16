import { createHash } from "node:crypto";
import { buildErrorResponse } from "../../helpers/errorResponse.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../helpers/rateLimit.js";
import { jsonResponse } from "../../helpers/authResponses.js";
import { normalizeResetEmail, processResetRequest, scheduleResetWork } from "../../helpers/passwordReset.js";
import { schema } from "./password-reset-request_POST.schema.js";
import superjson from "superjson";

// Limites (em memória, por processo: com mais de uma instância precisam ser compartilhados — ver docs/RECUPERACAO_DE_ACESSO_ESPECIFICACAO.md §3.5).
const IP_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };
const EMAIL_LIMIT = { limit: 3, windowMs: 60 * 60 * 1000 };

export const GENERIC_MESSAGE = "Se existir uma conta com este e-mail, enviaremos as instruções para redefinir a senha em instantes. Confira também a caixa de spam.";

/**
 * Pedido público de redefinição de senha. A resposta é IDÊNTICA (corpo, status, cabeçalhos e, por construção, tempo) para qualquer e-mail
 * bem formado: conta inexistente, inelegível, em cooldown, limite por e-mail esgotado, e-mail não configurado ou envio falho. O trabalho real
 * (consulta, token, envio) roda DEPOIS da resposta. Só o limite por IP responde diferente (429), e ele não depende de a conta existir.
 */
export async function handle(request: Request) {
  try {
    const limit = checkRateLimit({ bucket: "password-reset-request", identifier: getClientIp(request), ...IP_LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitos pedidos em pouco tempo. Aguarde antes de tentar de novo.");
    const { email } = schema.parse(superjson.parse(await request.text()));
    const normalized = normalizeResetEmail(email);

    // O identificador do limite é um hash: o mapa em memória não guarda o e-mail em claro.
    const perEmail = checkRateLimit({ bucket: "password-reset-email", identifier: createHash("sha256").update(normalized).digest("hex"), ...EMAIL_LIMIT });
    if (perEmail.allowed) scheduleResetWork(processResetRequest(normalized));

    return jsonResponse(202, { message: GENERIC_MESSAGE });
  } catch (error: unknown) {
    console.error("Erro no pedido de redefinição de senha:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível processar o pedido");
  }
}
