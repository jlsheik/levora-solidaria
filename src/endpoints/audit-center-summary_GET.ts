import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { summarize } from "../helpers/auditCenter.js";
import { schema, type OutputType } from "./audit-center-summary_GET.schema.js";
import superjson from "superjson";

/** M38 — indicadores calculados no banco para o período escolhido (contagens exatas até 10.000). Os dados dos agentes só vêm para quem tem `automacao.leia`; sem a permissão o campo é null, nunca zero. */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ organizationId: url.searchParams.get("organizationId"), from: url.searchParams.get("from") || undefined, to: url.searchParams.get("to") || undefined });
    const membership = await requirePermissionToRead(user.id, input.organizationId, "auditoria.leia");
    if (input.from && input.to && input.from >= input.to) {
      return new Response(superjson.stringify({ message: "O início do período deve ser anterior ao fim." }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const out: OutputType = await summarize(input.organizationId, input.from ?? null, input.to ?? null, roleHasPermission(membership.role, "automacao.leia"));
    return new Response(superjson.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao resumir a auditoria:", error);
    return buildErrorResponse(error, "Não foi possível carregar o resumo da auditoria");
  }
}
