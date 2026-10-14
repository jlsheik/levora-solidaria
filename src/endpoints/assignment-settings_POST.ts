import { sql } from "kysely";
import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { getResponseDeadlineHours } from "../helpers/assignmentSettings.js";
import { schema } from "./assignment-settings_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

// Altera o prazo GLOBAL das atribuições automáticas (admin da plataforma). Vale só para atribuições criadas depois: as já criadas guardam o próprio vencimento.
// Serializado por trava consultiva (a linha pode ainda não existir): o "valor anterior" da auditoria é sempre o realmente substituído.
const SETTINGS_LOCK_KEY = 842098;

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);
    const input = schema.parse(superjson.parse(await request.text()));

    const result = await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${SETTINGS_LOCK_KEY})`.execute(trx);
      const previous = await getResponseDeadlineHours(trx);
      const hasRow = await trx.selectFrom("platformAssignmentSettings").select("id").where("id", "=", 1).executeTakeFirst();
      if (previous === input.responseDeadlineHours && hasRow) {
        return { responseDeadlineHours: previous, previousHours: previous, changed: false };
      }
      await trx
        .insertInto("platformAssignmentSettings")
        .values({ id: 1, responseDeadlineHours: input.responseDeadlineHours, updatedByUserId: user.id })
        .onConflict((oc) => oc.column("id").doUpdateSet({ responseDeadlineHours: input.responseDeadlineHours, updatedByUserId: user.id, updatedAt: new Date() }))
        .execute();
      await recordAuditLogEntry(
        {
          organizationId: null,
          actorUserId: user.id,
          action: "configuracao.prazo_atribuicao_alterado",
          entityType: "platform_assignment_settings",
          entityId: "1",
          metadata: { valorAnteriorHoras: previous, valorNovoHoras: input.responseDeadlineHours },
        },
        trx
      );
      return { responseDeadlineHours: input.responseDeadlineHours, previousHours: previous, changed: true };
    });

    return new Response(superjson.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao salvar a configuração do prazo:", error);
    return buildErrorResponse(error, "Não foi possível salvar o prazo");
  }
}
