import { db } from "../../helpers/db.js";
import { getServerUserSession } from "../../helpers/getServerUserSession.js";
import { NotAuthenticatedError } from "../../helpers/getSetServerSession.js";
import { sessionHandle } from "../../helpers/userSessions.js";
import { buildErrorResponse } from "../../helpers/errorResponse.js";
import superjson from "superjson";

/**
 * Lista as sessões do PRÓPRIO usuário (Fase 88). Sem id real de sessão, sem IP e sem user agent (não são gravados);
 * `expiresAt` também fica de fora (a coluna nunca é lida pela validação — mostrá-la seria enganoso).
 */
export async function handle(request: Request) {
  try {
    const { user, session } = await getServerUserSession(request);
    const rows = await db
      .selectFrom("sessions")
      .select(["id", "createdAt", "lastAccessed"])
      .where("userId", "=", user.id)
      .orderBy("createdAt", "desc")
      .orderBy("id", "asc")
      .execute();
    const sessions = rows.map((r) => ({
      sessionHandle: sessionHandle(r.id),
      createdAt: r.createdAt,
      lastAccessed: r.lastAccessed,
      current: r.id === session.id,
    }));
    return new Response(superjson.stringify({ sessions }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    if (error instanceof NotAuthenticatedError) {
      return new Response(superjson.stringify({ error: "Not authenticated" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    console.error("Erro ao listar sessões:", error);
    return buildErrorResponse(error, "Não foi possível carregar as sessões");
  }
}
