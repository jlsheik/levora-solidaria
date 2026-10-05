import { db } from "../../helpers/db.js";
import { getServerUserSession } from "../../helpers/getServerUserSession.js";
import { NotAuthenticatedError } from "../../helpers/getSetServerSession.js";
import { buildErrorResponse } from "../../helpers/errorResponse.js";
import { jsonResponse } from "../../helpers/authResponses.js";
import { getMfaMethod } from "../../helpers/mfa.js";

/** Quais métodos a conta tem (senha, provedores, MFA). O usuário vem da SESSÃO; nada vem do cliente. */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const [password, identities, mfa] = await Promise.all([
      db.selectFrom("userPasswords").select("userId").where("userId", "=", user.id).executeTakeFirst(),
      db.selectFrom("userIdentities").select("provider").where("userId", "=", user.id).execute(),
      db.transaction().execute((trx) => getMfaMethod(trx, user.id, "active")),
    ]);
    return jsonResponse(200, { hasPassword: Boolean(password), providers: [...new Set(identities.map((i) => i.provider))], mfaActive: Boolean(mfa) });
  } catch (error: unknown) {
    if (error instanceof NotAuthenticatedError) return jsonResponse(401, { error: "Not authenticated" });
    return buildErrorResponse(error, "Não foi possível consultar os métodos da conta");
  }
}
