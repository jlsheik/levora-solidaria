import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { getAutomationState } from "../helpers/automationControls.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { schema } from "./automation-controls_GET.schema.js";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ organizationId: url.searchParams.get("organizationId") });

    await requirePermissionToRead(user.id, input.organizationId, "automacao.leia");

    const state = await getAutomationState(db, input.organizationId);
    return new Response(superjson.stringify(state), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao ler controles de automação:", error);
    return buildErrorResponse(error, "Não foi possível carregar o estado da automação");
  }
}
