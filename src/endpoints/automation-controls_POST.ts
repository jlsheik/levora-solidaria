import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { setAutomationControl } from "../helpers/automationControls.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { schema } from "./automation-controls_POST.schema.js";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "automacao.gerencie");

    const control = await db.transaction().execute((trx) =>
      setAutomationControl(trx, {
        organizationId: input.organizationId,
        paused: input.paused,
        emergency: input.emergency,
        reason: input.reason,
        userId: user.id,
      })
    );

    return new Response(superjson.stringify({ control }), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao alterar controles de automação:", error);
    return buildErrorResponse(error, "Não foi possível alterar a automação");
  }
}
