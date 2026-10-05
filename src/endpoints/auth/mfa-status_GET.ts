import { db } from "../../helpers/db.js";
import { buildErrorResponse } from "../../helpers/errorResponse.js";
import { NotAuthenticatedError } from "../../helpers/getSetServerSession.js";
import { getServerUserSession } from "../../helpers/getServerUserSession.js";
import { isPlatformMfaRequired } from "../../helpers/identityKeys.js";
import { countOpenRecoveryCodes, getMfaMethod } from "../../helpers/mfa.js";
import { isRecentlyAuthenticated } from "../../helpers/stepUp.js";
import { jsonResponse } from "../../helpers/authResponses.js";

/** Estado do MFA da PRÓPRIA conta (nunca de outra): ativo?, pendente?, quantos recovery codes restam, se é obrigatório por política. */
export async function handle(request: Request) {
  try {
    const { user, session } = await getServerUserSession(request);
    const status = await db.transaction().execute(async (trx) => ({
      active: (await getMfaMethod(trx, user.id, "active")) !== undefined,
      pending: (await getMfaMethod(trx, user.id, "pending")) !== undefined,
      recoveryCodesRemaining: await countOpenRecoveryCodes(trx, user.id),
    }));
    return jsonResponse(200, {
      ...status,
      requiredByPolicy: Boolean(user.platformLevel) && isPlatformMfaRequired(),
      recentlyAuthenticated: isRecentlyAuthenticated(session),
    });
  } catch (error: unknown) {
    if (error instanceof NotAuthenticatedError) return jsonResponse(401, { error: "Not authenticated" });
    return buildErrorResponse(error, "Não foi possível carregar o estado do MFA");
  }
}
