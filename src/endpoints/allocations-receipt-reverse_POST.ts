import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { ledgerErrorResponse, submitLedgerOperation } from "../helpers/needFulfillmentCorrections.js";
import { schema } from "./allocations-receipt-reverse_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "logistica.gerencie");

    // Todo estorno exige segunda pessoa (P-L6): a solicitação só grava um
    // pedido (transação curta); quem executa é a decisão de aprovação.
    const result = await db.transaction().execute((trx) =>
      submitLedgerOperation(trx, {
        organizationId: input.organizationId,
        allocationId: input.allocationId,
        expectedVigenteFulfillmentId: input.expectedVigenteFulfillmentId,
        operation: { kind: "estorno", withdrawStock: input.withdrawStock === true },
        reason: input.reason,
        actorUserId: user.id,
      })
    );

    if (result.type === "pending_approval") {
      return new Response(superjson.stringify({ status: "pendente_aprovacao", approvalRequestId: result.approvalRequestId }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "executed") {
      // Inalcançável: estorno sempre exige aprovação (plan.requiresApproval).
      throw new Error("estorno executado sem aprovação");
    }
    return ledgerErrorResponse(result);
  } catch (error: unknown) {
    console.error("Erro ao solicitar estorno do recebimento:", error);
    return buildErrorResponse(error, "Não foi possível solicitar o estorno");
  }
}
