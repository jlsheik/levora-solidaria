import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { verifyAuditLogChain } from "../helpers/verifyAuditChain.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

// A cadeia de hash é global (não por organização, ver auditLog.tsx) —
// verificá-la é uma operação de plataforma, não de uma organização
// específica, por isso restrita ao admin de plataforma, igual aos outros
// endpoints que tocam entidades sem organization_id (sources,
// opportunity-registry).
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);

    const result = await verifyAuditLogChain();

    return new Response(superjson.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao verificar a cadeia de auditoria:", error);
    return buildErrorResponse(error, "Não foi possível verificar a trilha de auditoria");
  }
}
