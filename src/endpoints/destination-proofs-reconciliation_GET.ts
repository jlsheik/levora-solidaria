import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { listProofFileReconciliation } from "../helpers/destinationProofs.js";
import { schema } from "./destination-proofs-reconciliation_GET.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

/** Fase 99K — lista, SOMENTE LEITURA, os comprovantes pendentes (nunca vinculados) e os de referência removida. Proprietário/administrador (`organizacao.gerencie`). Não apaga nada. */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const input = schema.parse({ organizationId: new URL(request.url).searchParams.get("organizationId") });
    await requirePermission(user.id, input.organizationId, "organizacao.gerencie");
    const body = await listProofFileReconciliation(db, input.organizationId);
    return new Response(superjson.stringify(body), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro na reconciliação de comprovantes:", error);
    return buildErrorResponse(error, "Não foi possível listar os comprovantes");
  }
}
