import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePermission } from "../helpers/organizationAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { schema } from "./organization-service-areas_POST.schema";
import { sql } from "kysely";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "organizacao.gerencie");

    const result = await db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("organizationServiceAreas")
        .select(["id"])
        .where("organizationId", "=", input.organizationId)
        .where(sql`LOWER(city)`, "=", input.city.toLowerCase())
        .where("state", "=", input.state)
        .executeTakeFirst();
      if (existing) return { type: "already_exists" as const };

      const [area] = await trx
        .insertInto("organizationServiceAreas")
        .values({ organizationId: input.organizationId, city: input.city, state: input.state })
        .returning(["id", "city", "state"])
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "organizacao.area_atendimento_alterada",
          entityType: "organization_service_area",
          entityId: String(area.id),
          metadata: { acao: "adicionada", city: input.city, state: input.state },
        },
        trx
      );

      return { type: "success" as const, area };
    });

    if (result.type === "already_exists") {
      return new Response(superjson.stringify({ message: "Esta cidade já está na lista de áreas atendidas" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(superjson.stringify({ serviceArea: result.area }), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao adicionar área de atendimento:", error);
    return buildErrorResponse(error, "Não foi possível adicionar a área de atendimento");
  }
}
