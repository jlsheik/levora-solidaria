import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { countFiltered, countNewer, listAuditEntries, type AuditFilters } from "../helpers/auditCenter.js";
import { schema, type OutputType } from "./audit-center_GET.schema.js";
import superjson from "superjson";

/**
 * M38 — lista paginada (cursor) da trilha de auditoria de UMA organização. Exige `auditoria.leia` NESSA organização (o servidor relê o vínculo; o id da URL não amplia o acesso).
 * Todos os filtros são aplicados no banco; nada é filtrado no navegador. Somente leitura.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const raw: Record<string, string | undefined> = {};
    for (const [k, v] of url.searchParams.entries()) raw[k] = v === "" ? undefined : v;
    const input = schema.parse(raw);
    await requirePermissionToRead(user.id, input.organizationId, "auditoria.leia");
    if (input.from && input.to && input.from >= input.to) {
      return new Response(superjson.stringify({ message: "O início do período deve ser anterior ao fim." }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const filters: AuditFilters = {
      from: input.from, to: input.to, area: input.area, action: input.action, entityType: input.entityType, entityId: input.entityId,
      actorUserId: input.actorUserId, actorType: input.actorType, outcome: input.resultado, correlationId: input.correlationId,
    };
    const page = await listAuditEntries(input.organizationId, filters, { limit: input.limit, beforeId: input.beforeId });
    const total = await countFiltered(input.organizationId, filters);
    const newerCount = input.sinceId ? await countNewer(input.organizationId, filters, input.sinceId) : null;
    const out: OutputType = { entries: page.entries, nextCursor: page.nextCursor, total, newerCount };
    return new Response(superjson.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao carregar a Central de Auditoria:", error);
    return buildErrorResponse(error, "Não foi possível carregar a trilha de auditoria");
  }
}
