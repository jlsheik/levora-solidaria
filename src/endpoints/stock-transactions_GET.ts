import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { schema } from "./stock-transactions_GET.schema";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
      itemId: url.searchParams.get("itemId") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });

    await requireOrganizationMembership(user.id, input.organizationId);

    let q = db
      .selectFrom("stockTransactions")
      .innerJoin("inventoryItems", "inventoryItems.id", "stockTransactions.itemId")
      .leftJoin("users", "users.id", "stockTransactions.createdByUserId")
      .select([
        "stockTransactions.id",
        "stockTransactions.itemId",
        "inventoryItems.name as itemName",
        "stockTransactions.type",
        "stockTransactions.delta",
        "stockTransactions.reason",
        "users.displayName as actorDisplayName",
        "stockTransactions.createdAt",
      ])
      .where("stockTransactions.organizationId", "=", input.organizationId);

    if (input.itemId) {
      q = q.where("stockTransactions.itemId", "=", input.itemId);
    }

    const rows = await q
      .orderBy("stockTransactions.createdAt", "desc")
      .limit(input.limit ?? 50)
      .execute();

    return new Response(
      superjson.stringify({
        transactions: rows.map((r) => ({
          id: String(r.id),
          itemId: r.itemId,
          itemName: r.itemName,
          type: r.type,
          delta: Number(r.delta),
          reason: r.reason,
          actorDisplayName: r.actorDisplayName,
          createdAt: r.createdAt.toString(),
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar histórico de estoque:", error);
    return buildErrorResponse(error, "Falha ao carregar histórico");
  }
}
