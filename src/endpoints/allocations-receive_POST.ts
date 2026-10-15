import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { postAllocationReceipt } from "../helpers/receiptPosting.js";
import { checkOfferUnitAgainstItem } from "../helpers/unitVocabulary.js";
import { closeAsCorrectedIfNowCompatible, findActiveCase, openCase } from "../helpers/unitRegularization.js";
import { schema } from "./allocations-receive_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "logistica.gerencie");

    const result = await db.transaction().execute(async (trx) => {
      const allocation = await trx
        .selectFrom("opportunityAllocations")
        .select(["id", "status", "opportunityRegistryId", "quantityAllocated"])
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

      // Fase 99C: unidade da oferta × unidade canônica do item. Sem equivalência comprovada NADA é lançado (nem estoque, nem ledger, nem atendimento): o recebimento vira (ou
      // reaproveita) um caso de regularização, de forma atômica e idempotente (um só caso ativo por atribuição, garantido por índice único parcial). Ordem de travas:
      // atribuição → item → caso → oferta da rede → auditoria.
      const registry = await trx.selectFrom("opportunityRegistry").select(["id", "unit"]).where("id", "=", allocation.opportunityRegistryId).executeTakeFirst();
      let activeCase = await findActiveCase(trx, { allocationId: allocation.id });
      if (activeCase && (await closeAsCorrectedIfNowCompatible(trx, activeCase, registry?.unit ?? null, user.id))) activeCase = undefined;
      if (activeCase) {
        return { type: "pending_regularization" as const, caseId: activeCase.id, status: activeCase.status, created: false };
      }
      const unitCheck = checkOfferUnitAgainstItem(registry?.unit ?? null, item.unit);
      if (!unitCheck.compatible) {
        const created = await openCase(trx, {
          organizationId: input.organizationId,
          allocationId: allocation.id,
          itemId: item.id,
          offeredQuantity: Number(allocation.quantityAllocated),
          offeredUnit: registry?.unit ?? null,
          informedQuantity: input.quantityReceived,
          itemUnit: item.unit,
          receiptNotes: input.notes ?? null,
          divergenceKind: unitCheck.reason,
          userId: user.id,
        });
        return { type: "pending_regularization" as const, caseId: created.id, status: created.status, created: true };
      }

      const posted = await postAllocationReceipt(trx, {
        organizationId: input.organizationId,
        allocation,
        item,
        quantityReceived: input.quantityReceived,
        userId: user.id,
        notes: input.notes ?? null,
        proofUrl,
      });

      return {
        type: "success" as const,
        allocation: { id: input.allocationId, status: "recebida" },
        stockTransactionId: posted.stockTransactionId,
        newStock: posted.newStock,
      };
    });

    if (result.type === "not_found") {
      return new Response(superjson.stringify({ message: "Atribuição não encontrada" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "pending_regularization") {
      // 202: o recebimento FOI apresentado, mas nada foi lançado — há uma regularização de unidade pendente (a mesma resposta serve para o retry).
      return new Response(
        superjson.stringify({
          allocation: { id: input.allocationId, status: "pendente_de_regularizacao" },
          pendingRegularization: {
            caseId: result.caseId,
            status: result.status,
            created: result.created,
            message:
              "O recebimento não foi lançado no estoque: a unidade da oferta não tem equivalência comprovada com a unidade do item. Regularize o caso na fila de pendências de unidade.",
          },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } }
      );
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
