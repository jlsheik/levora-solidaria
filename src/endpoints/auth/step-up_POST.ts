import { db } from "../../helpers/db.js";
import { buildErrorResponse, ConflictError } from "../../helpers/errorResponse.js";
import { NotAuthenticatedError } from "../../helpers/getSetServerSession.js";
import { getServerUserSession } from "../../helpers/getServerUserSession.js";
import { checkRateLimit, rateLimitResponse } from "../../helpers/rateLimit.js";
import { recordAuditLogEntry } from "../../helpers/auditLog.js";
import { consumeRecoveryCode, getMfaMethod, lockStatus, verifyTotp } from "../../helpers/mfa.js";
import { lockUsersInOrder } from "../../helpers/lockOrder.js";
import { rotateSessionInTx } from "../../helpers/sessionLifecycle.js";
import { jsonResponse, sessionCookieResponse } from "../../helpers/authResponses.js";
import { schema } from "./step-up_POST.schema.js";
import superjson from "superjson";

const LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };

/**
 * Step-up: reautenticação com o segundo fator para ações críticas. NÃO cria sessão paralela: marca `last_reauth_at` na MESMA
 * sessão (e rotaciona o id). Vale por uma janela curta (ver stepUp.tsx). Compartilha o contador/bloqueio persistido do TOTP.
 */
export async function handle(request: Request) {
  try {
    const { user, session } = await getServerUserSession(request);
    const limit = checkRateLimit({ bucket: "step-up", identifier: String(user.id), ...LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitas tentativas. Aguarde antes de tentar de novo.");
    const input = schema.parse(superjson.parse(await request.text()));
    const now = new Date();

    const outcome = await db.transaction().execute(async (trx) => {
      await lockUsersInOrder(trx, [user.id]);
      const method = await getMfaMethod(trx, user.id, "active", { forUpdate: true });
      if (!method) throw new ConflictError("Ative o autenticador para confirmar ações críticas.", "mfa_nao_configurado");
      const usingRecovery = input.recoveryCode !== undefined;
      const lock = lockStatus(method, now);
      if (lock.locked && !usingRecovery) return { type: "bloqueado" as const, retryAfterSeconds: lock.retryAfterSeconds };
      const result = usingRecovery ? await consumeRecoveryCode(trx, method, input.recoveryCode!, now) : await verifyTotp(trx, method, input.code!, now);
      if (!result.ok) {
        await recordAuditLogEntry({ organizationId: null, actorUserId: user.id, action: "step_up.falhou", entityType: "user", entityId: String(user.id), metadata: { tipo: usingRecovery ? "recovery_code" : "totp", motivo: result.reason } }, trx);
        return result.reason === "locked" ? { type: "bloqueado" as const, retryAfterSeconds: result.retryAfterSeconds ?? 60 } : { type: "falha" as const };
      }
      const rotated = await rotateSessionInTx(trx, session.id, { reauth: true });
      await recordAuditLogEntry({ organizationId: null, actorUserId: user.id, action: "step_up.concluido", entityType: "user", entityId: String(user.id), metadata: { tipo: usingRecovery ? "recovery_code" : "totp" } }, trx);
      return { type: "ok" as const, rotated };
    });

    if (outcome.type === "bloqueado") return jsonResponse(429, { message: "Muitas tentativas incorretas. Aguarde um pouco antes de tentar de novo.", code: "mfa_bloqueado" }, { "Retry-After": String(outcome.retryAfterSeconds) });
    if (outcome.type === "falha") return jsonResponse(401, { message: "Código incorreto.", code: "codigo_invalido" });
    return sessionCookieResponse({ message: "Identidade confirmada." }, { id: outcome.rotated.newId, createdAt: outcome.rotated.createdAt, absoluteExpiresAt: outcome.rotated.absoluteExpiresAt }, now);
  } catch (error: unknown) {
    if (error instanceof NotAuthenticatedError) return jsonResponse(401, { error: "Not authenticated" });
    return buildErrorResponse(error, "Não foi possível confirmar sua identidade");
  }
}
