import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission, OrganizationAccessError } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import { conferCase } from "../helpers/unitRegularization.js";
import { caseFailureResponse, okJson } from "../helpers/unitRegularizationHttp.js";
import { schema } from "./unit-regularization-confer_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

/**
 * Fase 99C — conferência física: quem recebeu o recurso conta/mede a quantidade NA UNIDADE DO ITEM. Não converte nada. Exige `logistica.gerencie`; só quem também tem
 * `organizacao.gerencie` pode pedir a validação no mesmo ato, e isso só vale quando é o único proprietário/administrador ativo (decidido sob trava no banco).
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));
    const membership = await requirePermission(user.id, input.organizationId, "logistica.gerencie");
    const canValidate = roleHasPermission(membership.role, "organizacao.gerencie");
    const outcome = await conferCase({ organizationId: input.organizationId, caseId: input.caseId, userId: user.id, checkedQuantity: input.checkedQuantity, reason: input.reason, validateNow: input.validateNow === true, canValidate });
    if (outcome.type === "ok") return okJson({ status: outcome.status, stockTransactionId: outcome.stockTransactionId });
    if (outcome.type === "needs_second_validation") return okJson({ status: "conferido", stockTransactionId: null });
    return caseFailureResponse(outcome);
  } catch (error: unknown) {
    if (error instanceof OrganizationAccessError) console.error("Acesso negado na conferência de unidade:", error.message);
    else console.error("Erro ao registrar a conferência de unidade:", error);
    return buildErrorResponse(error, "Não foi possível registrar a conferência");
  }
}
