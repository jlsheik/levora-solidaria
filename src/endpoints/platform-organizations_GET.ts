import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePlatformAdmin } from "../helpers/platformAccess";
import superjson from "superjson";

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
    const message = error instanceof Error ? error.message : "Falha ao carregar organizações";
    const status = message.includes("restrita") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
