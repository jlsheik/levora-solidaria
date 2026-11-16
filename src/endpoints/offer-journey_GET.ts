import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import type { JourneyAccess } from "../helpers/journey.js";
import { getOfferJourneyDetail } from "../helpers/journeyOffers.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { schema, type OutputType } from "./offer-journey_GET.schema.js";
import superjson from "superjson";

/**
 * M41 — detalhe da jornada de uma oferta SEM necessidade vinculada (oferta local ou atribuição da rede). Somente leitura (`necessidades.leia` + a permissão do módulo de origem), filtrado pela
 * organização do pedido. Registro de outra organização, de outro tipo ou com necessidade já vinculada responde 404 (a existência não vaza). O contato do doador e a evidência/origem do Registro Central NÃO saem.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ organizationId: url.searchParams.get("organizationId"), kind: url.searchParams.get("kind"), id: url.searchParams.get("id") });
    const membership = await requirePermissionToRead(user.id, input.organizationId, "necessidades.leia");
    const access: JourneyAccess = {
      network: roleHasPermission(membership.role, "atribuicoes.leia"),
      stock: roleHasPermission(membership.role, "inventario.lance"),
      opportunities: roleHasPermission(membership.role, "oportunidades.leia"),
      report: roleHasPermission(membership.role, "relatorios.leia"),
      audit: roleHasPermission(membership.role, "auditoria.leia"),
    };
    const detail = await getOfferJourneyDetail(input.organizationId, input.kind, input.id, access);
    if (!detail) return new Response(superjson.stringify({ message: "Oferta não encontrada nesta organização (ou o seu papel não a consulta)" }), { status: 404, headers: { "Content-Type": "application/json" } });
    return new Response(superjson.stringify(detail as OutputType), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao carregar a jornada da oferta:", error);
    return buildErrorResponse(error, "Não foi possível carregar a oferta");
  }
}
