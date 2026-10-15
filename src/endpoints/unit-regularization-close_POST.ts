import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { closeCase } from "../helpers/unitRegularization.js";
import { caseFailureResponse, okJson } from "../helpers/unitRegularizationHttp.js";
import { schema } from "./unit-regularization-close_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

/** Fase 99C — encerra um caso SEM resolução (nada é lançado), com categoria e motivo. Exige `organizacao.gerencie`. O recurso continua sem ser recebido. */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));
    await requirePermission(user.id, input.organizationId, "organizacao.gerencie");
    const outcome = await closeCase({ organizationId: input.organizationId, caseId: input.caseId, userId: user.id, category: input.category, reason: input.reason });
    if (outcome.type === "ok") return okJson({ status: outcome.status });
    return caseFailureResponse(outcome);
  } catch (error: unknown) {
    console.error("Erro ao encerrar o caso de regularização:", error);
    return buildErrorResponse(error, "Não foi possível encerrar o caso");
  }
}
