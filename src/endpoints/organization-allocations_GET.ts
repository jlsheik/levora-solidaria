import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { schema } from "./organization-allocations_GET.schema";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ organizationId: url.searchParams.get("organizationId") });

    await requireOrganizationMembership(user.id, input.organizationId);

    const rows = await db
      .selectFrom("opportunityAllocations")
      .innerJoin("opportunityRegistry", "opportunityRegistry.id", "opportunityAllocations.opportunityRegistryId")
      .innerJoin("sources", "sources.id", "opportunityRegistry.sourceId")
      .select([
        "opportunityAllocations.id",
        "opportunityAllocations.status",
        "opportunityAllocations.quantityAllocated",
        "opportunityAllocations.notes",
        "opportunityAllocations.createdAt",
        "opportunityRegistry.id as opportunityId",
        "opportunityRegistry.title as opportunityTitle",
        "opportunityRegistry.description as opportunityDescription",
        "opportunityRegistry.category as opportunityCategory",
        "opportunityRegistry.unit as opportunityUnit",
        "opportunityRegistry.urgency as opportunityUrgency",
        "opportunityRegistry.locationCity as opportunityLocationCity",
        "opportunityRegistry.locationState as opportunityLocationState",
        "sources.name as sourceName",
      ])
      .where("opportunityAllocations.organizationId", "=", input.organizationId)
      .orderBy("opportunityAllocations.createdAt", "desc")
      .execute();

    return new Response(
      superjson.stringify({
        allocations: rows.map((r) => ({
          ...r,
          quantityAllocated: Number(r.quantityAllocated),
          createdAt: r.createdAt.toString(),
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar atribuições da organização:", error);
    const message = error instanceof Error ? error.message : "Falha ao carregar atribuições";
    const status = message.includes("acesso") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
