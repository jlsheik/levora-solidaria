import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePlatformAdmin } from "../helpers/platformAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { schema } from "./platform-organizations-status_POST.schema";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);

    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    const organization = await db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("organizations")
        .select(["id", "status", "name"])
        .where("id", "=", input.organizationId)
        .forUpdate()
        .executeTakeFirst();

      if (!existing) return null;

      const [updated] = await trx
        .updateTable("organizations")
        .set({ status: input.status, updatedAt: new Date() })
        .where("id", "=", input.organizationId)
        .returning(["id", "status"])
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "organizacao.status_alterado_pela_plataforma",
          entityType: "organization",
          entityId: String(input.organizationId),
          metadata: { name: existing.name, statusAnterior: existing.status, statusNovo: input.status },
        },
        trx
      );

      return updated;
    });

    if (!organization) {
      return new Response(superjson.stringify({ message: "Organização não encontrada" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(superjson.stringify({ organization }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao atualizar status da organização:", error);
    return buildErrorResponse(error, "Não foi possível atualizar a organização");
  }
}

