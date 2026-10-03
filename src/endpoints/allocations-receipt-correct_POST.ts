import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { ledgerErrorResponse, submitLedgerOperation } from "../helpers/needFulfillmentCorrections.js";
import { schema } from "./allocations-receipt-correct_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "logistica.gerencie");

    const result = await db.transaction().execute((trx) =>
      submitLedgerOperation(trx, {
        organizationId: input.organizationId,
        allocationId: input.allocationId,
        expectedVigenteFulfillmentId: input.expectedVigenteFulfillmentId,
        operation: { kind: "correcao", quantity: input.quantity, unit: input.unit },
        reason: input.reason,
        actorUserId: user.id,
      })
    );

    if (result.type === "executed") {
      return new Response(
        superjson.stringify({
          status: "executada",
          reversalFulfillmentId: result.result.reversalFulfillmentId,
          fulfillmentId: result.result.fulfillmentId,
          progress: result.result.progressAfter,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    if (result.type === "pending_approval") {
      return new Response(superjson.stringify({ status: "pendente_aprovacao", approvalRequestId: result.approvalRequestId }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }
    return ledgerErrorResponse(result);
  } catch (error: unknown) {
    console.error("Erro ao corrigir recebimento:", error);
    return buildErrorResponse(error, "Não foi possível corrigir o recebimento");
  }
}
