import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import { listDestinationHistory } from "../helpers/destinationCorrections.js";
import { schema, type OutputType } from "./stock-destinations_GET.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

/** Fase 99G — histórico das destinações da organização com correções, reversões e saldo reversível. Leitura: `inventario.lance` (proprietário, administrador, operador). Sempre filtrado por organização. */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
      itemId: url.searchParams.get("itemId") ?? undefined,
      needId: url.searchParams.get("needId") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      beforeId: url.searchParams.get("beforeId") ?? undefined,
    });
    const membership = await requirePermission(user.id, input.organizationId, "inventario.lance");
    const result = await listDestinationHistory(db, input.organizationId, { itemId: input.itemId, needId: input.needId, limit: input.limit, beforeId: input.beforeId });
    return new Response(superjson.stringify({ ...result, canReverse: roleHasPermission(membership.role, "organizacao.gerencie") } satisfies OutputType), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao listar destinações:", error);
    return buildErrorResponse(error, "Não foi possível carregar as destinações");
  }
}
