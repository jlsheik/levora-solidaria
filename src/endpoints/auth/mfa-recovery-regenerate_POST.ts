import { db } from "../../helpers/db.js";
import { buildErrorResponse, ConflictError } from "../../helpers/errorResponse.js";
import { NotAuthenticatedError } from "../../helpers/getSetServerSession.js";
import { getServerUserSession } from "../../helpers/getServerUserSession.js";
import { recordAuditLogEntry } from "../../helpers/auditLog.js";
import { getMfaMethod, issueRecoveryCodes } from "../../helpers/mfa.js";
import { lockUsersInOrder } from "../../helpers/lockOrder.js";
import { requireRecentAuth } from "../../helpers/stepUp.js";
import { jsonResponse } from "../../helpers/authResponses.js";

/**
 * Regenera os recovery codes: sessão completa + step-up recente + MFA ativo. Os códigos antigos ficam inválidos
 * (`invalidated_at`) na MESMA transação; os novos são devolvidos UMA vez. Nunca anônimo.
 */
export async function handle(request: Request) {
  try {
    const { user, session } = await getServerUserSession(request);
    requireRecentAuth(session);
    const recoveryCodes = await db.transaction().execute(async (trx) => {
      await lockUsersInOrder(trx, [user.id]);
      const method = await getMfaMethod(trx, user.id, "active", { forUpdate: true });
      if (!method) throw new ConflictError("Ative o autenticador antes de gerar códigos de recuperação.", "mfa_nao_configurado");
      const codes = await issueRecoveryCodes(trx, user.id);
      await recordAuditLogEntry({ organizationId: null, actorUserId: user.id, action: "mfa.recovery_codes_regenerados", entityType: "user", entityId: String(user.id), metadata: { quantidade: codes.length } }, trx);
      return codes;
    });
    return jsonResponse(200, { recoveryCodes });
  } catch (error: unknown) {
    if (error instanceof NotAuthenticatedError) return jsonResponse(401, { error: "Not authenticated" });
    return buildErrorResponse(error, "Não foi possível gerar novos códigos de recuperação");
  }
}
