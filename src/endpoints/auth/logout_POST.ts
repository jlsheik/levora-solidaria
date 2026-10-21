// adapt this to your database schema
import { db } from "../../helpers/db.js";
import {
  getServerSessionOrThrow,
  clearServerSession,
  NotAuthenticatedError,
} from "../../helpers/getSetServerSession.js";
import { recordAuditLogEntry } from "../../helpers/auditLog.js";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    // Get the current session
    const session = await getServerSessionOrThrow(request);

    // Delete the session from the database. Fase 89: o logout é auditado (usuario.logout) na MESMA transação — só se a
    // linha existia (logout repetido/ com sessão já revogada não gera evento nem revela nada).
    await db.transaction().execute(async (trx) => {
      const removed = await trx.deleteFrom("sessions").where("id", "=", session.id).returning(["userId"]).executeTakeFirst();
      if (removed) {
        await recordAuditLogEntry(
          { organizationId: null, actorUserId: removed.userId, action: "usuario.logout", entityType: "user", entityId: String(removed.userId), metadata: {} },
          trx
        );
      }
    });

    // Create response with success message
    const response = new Response(
      superjson.stringify({
        success: true,
        message: "Logged out successfully",
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    clearServerSession(response);

    return response;
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return new Response(
        superjson.stringify({ error: "Not authenticated" }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }
    console.error("Logout error:", error);
    return new Response(
      superjson.stringify({
        error: "Logout failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
}
