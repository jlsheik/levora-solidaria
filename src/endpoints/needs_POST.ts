import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { schema } from "./needs_POST.schema";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requireOrganizationMembership(user.id, input.organizationId, [
      "proprietario",
      "administrador",
      "operador",
    ]);

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
        })
        .returning(["id", "title", "status", "createdAt"])
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "necessidade.criada",
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
    const message = error instanceof Error ? error.message : "Não foi possível cadastrar a necessidade";
    const status = message.includes("acesso") || message.includes("papel") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
