import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePlatformAdmin } from "../helpers/platformAccess";
import { schema } from "./opportunity-registry_GET.schema";
import { sql } from "kysely";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);

    const url = new URL(request.url);
    const input = schema.parse({ status: url.searchParams.get("status") ?? undefined });

    let q = db
      .selectFrom("opportunityRegistry")
      .innerJoin("sources", "sources.id", "opportunityRegistry.sourceId")
      .leftJoin("opportunityAllocations", "opportunityAllocations.opportunityRegistryId", "opportunityRegistry.id")
      .select([
        "opportunityRegistry.id",
        "opportunityRegistry.sourceId",
        "sources.name as sourceName",
        "opportunityRegistry.title",
        "opportunityRegistry.description",
        "opportunityRegistry.category",
        "opportunityRegistry.quantity",
        "opportunityRegistry.unit",
        "opportunityRegistry.condition",
        "opportunityRegistry.locationCity",
        "opportunityRegistry.locationState",
        "opportunityRegistry.urgency",
        "opportunityRegistry.confidence",
        "opportunityRegistry.status",
        "opportunityRegistry.statusReason",
        "opportunityRegistry.createdAt",
        (eb) =>
          eb.fn
            .coalesce(
              eb.fn.sum(
                eb
                  .case()
                  .when("opportunityAllocations.status", "!=", "recusada")
                  .then(eb.ref("opportunityAllocations.quantityAllocated"))
                  .else(sql<string>`0`)
                  .end()
              ),
              sql<string>`0`
            )
            .as("allocatedQuantity"),
      ])
      .groupBy([
        "opportunityRegistry.id",
        "sources.name",
      ]);

    if (input.status) {
      q = q.where("opportunityRegistry.status", "=", input.status as never);
    }

    const rows = await q.orderBy("opportunityRegistry.createdAt", "desc").execute();

    return new Response(
      superjson.stringify({
        opportunities: rows.map((r) => ({
          id: r.id,
          sourceId: r.sourceId,
          sourceName: r.sourceName,
          title: r.title,
          description: r.description,
          category: r.category,
          quantity: r.quantity !== null ? Number(r.quantity) : null,
          unit: r.unit,
          condition: r.condition,
          locationCity: r.locationCity,
          locationState: r.locationState,
          urgency: r.urgency,
          confidence: r.confidence,
          status: r.status,
          statusReason: r.statusReason,
          allocatedQuantity: Number(r.allocatedQuantity ?? 0),
          createdAt: r.createdAt.toString(),
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar registro central:", error);
    return buildErrorResponse(error, "Falha ao carregar registro central");
  }
}
