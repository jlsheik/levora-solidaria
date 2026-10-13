import { db } from "../../helpers/db.js";
import { buildErrorResponse, ConflictError } from "../../helpers/errorResponse.js";
import { NotAuthenticatedError } from "../../helpers/getSetServerSession.js";
import { getServerUserSession } from "../../helpers/getServerUserSession.js";
import { recordAuditLogEntry } from "../../helpers/auditLog.js";
import { isPlatformMfaRequired } from "../../helpers/identityKeys.js";
import { getMfaMethod } from "../../helpers/mfa.js";
import { lockPlatformAccessInOrder, lockUsersInOrder } from "../../helpers/lockOrder.js";
import { rotateSessionInTx } from "../../helpers/sessionLifecycle.js";
import { requireRecentAuth } from "../../helpers/stepUp.js";
import { jsonResponse, sessionCookieResponse } from "../../helpers/authResponses.js";

/**
 * Desativa o MFA da própria conta (usuário comum). **Titular de platform_access (owner OU admin) NÃO pode**: o MFA da
 * plataforma é obrigatório e não removível (409 `mfa_obrigatorio`; o trigger deferido do banco é a defesa final).
 * Exige step-up recente; invalida os recovery codes, revoga as outras sessões e rotaciona a atual.
 */
export async function handle(request: Request) {
  try {
    const { user, session } = await getServerUserSession(request);
    requireRecentAuth(session);
    const now = new Date();
    const rotated = await db.transaction().execute(async (trx) => {
      await lockUsersInOrder(trx, [user.id]);
      const [access] = await lockPlatformAccessInOrder(trx, [user.id]);
      if (access && access.status === "active" && isPlatformMfaRequired()) {
        throw new ConflictError("O segundo fator é obrigatório para quem tem acesso à plataforma e não pode ser removido.", "mfa_obrigatorio");
      }
      const method = await getMfaMethod(trx, user.id, "active", { forUpdate: true });
      if (!method) throw new ConflictError("O autenticador não está ativo.", "mfa_nao_configurado");
      await trx.updateTable("mfaMethods").set({ status: "disabled", disabledAt: now }).where("id", "=", method.id).execute();
      await trx.updateTable("mfaRecoveryCodes").set({ invalidatedAt: now }).where("userId", "=", user.id).where("usedAt", "is", null).where("invalidatedAt", "is", null).execute();
      const revoked = await trx.deleteFrom("sessions").where("userId", "=", user.id).where("id", "<>", session.id).returning("id").execute();
      const next = await rotateSessionInTx(trx, session.id, { reauth: true });
      await recordAuditLogEntry({ organizationId: null, actorUserId: user.id, action: "mfa.desativado", entityType: "user", entityId: String(user.id), metadata: { tipo: "totp", outrasSessoesRevogadas: revoked.length } }, trx);
      return next;
    });
    return sessionCookieResponse({ message: "Autenticador desativado." }, { id: rotated.newId, createdAt: rotated.createdAt, absoluteExpiresAt: rotated.absoluteExpiresAt }, now);
  } catch (error: unknown) {
    if (error instanceof NotAuthenticatedError) return jsonResponse(401, { error: "Not authenticated" });
    return buildErrorResponse(error, "Não foi possível desativar o autenticador");
  }
}
