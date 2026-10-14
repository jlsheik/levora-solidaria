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
      .selectFrom("sources")
      .select([
        "id",
        "name",
        "type",
        "connectorKey",
        "status",
        "connectionState",
        "endpointOrAddress",
        "runFrequencyMinutes",
        "lastRunAt",
        "lastValidatedAt",
        "recentErrors",
        "createdAt",
      ])
      .orderBy("createdAt", "desc")
      .execute();

    return new Response(
      superjson.stringify({
        sources: rows.map((r) => ({
          ...r,
          lastRunAt: r.lastRunAt ? r.lastRunAt.toString() : null,
          lastValidatedAt: r.lastValidatedAt ? r.lastValidatedAt.toString() : null,
          createdAt: r.createdAt.toString(),
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar fontes:", error);
    return buildErrorResponse(error, "Falha ao carregar fontes");
  }
}
