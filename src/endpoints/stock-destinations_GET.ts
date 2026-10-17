import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import { destinationTotals, listDestinationHistory } from "../helpers/destinationCorrections.js";
import { schema, type OutputType } from "./stock-destinations_GET.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

/**
 * Fase 99I — histórico das destinações da organização com correções, reversões, saldo reversível e FILTROS (período por data de registro ou efetiva, finalidade, situação, item, necessidade).
 * Leitura: `inventario.lance`. Sempre filtrado por organização; os totais cobrem todo o conjunto filtrado (por unidade) e usam a mesma fórmula do relatório da 99H.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const g = (k: string) => url.searchParams.get(k);
    const input = schema.parse({ organizationId: g("organizationId"), itemId: g("itemId"), needId: g("needId"), destinationType: g("destinationType"), state: g("state"), basis: g("basis"), from: g("from"), to: g("to"), limit: g("limit"), beforeId: g("beforeId") });
    const membership = await requirePermission(user.id, input.organizationId, "inventario.lance");
    const filter = { itemId: input.itemId, needId: input.needId, destinationType: input.destinationType, state: input.state, basis: input.basis, from: input.from, to: input.to };
    const [page, totals] = await Promise.all([listDestinationHistory(db, input.organizationId, { ...filter, limit: input.limit, beforeId: input.beforeId }), destinationTotals(db, { ...filter, organizationId: input.organizationId })]);
    const body: OutputType = { ...page, canReverse: roleHasPermission(membership.role, "organizacao.gerencie"), totals, filters: { basis: input.basis, from: input.from ?? null, to: input.to ?? null } };
    return new Response(superjson.stringify(body), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao listar destinações:", error);
    return buildErrorResponse(error, "Não foi possível carregar as destinações");
  }
}
