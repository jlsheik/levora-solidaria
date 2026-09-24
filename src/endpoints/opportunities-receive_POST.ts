import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { schema } from "./opportunities-receive_POST.schema";
import { sql } from "kysely";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requireOrganizationMembership(user.id, input.organizationId, [
      "proprietario",
      "administrador",
      "operador",
    ]);

    const result = await db.transaction().execute(async (trx) => {
      const opportunity = await trx
        .selectFrom("donationOpportunities")
        .select(["id", "status", "title", "donorName"])
        .where("id", "=", input.opportunityId)
        .where("organizationId", "=", input.organizationId)
        .executeTakeFirst();

      if (!opportunity) return { type: "not_found" as const };

      if (opportunity.status === "recebida" || opportunity.status === "cancelada") {
        return { type: "invalid_status" as const, status: opportunity.status };
      }

      const item = await trx
        .selectFrom("inventoryItems")
        .select(["id", "name"])
        .where("id", "=", input.itemId)
        .where("organizationId", "=", input.organizationId)
        .forUpdate()
        .executeTakeFirst();

      if (!item) return { type: "item_not_found" as const };

      const [tx] = await trx
        .insertInto("stockTransactions")
        .values({
          organizationId: input.organizationId,
          itemId: input.itemId,
          type: "entrada",
          delta: input.quantityReceived,
          reason: `Recebimento da oportunidade "${opportunity.title}" — doador: ${opportunity.donorName}${input.notes ? ` — ${input.notes}` : ""}`,
          createdByUserId: user.id,
        })
        .returning(["id"])
        .execute();

      const [updatedOpportunity] = await trx
        .updateTable("donationOpportunities")
        .set({ status: "recebida", updatedAt: new Date() })
        .where("id", "=", input.opportunityId)
        .returning(["id", "status"])
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "oportunidade.recebida",
          entityType: "donation_opportunity",
          entityId: String(input.opportunityId),
          metadata: {
            title: opportunity.title,
            donorName: opportunity.donorName,
            itemId: input.itemId,
            itemName: item.name,
            quantityReceived: input.quantityReceived,
            stockTransactionId: String(tx.id),
          },
        },
        trx
      );

      const stockRow = await trx
        .selectFrom("stockTransactions")
        .select((eb) => eb.fn.coalesce(eb.fn.sum("delta"), sql<string>`0`).as("total"))
        .where("itemId", "=", input.itemId)
        .executeTakeFirst();

      return {
        type: "success" as const,
        opportunity: updatedOpportunity,
        stockTransactionId: String(tx.id),
        newStock: Number(stockRow?.total ?? 0),
      };
    });

    if (result.type === "not_found") {
      return new Response(
        superjson.stringify({ message: "Oportunidade não encontrada nesta organização" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }
    if (result.type === "item_not_found") {
      return new Response(
        superjson.stringify({ message: "Item de inventário não encontrado nesta organização" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }
    if (result.type === "invalid_status") {
      return new Response(
        superjson.stringify({
          message:
            result.status === "recebida"
              ? "Esta oportunidade já foi recebida"
              : "Esta oportunidade foi cancelada e não pode ser recebida",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      superjson.stringify({
        opportunity: result.opportunity,
        stockTransactionId: result.stockTransactionId,
        newStock: result.newStock,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao registrar recebimento:", error);
    const message = error instanceof Error ? error.message : "Não foi possível registrar o recebimento";
    const status = message.includes("acesso") || message.includes("papel") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
