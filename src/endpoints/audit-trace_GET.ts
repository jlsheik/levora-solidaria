import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { buildTrace } from "../helpers/auditTrace.js";
import { schema, type OutputType } from "./audit-trace_GET.schema.js";
import superjson from "superjson";

/**
 * M38 — rastreabilidade Oportunidade → Evento → Avaliação → Decisão → Exceção → Reavaliação → Auditoria, para UMA organização. Exige `auditoria.leia`; as partes de agentes exigem também
 * `automacao.leia` e as de oportunidade `oportunidades.leia` (sem a permissão a parte simplesmente não vem, e isso é dito em `limits`). Qualquer id de outra organização responde 404.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const raw: Record<string, string | undefined> = {};
    for (const [k, v] of url.searchParams.entries()) raw[k] = v === "" ? undefined : v;
    const input = schema.parse(raw);
    const membership = await requirePermissionToRead(user.id, input.organizationId, "auditoria.leia");
    const trace = await buildTrace({
      organizationId: input.organizationId,
      canSeeOpportunity: roleHasPermission(membership.role, "oportunidades.leia"),
      canSeeAutomation: roleHasPermission(membership.role, "automacao.leia"),
      opportunityId: input.opportunityId, runId: input.runId, exceptionId: input.exceptionId, correlationId: input.correlationId,
    });
    if (!trace) return new Response(superjson.stringify({ message: "Nada encontrado nesta organização para o ponto de partida informado" }), { status: 404, headers: { "Content-Type": "application/json" } });
    return new Response(superjson.stringify(trace satisfies OutputType), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao montar a rastreabilidade:", error);
    return buildErrorResponse(error, "Não foi possível carregar a rastreabilidade");
  }
}
