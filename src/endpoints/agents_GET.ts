import { sql } from "kysely";
import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { AGENT_DEFINITIONS } from "../helpers/agentRegistry.js";
import { TOOL_CLASS_BY_NAME } from "../helpers/agentTools.js";
import { getAutomationState } from "../helpers/automationControls.js";
import { schema, type AgentOverview, type OutputType } from "./agents_GET.schema.js";
import { EVENT_CONTRACTS, CONTRACTED_EVENT_TYPES } from "../helpers/agentEventEngine.js";
import superjson from "superjson";

/**
 * M33 — visão operacional dos agentes de uma organização (somente leitura; `automacao.leia`). Junta o REGISTRO EM CÓDIGO (quem existe e o que pode fazer) com o que o banco sabe (principal registrado,
 * interruptor, alertas abertos, exceções pendentes, última ação auditada). Nada é inventado: agente sem principal aparece como "não registrado"; contagens vêm de consultas escopadas à organização.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ organizationId: url.searchParams.get("organizationId") });

    await requirePermissionToRead(user.id, input.organizationId, "automacao.leia");

    const principals = await db
      .selectFrom("agentPrincipals")
      .select(["id", "name", "version", "organizationId", "enabled"])
      .where((eb) => eb.or([eb("organizationId", "is", null), eb("organizationId", "=", input.organizationId)]))
      .execute();
    const ids = principals.map((p) => p.id);

    const alertCounts = ids.length
      ? await db
          .selectFrom("integrityAlerts")
          .select(["createdByAgentPrincipalId as agentId", (eb) => eb.fn.countAll<string>().as("total")])
          .where("organizationId", "=", input.organizationId)
          .where("status", "in", ["aberto", "reconhecido"])
          .where("createdByAgentPrincipalId", "in", ids)
          .groupBy("createdByAgentPrincipalId")
          .execute()
      : [];
    const exceptionCounts = ids.length
      ? await db
          .selectFrom("exceptionQueue")
          .select(["agentPrincipalId as agentId", (eb) => eb.fn.countAll<string>().as("total")])
          .where("organizationId", "=", input.organizationId)
          .where("status", "=", "pendente")
          .where("agentPrincipalId", "in", ids)
          .groupBy("agentPrincipalId")
          .execute()
      : [];
    const lastActions = ids.length
      ? await db
          .selectFrom("auditLog")
          .select(["actorAgentPrincipalId as agentId", (eb) => eb.fn.max("createdAt").as("last")])
          .where("organizationId", "=", input.organizationId)
          .where("actorAgentPrincipalId", "in", ids)
          .groupBy("actorAgentPrincipalId")
          .execute()
      : [];

    const consumers = await sql<{ consumer: string; processed: string; failed: string; last: Date | null }>`
      SELECT consumer, count(*) FILTER (WHERE outcome = 'ok') AS processed, count(*) FILTER (WHERE outcome = 'erro') AS failed, max(processed_at) AS last
        FROM domain_event_consumptions c JOIN domain_events ev ON ev.id = c.event_id WHERE ev.organization_id = ${input.organizationId} GROUP BY consumer ORDER BY consumer`.execute(db);

    const agents: AgentOverview[] = (Object.keys(AGENT_DEFINITIONS) as Array<keyof typeof AGENT_DEFINITIONS>).map((name) => {
      const def = AGENT_DEFINITIONS[name];
      // Preferência: principal da própria organização; senão o global; senão não registrado.
      const own = principals.find((p) => p.name === name && p.organizationId === input.organizationId);
      const global = principals.find((p) => p.name === name && p.organizationId === null);
      const principal = own ?? global ?? null;
      const idsOfAgent = principals.filter((p) => p.name === name).map((p) => p.id);
      const sum = (rows: Array<{ agentId: number | null; total: string }>) => rows.filter((r) => r.agentId !== null && idsOfAgent.includes(r.agentId)).reduce((n, r) => n + Number(r.total), 0);
      const last = lastActions.filter((r) => r.agentId !== null && idsOfAgent.includes(r.agentId)).map((r) => r.last).filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      return {
        name,
        label: def.label,
        purpose: def.purpose,
        version: def.version,
        scope: principal ? (principal.organizationId === null ? "global" : "organizacao") : "nao_registrado",
        registered: principal !== null,
        enabled: principal ? principal.enabled : null,
        tools: def.tools.map((t) => ({ name: t, klass: TOOL_CLASS_BY_NAME[t] })),
        eventTypes: CONTRACTED_EVENT_TYPES.filter((t) => EVENT_CONTRACTS[t].agent === name),
        openAlerts: sum(alertCounts as Array<{ agentId: number | null; total: string }>),
        pendingExceptions: sum(exceptionCounts as Array<{ agentId: number | null; total: string }>),
        lastActionAt: last ? last.toISOString() : null,
      };
    });

    const state = await getAutomationState(db, input.organizationId);
    const output: OutputType = {
      agents,
      summary: {
        total: agents.length,
        registered: agents.filter((a) => a.registered).length,
        enabled: agents.filter((a) => a.enabled === true).length,
        disabled: agents.filter((a) => a.enabled === false).length,
        withOpenAlerts: agents.filter((a) => a.openAlerts > 0).length,
        withPendingExceptions: agents.filter((a) => a.pendingExceptions > 0).length,
      },
      automation: { paused: state.paused, emergency: state.emergency, global: state.global, organization: state.organization },
      totals: await orgTotals(input.organizationId),
      eventConsumers: consumers.rows.map((r) => ({ consumer: r.consumer, processed: Number(r.processed), failed: Number(r.failed), lastProcessedAt: r.last ? new Date(r.last).toISOString() : null })),
    };
    return new Response(superjson.stringify(output), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao montar a visão dos agentes:", error);
    return buildErrorResponse(error, "Não foi possível carregar os agentes");
  }
}

async function orgTotals(organizationId: number) {
  const ex = await db.selectFrom("exceptionQueue").select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", organizationId).where("status", "=", "pendente").executeTakeFirstOrThrow();
  const al = await db.selectFrom("integrityAlerts").select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", organizationId).where("status", "in", ["aberto", "reconhecido"]).executeTakeFirstOrThrow();
  return { pendingExceptions: Number(ex.n), openAlerts: Number(al.n) };
}
