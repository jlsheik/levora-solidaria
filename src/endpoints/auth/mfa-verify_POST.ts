import { db } from "../../helpers/db.js";
import { buildErrorResponse } from "../../helpers/errorResponse.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../helpers/rateLimit.js";
import { recordAuditLogEntry } from "../../helpers/auditLog.js";
import { auditLoginSuccess } from "../../helpers/loginAudit.js";
import { consumeChallenge, loadPendingChallengeForUpdate, peekChallengeUserId, readChallengeSecret, recordChallengeFailure, clearChallengeCookie } from "../../helpers/authChallenges.js";
import { consumeRecoveryCode, getMfaMethod, lockStatus, verifyTotp } from "../../helpers/mfa.js";
import { lockUsersInOrder } from "../../helpers/lockOrder.js";
import { createSession } from "../../helpers/sessionLifecycle.js";
import { invalidChallengeResponse, jsonResponse, loadUserPayload, sessionCookieResponse } from "../../helpers/authResponses.js";
import { schema } from "./mfa-verify_POST.schema.js";
import superjson from "superjson";

// Defesa em profundidade por IP (as tentativas por challenge e o bloqueio progressivo por método ficam no BANCO).
const IP_LIMIT = { limit: 30, windowMs: 15 * 60 * 1000 };

/**
 * Conclui o login com o segundo fator (TOTP ou recovery code). A sessão só nasce AQUI (id novo, `mfa_verified_at`): o
 * challenge nunca é uma sessão. Falhas não lançam — o contador de tentativas/bloqueio é confirmado no COMMIT.
 */
export async function handle(request: Request) {
  try {
    const ip = getClientIp(request);
    const limit = checkRateLimit({ bucket: "mfa-verify", identifier: ip, ...IP_LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitas tentativas de verificação. Aguarde antes de tentar de novo.");

    const secret = readChallengeSecret(request);
    if (!secret) return invalidChallengeResponse();
    const input = schema.parse(superjson.parse(await request.text()));
    const now = new Date();

    const outcome = await db.transaction().execute(async (trx) => {
      // Ordem canônica de locks: users → auth_challenges → mfa_methods → recovery → sessions → audit.
      const ownerId = await peekChallengeUserId(trx, secret);
      if (!ownerId) return { type: "invalido" as const };
      await lockUsersInOrder(trx, [ownerId]);
      const challenge = await loadPendingChallengeForUpdate(trx, secret, ["mfa_login"], now);
      if (!challenge || challenge.userId !== ownerId) return { type: "invalido" as const };
      const method = await getMfaMethod(trx, ownerId, "active", { forUpdate: true });
      if (!method) return { type: "invalido" as const };

      const lock = lockStatus(method, now);
      if (lock.locked) return { type: "bloqueado" as const, retryAfterSeconds: lock.retryAfterSeconds };

      const usingRecovery = input.recoveryCode !== undefined;
      const result = usingRecovery ? await consumeRecoveryCode(trx, method, input.recoveryCode!, now) : await verifyTotp(trx, method, input.code!, now);

      if (!result.ok) {
        const { exhausted } = await recordChallengeFailure(trx, challenge);
        await recordAuditLogEntry(
          {
            organizationId: null,
            actorUserId: ownerId,
            action: "mfa.tentativa_falhou",
            entityType: "user",
            entityId: String(ownerId),
            metadata: { tipo: usingRecovery ? "recovery_code" : "totp", motivo: result.reason, desafioEsgotado: exhausted },
          },
          trx
        );
        return result.reason === "locked"
          ? { type: "bloqueado" as const, retryAfterSeconds: result.retryAfterSeconds ?? 60 }
          : { type: "falha" as const, exhausted };
      }

      if (!(await consumeChallenge(trx, challenge.id, now))) return { type: "invalido" as const };
      const session = await createSession(trx, { userId: ownerId, primaryMethod: (challenge.primaryMethod as "password") ?? "password", mfaVerified: true, now });
      const user = await loadUserPayload(trx, ownerId);

      await recordAuditLogEntry(
        { organizationId: null, actorUserId: ownerId, action: usingRecovery ? "mfa.recovery_code_usado" : "mfa.utilizado", entityType: "user", entityId: String(ownerId), metadata: { contexto: "login" } },
        trx
      );
      await auditLoginSuccess(trx, { userId: ownerId, method: "senha", ip });
      return { type: "ok" as const, session, user };
    });

    if (outcome.type === "invalido") return invalidChallengeResponse();
    if (outcome.type === "bloqueado") {
      return jsonResponse(429, { message: "Muitas tentativas incorretas. Aguarde um pouco antes de tentar de novo.", code: "mfa_bloqueado" }, { "Retry-After": String(outcome.retryAfterSeconds) });
    }
    if (outcome.type === "falha") {
      const response = jsonResponse(401, { message: outcome.exhausted ? "Código incorreto. Esta verificação foi encerrada; entre novamente." : "Código incorreto.", code: outcome.exhausted ? "challenge_esgotado" : "codigo_invalido" });
      if (outcome.exhausted) clearChallengeCookie(response);
      return response;
    }
    return sessionCookieResponse({ user: outcome.user }, outcome.session, now);
  } catch (error: unknown) {
    console.error("Erro na verificação de MFA:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível verificar o código");
  }
}
