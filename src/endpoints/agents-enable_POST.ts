import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { newCorrelationId } from "../helpers/correlation.js";
import { ensureAgentPrincipal } from "../helpers/agentRegistry.js";
import { ENGINE_AGENT_NAMES } from "../helpers/agentEventEngine.js";
import { fenceForOrganizationChange } from "../helpers/policyFence.js";
import { schema } from "./agents-enable_POST.schema.js";
import superjson from "superjson";

/**
 * M34 — uma PESSOA liga ou desliga um agente PARA A PRÓPRIA ORGANIZAÇÃO (`automacao.gerencie`). É a única forma de um agente começar a avaliar eventos: o motor nunca registra nem liga agente
 * sozinho. Cria (se preciso) o principal RESTRITO à organização — nunca toca o principal global, que é da plataforma. Só agentes que o motor aciona hoje podem ser ligados; ligar é só simulação.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));
    await requirePermission(user.id, input.organizationId, "automacao.gerencie");
    if (!ENGINE_AGENT_NAMES.includes(input.agent)) throw new Error("Agente sem eventos no motor");
    await db.transaction().execute(async (trx) => {
      // M36: cerca de política — ligar/desligar o agente é ordenado, pelo banco, em relação às conclusões do motor (ver policyFence.tsx).
      await fenceForOrganizationChange(trx, input.organizationId);
      const principal = await ensureAgentPrincipal(trx, input.agent, input.organizationId);
      const before = principal.enabled;
      await trx.updateTable("agentPrincipals").set({ enabled: input.enabled }).where("id", "=", principal.id).execute();
      await recordAuditLogEntry(
        { organizationId: input.organizationId, actorUserId: user.id, action: input.enabled ? "automacao.agente_ligado" : "automacao.agente_desligado", outcome: "concluida", correlationId: newCorrelationId(), entityType: "agent_principal", entityId: String(principal.id), metadata: { agente: input.agent, antes: before, depois: input.enabled, simulado: true } },
        trx
      );
    });
    return new Response(superjson.stringify({ agent: input.agent, enabled: input.enabled, scope: "organizacao" as const }), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao ligar/desligar agente:", error);
    return buildErrorResponse(error, "Não foi possível alterar o agente");
  }
}
