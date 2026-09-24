import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { schema } from "./needs_GET.schema";
import { sql } from "kysely";
import superjson from "superjson";

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

    return new Response(
      superjson.stringify({
        needs: rows.map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          itemId: r.itemId,
          itemName: r.itemName,
          quantityNeeded: Number(r.quantityNeeded),
          unit: r.unit,
          priority: r.priority,
          status: r.status,
          createdByDisplayName: r.createdByDisplayName,
          createdAt: r.createdAt.toString(),
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar necessidades:", error);
    const message = error instanceof Error ? error.message : "Falha ao carregar necessidades";
    const status = message.includes("acesso") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
