import { db } from "../../helpers/db.js";
import { getServerUserSession } from "../../helpers/getServerUserSession.js";
import { NotAuthenticatedError } from "../../helpers/getSetServerSession.js";
import { recordAuditLogEntry } from "../../helpers/auditLog.js";
import { lockUserAndSessions } from "../../helpers/userSessions.js";
import { buildErrorResponse } from "../../helpers/errorResponse.js";
import superjson from "superjson";

const json = (status: number, body: Record<string, unknown>) =>
  new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Revoga TODAS as outras sessões do próprio usuário (Fase 88); a atual permanece. Idempotente (0 é um resultado válido). */
export async function handle(request: Request) {
  try {
    const { user, session } = await getServerUserSession(request);

    const revoked = await db.transaction().execute(async (trx) => {
      const rows = await lockUserAndSessions(trx, user.id, session.id);
      const others = rows.filter((r) => r.id !== session.id).map((r) => r.id);
      if (others.length === 0) return 0;
      await trx.deleteFrom("sessions").where("userId", "=", user.id).where("id", "in", others).execute();
      await recordAuditLogEntry(
        { organizationId: null, actorUserId: user.id, action: "usuario.sessoes_revogadas", entityType: "user", entityId: String(user.id), metadata: { quantidade: others.length } },
        trx
      );
      return others.length;
    });

    return json(200, { revoked });
  } catch (error: unknown) {
    if (error instanceof NotAuthenticatedError) return json(401, { error: "Not authenticated" });
    console.error("Erro ao revogar sessões:", error);
    return buildErrorResponse(error, "Não foi possível encerrar as outras sessões");
  }
}
