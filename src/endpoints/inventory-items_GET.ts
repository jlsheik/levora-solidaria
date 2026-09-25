import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { schema } from "./inventory-items_GET.schema";
import { sql } from "kysely";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
    });

    await requireOrganizationMembership(user.id, input.organizationId);

    // Estoque atual é sempre derivado da soma do ledger — nunca um campo
    // solto que alguém poderia "atualizar" sem deixar rastro.
    const rows = await db
      .selectFrom("inventoryItems")
      .leftJoin("stockTransactions", "stockTransactions.itemId", "inventoryItems.id")
      .select([
        "inventoryItems.id",
        "inventoryItems.name",
        "inventoryItems.unit",
        "inventoryItems.category",
        "inventoryItems.createdAt",
        (eb) => eb.fn.coalesce(eb.fn.sum("stockTransactions.delta"), sql<string>`0`).as("currentStock"),
      ])
      .where("inventoryItems.organizationId", "=", input.organizationId)
      .groupBy([
        "inventoryItems.id",
        "inventoryItems.name",
        "inventoryItems.unit",
        "inventoryItems.category",
        "inventoryItems.createdAt",
      ])
      .orderBy("inventoryItems.name", "asc")
      .execute();

    return new Response(
      superjson.stringify({
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          unit: r.unit,
          category: r.category,
          currentStock: Number(r.currentStock),
          createdAt: r.createdAt.toString(),
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar inventário:", error);
    return buildErrorResponse(error, "Falha ao carregar inventário");
  }
}
