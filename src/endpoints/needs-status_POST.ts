import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { schema } from "./needs-status_POST.schema";
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

    const need = await db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("needs")
        .select(["id", "status", "title"])
        .where("id", "=", input.needId)
        .where("organizationId", "=", input.organizationId)
        .executeTakeFirst();

      if (!existing) return null;

      const [updated] = await trx
        .updateTable("needs")
        .set({ status: input.status, updatedAt: new Date() })
        .where("id", "=", input.needId)
        .returning(["id", "status"])
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "necessidade.status_alterado",
          entityType: "need",
          entityId: String(input.needId),
          metadata: { title: existing.title, statusAnterior: existing.status, statusNovo: input.status },
        },
        trx
      );

      return updated;
    });

    if (!need) {
      return new Response(
        superjson.stringify({ message: "Necessidade não encontrada nesta organização" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(superjson.stringify({ need }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao atualizar necessidade:", error);
    const message = error instanceof Error ? error.message : "Não foi possível atualizar a necessidade";
    const status = message.includes("acesso") || message.includes("papel") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
