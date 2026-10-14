import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { schema } from "./organization-service-areas-delete_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "organizacao.gerencie");

    const result = await db.transaction().execute(async (trx) => {
      const [deleted] = await trx
        .deleteFrom("organizationServiceAreas")
        .where("id", "=", input.areaId)
        .where("organizationId", "=", input.organizationId)
        .returning(["id", "city", "state"])
        .execute();

      if (!deleted) return { type: "not_found" as const };

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "organizacao.area_atendimento_alterada",
          entityType: "organization_service_area",
          entityId: String(deleted.id),
          metadata: { acao: "removida", city: deleted.city, state: deleted.state },
        },
        trx
      );

      return { type: "success" as const };
    });

    if (result.type === "not_found") {
      return new Response(superjson.stringify({ message: "Área de atendimento não encontrada nesta organização" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(superjson.stringify({ message: "Área de atendimento removida" }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao remover área de atendimento:", error);
    return buildErrorResponse(error, "Não foi possível remover a área de atendimento");
  }
}
