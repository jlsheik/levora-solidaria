import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { schema } from "./background-tasks-retry_POST.schema.js";
import { TASK_HANDLERS } from "../helpers/taskHandlers.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

// Reprocessamento manual real: reexecuta a mesma função da tarefa (não
// apenas marca a linha como "reprocessada"). Cada execução gera sua
// própria linha nova em background_task_runs — o histórico da tentativa
// que falhou continua lá, intacto.

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);

    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    const run = await db
      .selectFrom("backgroundTaskRuns")
      .select(["id", "taskName", "status"])
      .where("id", "=", String(input.runId))
      .executeTakeFirst();

    if (!run) {
      return new Response(superjson.stringify({ message: "Execução não encontrada" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (run.status !== "falhou") {
      return new Response(superjson.stringify({ message: `Só é possível reprocessar tarefas com status "falhou" (atual: ${run.status})` }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }

    const handler = TASK_HANDLERS[run.taskName];
    if (!handler) {
      return new Response(superjson.stringify({ message: `Nenhum handler conhecido para a tarefa "${run.taskName}"` }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    await handler();

    return new Response(superjson.stringify({ message: "Tarefa reprocessada" }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao reprocessar tarefa:", error);
    return buildErrorResponse(error, "Não foi possível reprocessar a tarefa");
  }
}
