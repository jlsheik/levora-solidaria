import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { requireRecentAuth } from "../helpers/stepUp.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { checkRateLimit, rateLimitResponse } from "../helpers/rateLimit.js";
import { revokeAccessCode } from "../helpers/registrationCodes.js";
import { jsonResponse } from "../helpers/authResponses.js";
import { NotAuthenticatedError } from "../helpers/getSetServerSession.js";
import { schema } from "./platform-access-codes-revoke_POST.schema.js";
import superjson from "superjson";

const ADMIN_LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 };

/**
 * Revoga um código ATIVO. Mesma exigência da emissão: `platform_access` + step-up recente, no backend. Revogação é terminal (nunca
 * reativa): resgatado/revogado/expirado ⇒ 409; inexistente ⇒ 404. Concorrência com o consumo: ambos usam UPDATE condicional na mesma
 * linha — exatamente um vence (nunca "revogado e utilizado": CHECK no banco).
 */
export async function handle(request: Request) {
  try {
    const { user, session } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);
    requireRecentAuth(session);

    const limit = checkRateLimit({ bucket: "access-code-revoke", identifier: String(user.id), ...ADMIN_LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitas revogações em pouco tempo. Aguarde antes de tentar de novo.");

    const input = schema.parse(superjson.parse(await request.text()));
    const result = await db.transaction().execute((trx) => revokeAccessCode(trx, { actorUserId: user.id, codeId: input.id }));
    if (!result.ok) {
      return result.reason === "nao_encontrado"
        ? jsonResponse(404, { message: "Código não encontrado", code: "codigo_nao_encontrado" })
        : jsonResponse(409, { message: "Só é possível revogar um código ativo", code: "codigo_nao_ativo" });
    }
    return jsonResponse(200, { message: "Código revogado" });
  } catch (error: unknown) {
    if (error instanceof NotAuthenticatedError) return jsonResponse(401, { error: "Not authenticated" });
    console.error("Erro ao revogar código de acesso:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível revogar o código");
  }
}
