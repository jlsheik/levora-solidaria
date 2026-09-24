import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePlatformAdmin } from "../helpers/platformAccess";
import { schema } from "./background-tasks-retry_POST.schema";
import { expireOpportunities } from "../helpers/expireOpportunities";
import { expireReservations } from "../helpers/expireReservations";
import { runMatchingSweep } from "../helpers/runMatchingSweep";
import superjson from "superjson";

// Reprocessamento manual real: reexecuta a mesma função da tarefa (não
// apenas marca a linha como "reprocessada"). Cada execução gera sua
// própria linha nova em background_task_runs — o histórico da tentativa
// que falhou continua lá, intacto.
const TASK_HANDLERS: Record<string, () => Promise<void>> = {
  expireOpportunities,
  expireReservations,
  runMatchingSweep,
};

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
    const message = error instanceof Error ? error.message : "Não foi possível reprocessar a tarefa";
    const status = message.includes("restrita") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
