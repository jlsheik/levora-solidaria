import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);

    const rows = await db
      .selectFrom("organizations")
      .select(["id", "name", "type", "status", "city", "state"])
      .orderBy("name", "asc")
      .execute();

    return new Response(superjson.stringify({ organizations: rows }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao listar organizações (plataforma):", error);
    return buildErrorResponse(error, "Falha ao carregar organizações");
  }
}
