import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { getExplicitRefusals } from "../helpers/allocationRefusals.js";
import { schema } from "./opportunity-allocation-refusals_GET.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

// Fase 98: consulta (sempre ao banco, nunca a um cache da tela) usada pelo diálogo de atribuição manual para avisar o admin da plataforma quando a organização escolhida
// já recusou ou cancelou, ela mesma, ESTA oportunidade (Fase 97). Só informa; a decisão continua do admin. Restrito ao admin da plataforma e ao par consultado.
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);
    const url = new URL(request.url);
    const input = schema.parse({ opportunityId: url.searchParams.get("opportunityId"), organizationId: url.searchParams.get("organizationId") });

    const refusals = await getExplicitRefusals(db, input.opportunityId, input.organizationId);
    const dates = refusals.length
      ? await db.selectFrom("opportunityAllocations").select(["id", "updatedAt"]).where("id", "in", refusals.map((r) => r.allocationId)).execute()
      : [];
    const at = new Map(dates.map((d) => [d.id, d.updatedAt]));
    return new Response(
      superjson.stringify({
        refusals: refusals.map((r) => ({ allocationId: r.allocationId, kind: r.status, occurredAt: (at.get(r.allocationId) ?? new Date(0)).toString() })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao consultar recusas anteriores:", error);
    return buildErrorResponse(error, "Não foi possível consultar o histórico de recusas");
  }
}
