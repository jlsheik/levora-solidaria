import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requireOrganizationMembership } from "../helpers/organizationAccess.js";
import { getNeedFulfillmentBalanceBatch, computeNeedProgress } from "../helpers/needFulfillment.js";
import { schema } from "./needs_GET.schema.js";
import { sql } from "kysely";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
    });

    await requireOrganizationMembership(user.id, input.organizationId);

    const rows = await db
      .selectFrom("needs")
      .innerJoin("users", "users.id", "needs.createdByUserId")
      .leftJoin("inventoryItems", "inventoryItems.id", "needs.itemId")
      .select([
        "needs.id",
        "needs.title",
        "needs.description",
        "needs.itemId",
        "inventoryItems.name as itemName",
        "needs.quantityNeeded",
        "needs.unit",
        "needs.priority",
        "needs.status",
        "users.displayName as createdByDisplayName",
        "needs.createdAt",
      ])
      .where("needs.organizationId", "=", input.organizationId)
      .orderBy(
        sql`case "needs"."priority" when 'critica' then 0 when 'alta' then 1 when 'media' then 2 else 3 end`
      )
      .orderBy("needs.createdAt", "desc")
      .execute();

    // Progresso derivado do Modelo B (Fase 42) — uma única query em lote
    // (GROUP BY need_id) para todas as needs desta listagem, nunca um SUM
    // por linha (evita N+1). `needs.status` nunca é lido nem alterado aqui;
    // o progresso é puramente informativo, calculado à parte.
    const balances = await getNeedFulfillmentBalanceBatch(db, rows.map((r) => r.id));

    return new Response(
      superjson.stringify({
        needs: rows.map((r) => {
          const quantityNeeded = Number(r.quantityNeeded);
          const progress = computeNeedProgress(quantityNeeded, balances.get(r.id) ?? 0);
          return {
            id: r.id,
            title: r.title,
            description: r.description,
            itemId: r.itemId,
            itemName: r.itemName,
            quantityNeeded,
            unit: r.unit,
            priority: r.priority,
            status: r.status,
            createdByDisplayName: r.createdByDisplayName,
            createdAt: r.createdAt.toString(),
            fulfilled: progress.fulfilled,
            requiredRemaining: progress.requiredRemaining,
            surplus: progress.surplus,
          };
        }),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar necessidades:", error);
    return buildErrorResponse(error, "Falha ao carregar necessidades");
  }
}
