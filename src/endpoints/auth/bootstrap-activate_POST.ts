import { db } from "../../helpers/db.js";
import { buildErrorResponse } from "../../helpers/errorResponse.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../helpers/rateLimit.js";
import { recordAuditLogEntry } from "../../helpers/auditLog.js";
import { setChallengeCookie } from "../../helpers/authChallenges.js";
import { ipPrefix } from "../../helpers/loginAudit.js";
import { activateBootstrapToken } from "../../helpers/platformBootstrap.js";
import { jsonResponse } from "../../helpers/authResponses.js";
import { schema } from "./bootstrap-activate_POST.schema.js";
import superjson from "superjson";

const LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };

/**
 * Ativação do bootstrap do Platform Owner. A ÚNICA rota pública relacionada — mas inútil sem um token emitido pelo CLI
 * offline (256 bits, HMAC no banco, 15 min, uso único). Qualquer token ruim (inexistente, de outro ambiente, expirado,
 * usado, revogado, já reivindicado) devolve a MESMA resposta. Não cria usuário, owner nem sessão: abre só o challenge.
 */
export async function handle(request: Request) {
  try {
    const ip = getClientIp(request);
    const limit = checkRateLimit({ bucket: "bootstrap-activate", identifier: ip, ...LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitas tentativas. Aguarde antes de tentar de novo.");
    const input = schema.parse(superjson.parse(await request.text()));
    const now = new Date();

    const result = await activateBootstrapToken(input.token, now);
    if (!result.ok) {
      const gate = checkRateLimit({ bucket: "bootstrap-failure-audit", identifier: ipPrefix(ip), limit: 1, windowMs: 10 * 60 * 1000 });
      if (gate.allowed) {
        await db.transaction().execute((trx) =>
          recordAuditLogEntry({ organizationId: null, actorUserId: null, action: "plataforma.bootstrap_falhou", entityType: "platform_bootstrap", entityId: null, metadata: { ipPrefix: ipPrefix(ip) } }, trx)
        );
      }
      return jsonResponse(401, { message: "Token inválido, expirado ou já utilizado.", code: "bootstrap_invalido" });
    }
    const response = jsonResponse(200, {
      purpose: result.purpose,
      email: result.email,
      expiresInSeconds: Math.max(1, Math.floor((result.challengeExpiresAt.getTime() - now.getTime()) / 1000)),
    });
    setChallengeCookie(response, result.challengeSecret, result.challengeExpiresAt, now);
    return response;
  } catch (error: unknown) {
    console.error("Erro na ativação do bootstrap:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível ativar");
  }
}
