import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { setAutomationControl } from "../helpers/automationControls.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { schema } from "./platform-automation-controls_POST.schema.js";
import superjson from "superjson";

// Pausa/emergência GLOBAL: vale para todas as organizações. Só a equipe
// operadora da plataforma pode ligar ou desligar.
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);

    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    const control = await db.transaction().execute((trx) =>
      setAutomationControl(trx, {
        organizationId: null,
        paused: input.paused,
        emergency: input.emergency,
        reason: input.reason,
        userId: user.id,
      })
    );

    return new Response(superjson.stringify({ control }), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao alterar automação da plataforma:", error);
    return buildErrorResponse(error, "Não foi possível alterar a automação da plataforma");
  }
}
