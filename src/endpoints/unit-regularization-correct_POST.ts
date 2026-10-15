import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { correctOfferUnit } from "../helpers/unitRegularization.js";
import { caseFailureResponse, okJson } from "../helpers/unitRegularizationHttp.js";
import { schema } from "./unit-regularization-correct_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

/**
 * Fase 99C — correção cadastral COMPROVADA da unidade da doação local que causou a divergência (proprietário/administrador). Registra valor anterior, valor novo e motivo; não
 * altera estoque, ledger nem movimentos; o recebimento segue pelo fluxo normal depois. A unidade nova precisa ser do vocabulário e ficar compatível com a do item.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));
    await requirePermission(user.id, input.organizationId, "organizacao.gerencie");
    const outcome = await correctOfferUnit({ organizationId: input.organizationId, caseId: input.caseId, userId: user.id, newUnit: input.newUnit, reason: input.reason, platform: false });
    if (outcome.type === "ok") return okJson({ status: outcome.status, previousUnit: outcome.previousUnit, newUnit: outcome.newUnit });
    return caseFailureResponse(outcome);
  } catch (error: unknown) {
    console.error("Erro ao corrigir a unidade da doação:", error);
    return buildErrorResponse(error, "Não foi possível corrigir a unidade");
  }
}
