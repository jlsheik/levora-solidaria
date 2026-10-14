import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { correctOfferUnit } from "../helpers/unitRegularization.js";
import { caseFailureResponse, okJson } from "../helpers/unitRegularizationHttp.js";
import { schema } from "./unit-regularization-correct-offer_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

/**
 * Fase 99C — admin da plataforma corrige a unidade da oferta da rede (registro global) que causou uma divergência. Só aplica se a unidade nova é do vocabulário, fica
 * compatível com a do item do caso e NENHUM recebimento já foi lançado com a unidade antiga (senão o histórico seria reinterpretado: 409, e o caso segue por conferência).
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);
    const input = schema.parse(superjson.parse(await request.text()));
    const outcome = await correctOfferUnit({ organizationId: null, caseId: input.caseId, userId: user.id, newUnit: input.newUnit, reason: input.reason, platform: true });
    if (outcome.type === "ok") return okJson({ status: outcome.status, previousUnit: outcome.previousUnit, newUnit: outcome.newUnit });
    return caseFailureResponse(outcome);
  } catch (error: unknown) {
    console.error("Erro ao corrigir a unidade da oferta da rede:", error);
    return buildErrorResponse(error, "Não foi possível corrigir a unidade da oferta");
  }
}
