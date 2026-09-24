import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { schema } from "./allocations-receive_POST.schema";
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
      const allocation = await trx
        .selectFrom("opportunityAllocations")
        .select(["id", "status", "opportunityRegistryId"])
        .where("id", "=", input.allocationId)
        .where("organizationId", "=", input.organizationId)
        .forUpdate()
        .executeTakeFirst();

      if (!allocation) return { type: "not_found" as const };
      if (!["aceita", "em_coleta", "em_transporte"].includes(allocation.status)) {
        return { type: "invalid_status" as const, status: allocation.status };
      }

      const item = await trx
        .selectFrom("inventoryItems")
        .select(["id", "name"])
        .where("id", "=", input.itemId)
        .where("organizationId", "=", input.organizationId)
        .forUpdate()
        .executeTakeFirst();

      if (!item) return { type: "item_not_found" as const };

      const opportunity = await trx
        .selectFrom("opportunityRegistry")
        .select(["id", "title"])
        .where("id", "=", allocation.opportunityRegistryId)
        .executeTakeFirst();

      const [tx] = await trx
        .insertInto("stockTransactions")
        .values({
          organizationId: input.organizationId,
          itemId: input.itemId,
          type: "entrada",
          delta: input.quantityReceived,
          reason: `Recebimento da atribuição da rede Levora — oportunidade "${opportunity?.title ?? allocation.opportunityRegistryId}"${input.notes ? ` — ${input.notes}` : ""}`,
          createdByUserId: user.id,
        })
        .returning(["id"])
        .execute();

      await trx
        .updateTable("opportunityAllocations")
        .set({ status: "recebida", updatedAt: new Date() })
        .where("id", "=", input.allocationId)
        .execute();

      await trx
        .insertInto("logisticsEvents")
        .values({
          opportunityAllocationId: input.allocationId,
          organizationId: input.organizationId,
          eventType: "entrega_confirmada",
          notes: input.notes ?? null,
          proofUrl: input.proofUrl ?? null,
          actorUserId: user.id,
        })
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "atribuicao.recebida",
          entityType: "opportunity_allocation",
          entityId: String(input.allocationId),
          metadata: { itemId: input.itemId, itemName: item.name, quantityReceived: input.quantityReceived, stockTransactionId: String(tx.id) },
        },
        trx
      );

      // Se todas as atribuições desta descoberta central já estão em um
      // estado terminal e pelo menos uma foi de fato recebida, a
      // descoberta como um todo está concluída.
      const siblingAllocations = await trx
        .selectFrom("opportunityAllocations")
        .select(["status"])
        .where("opportunityRegistryId", "=", allocation.opportunityRegistryId)
        .execute();

      const terminal = ["recebida", "cancelada", "recusada"];
      const nowAllTerminal = siblingAllocations.every((a) => terminal.includes(a.status));
      const hasReceived = siblingAllocations.some((a) => a.status === "recebida");

      if (nowAllTerminal && hasReceived) {
        await trx
          .updateTable("opportunityRegistry")
          .set({ status: "concluida", updatedAt: new Date() })
          .where("id", "=", allocation.opportunityRegistryId)
          .execute();

        await recordAuditLogEntry(
          {
            organizationId: null,
            actorUserId: user.id,
            action: "descoberta_central.concluida",
            entityType: "opportunity_registry",
            entityId: String(allocation.opportunityRegistryId),
            metadata: {},
          },
          trx
        );
      }

      const stockRow = await trx
        .selectFrom("stockTransactions")
        .select((eb) => eb.fn.coalesce(eb.fn.sum("delta"), sql<string>`0`).as("total"))
        .where("itemId", "=", input.itemId)
        .executeTakeFirst();

      return {
        type: "success" as const,
        allocation: { id: input.allocationId, status: "recebida" },
        stockTransactionId: String(tx.id),
        newStock: Number(stockRow?.total ?? 0),
      };
    });

    if (result.type === "not_found") {
      return new Response(superjson.stringify({ message: "Atribuição não encontrada" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "item_not_found") {
      return new Response(superjson.stringify({ message: "Item de inventário não encontrado nesta organização" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "invalid_status") {
      return new Response(
        superjson.stringify({ message: `Esta atribuição precisa estar aceita, em coleta ou em transporte antes de ser recebida (status atual: ${result.status})` }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      superjson.stringify({ allocation: result.allocation, stockTransactionId: result.stockTransactionId, newStock: result.newStock }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao registrar recebimento da atribuição:", error);
    const message = error instanceof Error ? error.message : "Não foi possível registrar o recebimento";
    const status = message.includes("acesso") || message.includes("papel") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
