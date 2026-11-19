import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import type { JourneyAccess } from "../helpers/journey.js";
import { listJourneyPage } from "../helpers/journeyOffers.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { schema, type OutputType } from "./journeys_GET.schema.js";
import superjson from "superjson";

/**
 * M40/M41 — jornadas da organização: por necessidade e, desde a M41, também as ofertas SEM necessidade vinculada (oferta local e atribuição da rede). Leitura (`necessidades.leia`), sempre filtrada
 * pela organização do pedido. Busca, filtros e paginação são do SERVIDOR (nada é filtrado no navegador). As partes de rede, estoque, ofertas locais, prestação de contas e auditoria só vêm para quem
 * tem a permissão que o endpoint de origem já exige; sem ela a etapa aparece como "restrita ao seu papel" (nunca como zero) e os tipos de oferta correspondentes nem entram na lista.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const raw: Record<string, string | undefined> = {};
    for (const [k, v] of url.searchParams.entries()) raw[k] = v === "" ? undefined : v;
    const input = schema.parse(raw);
    const membership = await requirePermissionToRead(user.id, input.organizationId, "necessidades.leia");
    const access: JourneyAccess = {
      network: roleHasPermission(membership.role, "atribuicoes.leia"),
      stock: roleHasPermission(membership.role, "inventario.lance"),
      opportunities: roleHasPermission(membership.role, "oportunidades.leia"),
      report: roleHasPermission(membership.role, "relatorios.leia"),
      audit: roleHasPermission(membership.role, "auditoria.leia"),
    };
    const page = await listJourneyPage(input.organizationId, access, { q: input.q, tipo: input.tipo, vinculo: input.vinculo, status: input.status, limit: input.limit, cursor: input.cursor });
    const out: OutputType = { items: page.items as OutputType["items"], nextCursor: page.nextCursor, access };
    return new Response(superjson.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao listar as jornadas:", error);
    return buildErrorResponse(error, "Não foi possível carregar as jornadas");
  }
}
