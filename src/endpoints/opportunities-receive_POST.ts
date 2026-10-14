import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { getItemStockBalance } from "../helpers/stockBalance.js";
import { schema } from "./opportunities-receive_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "oportunidades.gerencie");

    const result = await db.transaction().execute(async (trx) => {
      // Fase 96: a linha da oferta é TRAVADA antes de ler o status. Antes, duas requisições simultâneas liam "registrada", cada uma lançava a entrada (a única trava
      // era a do item, e itens diferentes nem se serializavam) e a oferta de 10 unidades virava 20. Agora o status é lido e decidido sob a trava: a segunda
      // requisição espera a primeira confirmar e então vê "recebida" (409). Ordem de travas: oferta → item → auditoria (a mesma de opportunities-status_POST).
      const opportunity = await trx
        .selectFrom("donationOpportunities")
        .select(["id", "status", "title", "donorName"])
        .where("id", "=", input.opportunityId)
        .where("organizationId", "=", input.organizationId)
        .forUpdate()
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

      // "Reivindica" a oferta ANTES de lançar o estoque: atualização condicional (defesa em profundidade além da trava). Se, por qualquer motivo, a linha não estiver
      // mais num estado recebível, nada foi escrito ainda e a resposta é a mesma do contrato (409).
      const [updatedOpportunity] = await trx
        .updateTable("donationOpportunities")
        .set({ status: "recebida", updatedAt: new Date() })
        .where("id", "=", input.opportunityId)
        .where("organizationId", "=", input.organizationId)
        .where("status", "not in", ["recebida", "cancelada"])
        .returning(["id", "status"])
        .execute();
      if (!updatedOpportunity) return { type: "invalid_status" as const, status: "recebida" as const };

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

      const newStock = await getItemStockBalance(trx, input.itemId);

      return {
        type: "success" as const,
        opportunity: updatedOpportunity,
        stockTransactionId: String(tx.id),
        newStock,
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
    return buildErrorResponse(error, "Não foi possível registrar o recebimento");
  }
}
