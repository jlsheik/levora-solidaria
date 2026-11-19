import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { runAgentEventEngine } from "../helpers/agentEventEngine.js";
import { schema } from "./agent-engine-run_POST.schema.js";
import superjson from "superjson";

/**
 * M34 — "Processar eventos agora (simulação)": roda UMA passada do motor SÓ para a organização do pedido (`automacao.gerencie`, organização ativa). É o mesmo código da tarefa agendada, limitado
 * à organização; nada executa fora do sistema, pausa/emergência/limites valem como sempre.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));
    await requirePermission(user.id, input.organizationId, "automacao.gerencie");
    const summary = await runAgentEventEngine({ organizationId: input.organizationId, batchSize: 50 });
    return new Response(superjson.stringify({ ...summary, simulated: true as const }), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao processar eventos dos agentes:", error);
    return buildErrorResponse(error, "Não foi possível processar os eventos");
  }
}
