import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { postLocalDonationReceipt } from "../helpers/receiptPosting.js";
import { checkOfferUnitAgainstItem } from "../helpers/unitVocabulary.js";
import { closeAsCorrectedIfNowCompatible, findActiveCase, openCase } from "../helpers/unitRegularization.js";
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
      // requisição espera a primeira confirmar e então vê "recebida" (409). Ordem de travas: oferta → item → caso → auditoria (a mesma de opportunities-status_POST).
      const opportunity = await trx
        .selectFrom("donationOpportunities")
        .select(["id", "status", "title", "donorName", "unit", "quantityOffered"])
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
        .select(["id", "name", "unit"])
        .where("id", "=", input.itemId)
        .where("organizationId", "=", input.organizationId)
        .forUpdate()
        .executeTakeFirst();

      if (!item) return { type: "item_not_found" as const };

      // Fase 99C: unidade da doação × unidade canônica do item. Sem equivalência comprovada NADA é lançado: o recebimento vira (ou reaproveita) um caso de regularização.
      let activeCase = await findActiveCase(trx, { donationOpportunityId: opportunity.id });
      if (activeCase && (await closeAsCorrectedIfNowCompatible(trx, activeCase, opportunity.unit, user.id))) activeCase = undefined;
      if (activeCase) return { type: "pending_regularization" as const, caseId: activeCase.id, status: activeCase.status, created: false };
      const unitCheck = checkOfferUnitAgainstItem(opportunity.unit, item.unit);
      if (!unitCheck.compatible) {
        const created = await openCase(trx, {
          organizationId: input.organizationId,
          donationOpportunityId: opportunity.id,
          itemId: item.id,
          offeredQuantity: opportunity.quantityOffered === null ? null : Number(opportunity.quantityOffered),
          offeredUnit: opportunity.unit,
          informedQuantity: input.quantityReceived,
          itemUnit: item.unit,
          receiptNotes: input.notes ?? null,
          divergenceKind: unitCheck.reason,
          userId: user.id,
        });
        return { type: "pending_regularization" as const, caseId: created.id, status: created.status, created: true };
      }

      const posted = await postLocalDonationReceipt(trx, {
        organizationId: input.organizationId,
        opportunity,
        item,
        quantityReceived: input.quantityReceived,
        userId: user.id,
        notes: input.notes ?? null,
      });
      // Defesa em profundidade além da trava: se a oferta não estava mais num estado recebível, nada foi escrito e a resposta é a do contrato (409).
      if (!posted.claimed) return { type: "invalid_status" as const, status: "recebida" as const };

      return {
        type: "success" as const,
        opportunity: posted.opportunity,
        stockTransactionId: posted.stockTransactionId,
        newStock: posted.newStock,
      };
    });

    if (result.type === "not_found") {
      return new Response(
        superjson.stringify({ message: "Oportunidade não encontrada nesta organização" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }
    if (result.type === "pending_regularization") {
      return new Response(
        superjson.stringify({
          pendingRegularization: {
            caseId: result.caseId,
            status: result.status,
            created: result.created,
            message:
              "O recebimento não foi lançado no estoque: a unidade da doação não tem equivalência comprovada com a unidade do item. Regularize o caso na fila de pendências de unidade.",
          },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } }
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
