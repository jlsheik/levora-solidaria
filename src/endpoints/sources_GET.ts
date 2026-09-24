import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePlatformAdmin } from "../helpers/platformAccess";
import superjson from "superjson";

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
    const message = error instanceof Error ? error.message : "Falha ao carregar fontes";
    const status = message.includes("restrita") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
