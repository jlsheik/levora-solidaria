import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePlatformAdmin } from "../helpers/platformAccess";
import { schema } from "./match-evaluations_GET.schema";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);

    const url = new URL(request.url);
    const input = schema.parse({ opportunityId: url.searchParams.get("opportunityId") });

    const rows = await db
      .selectFrom("matchEvaluations")
      .innerJoin("organizations", "organizations.id", "matchEvaluations.organizationId")
      .leftJoin("needs", "needs.id", "matchEvaluations.needId")
      .select([
        "matchEvaluations.id",
        "matchEvaluations.organizationId",
        "organizations.name as organizationName",
        "matchEvaluations.needId",
        "needs.title as needTitle",
        "matchEvaluations.criteria",
        "matchEvaluations.finalScore",
        "matchEvaluations.algorithmVersion",
        "matchEvaluations.aiModelUsed",
        "matchEvaluations.decision",
        "matchEvaluations.allocationId",
        "matchEvaluations.createdAt",
      ])
      .where("matchEvaluations.opportunityRegistryId", "=", input.opportunityId)
      .orderBy("matchEvaluations.createdAt", "desc")
      .orderBy("matchEvaluations.finalScore", "desc")
      .execute();

    return new Response(
      superjson.stringify({
        evaluations: rows.map((r) => ({
          ...r,
          id: String(r.id),
          finalScore: Number(r.finalScore),
          createdAt: r.createdAt.toString(),
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao carregar avaliações de matching:", error);
    const message = error instanceof Error ? error.message : "Falha ao carregar avaliações";
    const status = message.includes("restrita") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
