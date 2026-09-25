import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePermission } from "../helpers/organizationAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { schema } from "./inventory-items_POST.schema";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    // Cadastrar itens é operação de baixo risco, mas ainda exige
    // inventario.lance — voluntário só enxerga, não cadastra.
    await requirePermission(user.id, input.organizationId, "inventario.lance");

    const item = await db.transaction().execute(async (trx) => {
      const [newItem] = await trx
        .insertInto("inventoryItems")
        .values({
          organizationId: input.organizationId,
          name: input.name,
          unit: input.unit,
          category: input.category || null,
          createdByUserId: user.id,
        })
        .returning(["id", "name", "unit", "category", "createdAt"])
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "inventario.item_criado",
          entityType: "inventory_item",
          entityId: String(newItem.id),
          metadata: { name: newItem.name, unit: newItem.unit },
        },
        trx
      );

      let currentStock = 0;
      if (input.initialQuantity && input.initialQuantity > 0) {
        await trx
          .insertInto("stockTransactions")
          .values({
            organizationId: input.organizationId,
            itemId: newItem.id,
            type: "entrada",
            delta: input.initialQuantity,
            reason: "Quantidade inicial no cadastro do item",
            createdByUserId: user.id,
          })
          .execute();

        await recordAuditLogEntry(
          {
            organizationId: input.organizationId,
            actorUserId: user.id,
            action: "inventario.entrada_registrada",
            entityType: "inventory_item",
            entityId: String(newItem.id),
            metadata: { delta: input.initialQuantity, reason: "quantidade_inicial" },
          },
          trx
        );

        currentStock = input.initialQuantity;
      }

      return { ...newItem, currentStock };
    });

    return new Response(
      superjson.stringify({
        item: {
          id: item.id,
          name: item.name,
          unit: item.unit,
          category: item.category,
          currentStock: item.currentStock,
          createdAt: item.createdAt.toString(),
        },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao cadastrar item de inventário:", error);
    return buildErrorResponse(error, "Não foi possível cadastrar o item");
  }
}
