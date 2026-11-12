import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { newCorrelationId } from "../helpers/correlation.js";
import { schema } from "./needs_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "necessidades.gerencie");

    if (input.itemId) {
      const item = await db
        .selectFrom("inventoryItems")
        .select(["id"])
        .where("id", "=", input.itemId)
        .where("organizationId", "=", input.organizationId)
        .executeTakeFirst();
      if (!item) {
        return new Response(
          superjson.stringify({ message: "Item de inventário informado não pertence a esta organização" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const correlationId = newCorrelationId();
    const need = await db.transaction().execute(async (trx) => {
      const [newNeed] = await trx
        .insertInto("needs")
        .values({
          organizationId: input.organizationId,
          title: input.title,
          description: input.description || null,
          itemId: input.itemId || null,
          quantityNeeded: input.quantityNeeded,
          unit: input.unit,
          priority: input.priority,
          createdByUserId: user.id,
          correlationId, // M40: origem da jornada da necessidade (gerada no servidor; o corpo da requisição nunca a define)
        })
        .returning(["id", "title", "status", "createdAt"])
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "necessidade.criada",
          outcome: "concluida", // mesma transação do cadastro: rollback leva o registro junto
          correlationId,
          entityType: "need",
          entityId: String(newNeed.id),
          metadata: { title: newNeed.title, priority: input.priority, quantityNeeded: input.quantityNeeded, unit: input.unit },
        },
        trx
      );

      return newNeed;
    });

    return new Response(
      superjson.stringify({
        need: { ...need, createdAt: need.createdAt.toString() },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao cadastrar necessidade:", error);
    return buildErrorResponse(error, "Não foi possível cadastrar a necessidade");
  }
}
