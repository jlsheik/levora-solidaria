import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { getAuditEntry } from "../helpers/auditCenter.js";
import { schema, type OutputType } from "./audit-center-entry_GET.schema.js";
import superjson from "superjson";

/** M38 — detalhe de um registro de auditoria. 404 também quando o id existe em OUTRA organização (a existência não vaza). Os valores de hash são internos e nunca saem. */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ organizationId: url.searchParams.get("organizationId"), id: url.searchParams.get("id") });
    await requirePermissionToRead(user.id, input.organizationId, "auditoria.leia");
    const entry = await getAuditEntry(input.organizationId, input.id);
    if (!entry) return new Response(superjson.stringify({ message: "Registro não encontrado nesta organização" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const out: OutputType = { entry };
    return new Response(superjson.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao carregar o registro de auditoria:", error);
    return buildErrorResponse(error, "Não foi possível carregar o registro");
  }
}
