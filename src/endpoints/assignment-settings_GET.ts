import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { MAX_RESPONSE_DEADLINE_HOURS, MIN_RESPONSE_DEADLINE_HOURS, REASSIGNMENT_PAUSE_DAYS, getResponseDeadlineHours } from "../helpers/assignmentSettings.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

// Configuração global do prazo das atribuições automáticas — leitura restrita à equipe operadora da plataforma.
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);
    const row = await db.selectFrom("platformAssignmentSettings").select(["updatedAt", "updatedByUserId"]).where("id", "=", 1).executeTakeFirst();
    const hours = await getResponseDeadlineHours(db);
    return new Response(
      superjson.stringify({
        responseDeadlineHours: hours,
        isDefault: !row,
        updatedAt: row ? row.updatedAt.toString() : null,
        updatedByUserId: row?.updatedByUserId ?? null,
        reassignmentPauseDays: REASSIGNMENT_PAUSE_DAYS,
        minHours: MIN_RESPONSE_DEADLINE_HOURS,
        maxHours: MAX_RESPONSE_DEADLINE_HOURS,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao ler a configuração do prazo:", error);
    return buildErrorResponse(error, "Não foi possível carregar a configuração do prazo");
  }
}
