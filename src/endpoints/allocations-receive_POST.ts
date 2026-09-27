import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePermission } from "../helpers/organizationAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { getItemStockBalance } from "../helpers/stockBalance";
import { concludeOpportunityIfAllTerminalAndReceived } from "../helpers/concludeOpportunity";
import { createNeedFulfillment } from "../helpers/needFulfillment";
import { schema } from "./allocations-receive_POST.schema";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "logistica.gerencie");

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
        .select(["id", "name", "unit"])
        .where("id", "=", input.itemId)
        .where("organizationId", "=", input.organizationId)
        .forUpdate()
        .executeTakeFirst();

      if (!item) return { type: "item_not_found" as const };

      let proofUrl = input.proofUrl ?? null;
      if (input.proofFileId) {
        const proofFile = await trx
          .selectFrom("files")
          .select(["id", "organizationId"])
          .where("id", "=", input.proofFileId)
          .executeTakeFirst();
        if (!proofFile || proofFile.organizationId !== input.organizationId) {
          return { type: "proof_file_not_found" as const };
        }
        proofUrl = `/_api/v1/files-download?fileId=${proofFile.id}`;
      }

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

      // Ledger de atendimento (Fase 29) — registra o fato físico do
      // recebimento, resolvendo needId pela relação real com
      // match_evaluations quando a allocation veio do motor (ver
      // needFulfillment.tsx). organizationId vem sempre da própria
      // allocation já validada acima, nunca de um valor separado — não há
      // como uma organização criar um fulfillment associado a outra.
      await createNeedFulfillment(trx, {
        organizationId: input.organizationId,
        allocationId: input.allocationId,
        stockTransactionId: tx.id,
        quantity: input.quantityReceived,
        unit: item.unit,
        createdByUserId: user.id,
      });

      await trx
        .insertInto("logisticsEvents")
        .values({
          opportunityAllocationId: input.allocationId,
          organizationId: input.organizationId,
          eventType: "entrega_confirmada",
          notes: input.notes ?? null,
          proofUrl,
          actorUserId: user.id,
        })
        .execute();

      // Achado de auditoria corrigido: chamado ANTES de qualquer
      // recordAuditLogEntry desta transação (que trava o advisory lock
      // GLOBAL da cadeia de auditoria até o commit) — travar a linha da
      // oportunidade primeiro e o audit log por último é a mesma ordem
      // usada nos outros 3 caminhos que também podem concluir a
      // oportunidade, evitando o deadlock que a Fase 27 encontrou quando
      // essa ordem ficou invertida em algum caminho.
      const concluded = await concludeOpportunityIfAllTerminalAndReceived(trx, allocation.opportunityRegistryId);

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

      if (concluded) {
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

      const newStock = await getItemStockBalance(trx, input.itemId);

      return {
        type: "success" as const,
        allocation: { id: input.allocationId, status: "recebida" },
        stockTransactionId: String(tx.id),
        newStock,
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
    if (result.type === "proof_file_not_found") {
      return new Response(superjson.stringify({ message: "Arquivo de comprovante não encontrado nesta organização" }), {
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
    return buildErrorResponse(error, "Não foi possível registrar o recebimento");
  }
}
