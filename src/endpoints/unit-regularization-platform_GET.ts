import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import type { OutputType } from "./unit-regularization-platform_GET.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

/**
 * Fase 99C — casos ATIVOS que dependem da oferta da rede (registro global, que só a plataforma corrige). Só admin da plataforma. Mostra o mínimo para decidir a correção
 * (organização, título da oferta, unidades, quantidade): sem itens de estoque, notas nem usuários. Não há ação transversal além da correção da própria oferta.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);
    const rows = await db
      .selectFrom("unitRegularizationCases as c")
      .innerJoin("organizations as o", "o.id", "c.organizationId")
      .innerJoin("opportunityAllocations as a", "a.id", "c.allocationId")
      .innerJoin("opportunityRegistry as r", "r.id", "a.opportunityRegistryId")
      .select(["c.id", "c.status", "o.name as organizationName", "r.title as resourceTitle", "c.offeredQuantity", "c.offeredUnit", "c.itemUnit", "c.divergenceKind", "c.createdAt"])
      .where("c.sourceType", "=", "allocation")
      .where("c.status", "in", ["aberto", "conferido"])
      .orderBy("c.createdAt", "asc")
      .limit(200)
      .execute();
    const output: OutputType = {
      cases: rows.map((r) => ({
        id: r.id,
        status: r.status as "aberto" | "conferido",
        organizationName: r.organizationName,
        resourceTitle: r.resourceTitle,
        offeredQuantity: r.offeredQuantity === null ? null : Number(r.offeredQuantity),
        offeredUnit: r.offeredUnit,
        itemUnit: r.itemUnit,
        divergenceKind: r.divergenceKind,
        openedAt: r.createdAt.toISOString(),
      })),
    };
    return new Response(superjson.stringify(output), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao listar as pendências de unidade das ofertas da rede:", error);
    return buildErrorResponse(error, "Falha ao carregar as pendências de unidade das ofertas da rede");
  }
}
