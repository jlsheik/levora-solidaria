import { buildErrorResponse } from "../../helpers/errorResponse.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../helpers/rateLimit.js";
import { jsonResponse } from "../../helpers/authResponses.js";
import { limiterKeyForIp } from "../../helpers/limiterKey.js";
import { confirmPasswordReset, notifyPasswordChanged } from "../../helpers/passwordReset.js";
import { schema } from "./password-reset-confirm_POST.schema.js";
import superjson from "superjson";

// Defesa em profundidade por IP; as tentativas de segundo fator são limitadas por token (no banco) e por método de MFA.
const IP_LIMIT = { limit: 20, windowMs: 15 * 60 * 1000 };

const LINK_MESSAGES = {
  expirado: { code: "link_expirado", message: "Este link expirou. Peça um novo para redefinir a senha." },
  utilizado: { code: "link_utilizado", message: "Este link já foi usado. Se precisar, peça um novo." },
  invalido: { code: "link_invalido", message: "Este link é inválido ou não vale mais. Peça um novo para redefinir a senha." },
} as const;

/**
 * Conclui a redefinição: nova senha (política existente), token de uso único, TODAS as sessões revogadas, MFA preservado e exigido quando ativo.
 * Não cria sessão: a pessoa volta ao login (e o MFA continua sendo cobrado lá).
 */
export async function handle(request: Request) {
  try {
    const limit = checkRateLimit({ bucket: "password-reset-confirm", identifier: limiterKeyForIp(getClientIp(request)), ...IP_LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitas tentativas em pouco tempo. Aguarde antes de tentar de novo.");
    const input = schema.parse(superjson.parse(await request.text()));
    const outcome = await confirmPasswordReset(input);

    switch (outcome.type) {
      case "ok":
        void notifyPasswordChanged(outcome.userId);
        return jsonResponse(200, { message: "Senha redefinida. Entre com a nova senha; todas as sessões anteriores foram encerradas." });
      case "link":
        return jsonResponse(400, LINK_MESSAGES[outcome.state]);
      case "senha_igual":
        return jsonResponse(422, { message: "A nova senha precisa ser diferente da atual", code: "senha_igual" });
      case "mfa_obrigatorio":
        return jsonResponse(422, { message: "Esta conta tem verificação em duas etapas. Informe o código do autenticador ou um código de recuperação.", code: "mfa_obrigatorio" });
      case "mfa_invalido":
        return jsonResponse(401, outcome.exhausted ? { ...LINK_MESSAGES.invalido, message: "Código incorreto. Por segurança, este link foi encerrado: peça um novo." } : { message: "Código incorreto.", code: "mfa_invalido" });
      case "mfa_bloqueado":
        return jsonResponse(429, { message: "Muitas tentativas incorretas. Aguarde um pouco ou use um código de recuperação.", code: "mfa_bloqueado" }, { "Retry-After": String(outcome.retryAfterSeconds) });
    }
  } catch (error: unknown) {
    console.error("Erro ao redefinir senha:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível redefinir a senha");
  }
}
