import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import { getJourneyDetail } from "../helpers/journeyDetail.js";
import type { JourneyAccess } from "../helpers/journey.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { schema, type OutputType } from "./journey_GET.schema.js";
import superjson from "superjson";

/**
 * M40 — detalhe da jornada de UMA necessidade (linha do tempo com fatos persistidos, pendências, correspondências explicadas, atribuições, recebimentos e destinações). Leitura
 * (`necessidades.leia`) filtrada pela organização do pedido; necessidade de OUTRA organização responde 404 (a existência não vaza). Cada seção só vem para quem já a poderia ler pelo endpoint de origem.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ organizationId: url.searchParams.get("organizationId"), needId: url.searchParams.get("needId") });
    const membership = await requirePermissionToRead(user.id, input.organizationId, "necessidades.leia");
    const access: JourneyAccess = {
      network: roleHasPermission(membership.role, "atribuicoes.leia"),
      stock: roleHasPermission(membership.role, "inventario.lance"),
      opportunities: roleHasPermission(membership.role, "oportunidades.leia"),
      report: roleHasPermission(membership.role, "relatorios.leia"),
      audit: roleHasPermission(membership.role, "auditoria.leia"),
    };
    const detail = await getJourneyDetail(input.organizationId, input.needId, access, { userId: user.id, canManage: roleHasPermission(membership.role, "organizacao.gerencie") });
    if (!detail) return new Response(superjson.stringify({ message: "Necessidade não encontrada nesta organização" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const out: OutputType = {
      ...detail,
      destinations: detail.destinations === null ? null : detail.destinations.map((d) => ({ id: d.id, itemName: d.itemName, destinationType: d.destinationType, quantity: d.quantity, unit: d.unit, isCountable: d.isCountable, state: d.state, reversedQuantity: d.reversedQuantity, proof: d.proof ? { name: d.proof.name } : null, createdByDisplayName: d.createdByDisplayName, createdAt: d.createdAt })),
    };
    return new Response(superjson.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao carregar a jornada:", error);
    return buildErrorResponse(error, "Não foi possível carregar a jornada");
  }
}
