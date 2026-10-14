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
      .selectFrom("backgroundTaskRuns")
      .select(["id", "taskName", "status", "attemptCount", "maxAttempts", "error", "result", "startedAt", "finishedAt", "createdAt"])
      .orderBy("createdAt", "desc")
      .limit(50)
      .execute();

    return new Response(
      superjson.stringify({
        runs: rows.map((r) => ({
          ...r,
          id: String(r.id),
          startedAt: r.startedAt ? r.startedAt.toString() : null,
          finishedAt: r.finishedAt ? r.finishedAt.toString() : null,
          createdAt: r.createdAt.toString(),
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar tarefas:", error);
    return buildErrorResponse(error, "Falha ao carregar tarefas");
  }
}
