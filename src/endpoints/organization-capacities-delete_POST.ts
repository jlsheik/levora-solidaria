import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { schema } from "./organization-capacities-delete_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "organizacao.gerencie");

    const result = await db.transaction().execute(async (trx) => {
      // Isolamento: o WHERE por organizationId garante que só se apague uma
      // linha da PRÓPRIA organização, mesmo que capacityId exista mas
      // pertença a outra (mesmo padrão de stock-transactions_POST.ts).
      const [deleted] = await trx
        .deleteFrom("organizationCapacities")
        .where("id", "=", input.capacityId)
        .where("organizationId", "=", input.organizationId)
        .returning(["id", "category", "unit"])
        .execute();

      if (!deleted) return { type: "not_found" as const };

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "organizacao.capacidade_removida",
          entityType: "organization_capacity",
          entityId: String(deleted.id),
          metadata: { category: deleted.category, unit: deleted.unit },
        },
        trx
      );

      return { type: "success" as const };
    });

    if (result.type === "not_found") {
      return new Response(superjson.stringify({ message: "Capacidade não encontrada nesta organização" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(superjson.stringify({ message: "Capacidade removida" }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao remover capacidade:", error);
    return buildErrorResponse(error, "Não foi possível remover a capacidade");
  }
}
