import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { schema } from "./organization-matching-settings_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "organizacao.gerencie");

    const settings = await db.transaction().execute(async (trx) => {
      const [row] = await trx
        .insertInto("organizationMatchingSettings")
        .values({
          organizationId: input.organizationId,
          realizaColeta: input.realizaColeta,
          raioColetaKm: input.raioColetaKm ?? null,
          observacoesLogisticas: input.observacoesLogisticas ?? null,
          observacoesHorarios: input.observacoesHorarios ?? null,
        })
        .onConflict((oc) =>
          oc.column("organizationId").doUpdateSet({
            realizaColeta: input.realizaColeta,
            raioColetaKm: input.raioColetaKm ?? null,
            observacoesLogisticas: input.observacoesLogisticas ?? null,
            observacoesHorarios: input.observacoesHorarios ?? null,
            updatedAt: new Date(),
          })
        )
        .returning(["realizaColeta", "raioColetaKm", "observacoesLogisticas", "observacoesHorarios"])
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "organizacao.configuracao_logistica_alterada",
          entityType: "organization_matching_settings",
          entityId: String(input.organizationId),
          metadata: { realizaColeta: input.realizaColeta, raioColetaKm: input.raioColetaKm ?? null },
        },
        trx
      );

      return row;
    });

    return new Response(superjson.stringify({ settings }), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao salvar configuração de logística:", error);
    return buildErrorResponse(error, "Não foi possível salvar a configuração de logística");
  }
}
