import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { requireRecentAuth } from "../helpers/stepUp.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { checkRateLimit, rateLimitResponse } from "../helpers/rateLimit.js";
import { AccessCodeValidityError, createAccessCode, maskAccessCode, resolveExpiry } from "../helpers/registrationCodes.js";
import { jsonResponse } from "../helpers/authResponses.js";
import { NotAuthenticatedError } from "../helpers/getSetServerSession.js";
import { schema } from "./platform-access-codes-create_POST.schema.js";
import superjson from "superjson";

const ADMIN_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };

/**
 * Emite um código de acesso. FUNÇÃO DA PLATAFORMA: exige `platform_access` ativo (owner ou admin) verificado no BACKEND — papel de
 * organização nunca basta — e STEP-UP recente (mesmo `requireRecentAuth` da Fase 90). O texto puro do código é devolvido UMA vez,
 * nesta resposta; não existe endpoint que o mostre de novo (perdeu ⇒ revogar e gerar outro).
 */
export async function handle(request: Request) {
  try {
    const { user, session } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);
    requireRecentAuth(session);

    const limit = checkRateLimit({ bucket: "access-code-create", identifier: String(user.id), ...ADMIN_LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitos códigos gerados em pouco tempo. Aguarde antes de gerar outro.");

    const input = schema.parse(superjson.parse(await request.text()));
    const now = new Date();
    const expiresAt = resolveExpiry({ expiresInMinutes: input.expiresInMinutes, expiresAt: input.expiresAt }, now);

    const created = await db.transaction().execute((trx) => createAccessCode(trx, { actorUserId: user.id, label: input.label ?? null, expiresAt, now }));
    return jsonResponse(200, { id: created.id, code: created.code, masked: maskAccessCode(created.last4), last4: created.last4, expiresAt: created.expiresAt, status: "active" });
  } catch (error: unknown) {
    if (error instanceof NotAuthenticatedError) return jsonResponse(401, { error: "Not authenticated" });
    if (error instanceof AccessCodeValidityError) return jsonResponse(400, { message: error.message, code: "validade_invalida" });
    console.error("Erro ao gerar código de acesso:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível gerar o código");
  }
}
