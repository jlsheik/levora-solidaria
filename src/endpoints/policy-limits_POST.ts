import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { setPolicyLimit } from "../helpers/policyLimits.js";
import { schema } from "./policy-limits_POST.schema.js";
import superjson from "superjson";

/**
 * M33 — a ORGANIZAÇÃO restringe um limite de autonomia (`automacao.gerencie`, organização ativa). Só pode tornar o limite MAIS restritivo que o global (regra e validação em `setPolicyLimit`,
 * que também audita `politica.limite_alterado`); o limite global continua exclusivo da plataforma e não tem endpoint aqui.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));
    await requirePermission(user.id, input.organizationId, "automacao.gerencie");
    const value = await db.transaction().execute((trx) => setPolicyLimit(trx, { organizationId: input.organizationId, key: input.key, value: input.value, userId: user.id }));
    return new Response(superjson.stringify({ key: input.key, value }), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao salvar limite de política:", error);
    return buildErrorResponse(error, "Não foi possível salvar o limite");
  }
}
