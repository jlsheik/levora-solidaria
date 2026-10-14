import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { validateCase } from "../helpers/unitRegularization.js";
import { caseFailureResponse, okJson } from "../helpers/unitRegularizationHttp.js";
import { schema } from "./unit-regularization-validate_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

/**
 * Fase 99C — validação da conferência física (proprietário/administrador, `organizacao.gerencie`). Aprovar LANÇA o recebimento uma única vez (estoque na unidade do item e,
 * na rede, o ledger), sob as travas atribuição|doação → item → caso. Quem conferiu não valida a própria conferência, salvo se for o único proprietário/administrador ativo.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));
    await requirePermission(user.id, input.organizationId, "organizacao.gerencie");
    const outcome = await validateCase({ organizationId: input.organizationId, caseId: input.caseId, userId: user.id, decision: input.decision, note: input.note });
    if (outcome.type === "ok") return okJson({ status: outcome.status, stockTransactionId: outcome.stockTransactionId });
    return caseFailureResponse(outcome);
  } catch (error: unknown) {
    console.error("Erro ao validar a conferência de unidade:", error);
    return buildErrorResponse(error, "Não foi possível validar a conferência");
  }
}
