import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { schema } from "./opportunities_POST.schema";
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

    if (input.linkedNeedId) {
      const need = await db
        .selectFrom("needs")
        .select(["id"])
        .where("id", "=", input.linkedNeedId)
        .where("organizationId", "=", input.organizationId)
        .executeTakeFirst();
      if (!need) {
        return new Response(
          superjson.stringify({ message: "Necessidade informada não pertence a esta organização" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const opportunity = await db.transaction().execute(async (trx) => {
      const [created] = await trx
        .insertInto("donationOpportunities")
        .values({
          organizationId: input.organizationId,
          title: input.title,
          description: input.description || null,
          category: input.category || null,
          quantityOffered: input.quantityOffered ?? null,
          unit: input.unit || null,
          donorName: input.donorName,
          donorContact: input.donorContact || null,
          linkedNeedId: input.linkedNeedId || null,
          createdByUserId: user.id,
        })
        .returning(["id", "title", "status", "createdAt"])
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "oportunidade.registrada",
          entityType: "donation_opportunity",
          entityId: String(created.id),
          metadata: {
            title: created.title,
            donorName: input.donorName,
            quantityOffered: input.quantityOffered ?? null,
            unit: input.unit ?? null,
            registroManual: true,
          },
        },
        trx
      );

      return created;
    });

    return new Response(
      superjson.stringify({
        opportunity: { ...opportunity, createdAt: opportunity.createdAt.toString() },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao registrar oportunidade:", error);
    const message = error instanceof Error ? error.message : "Não foi possível registrar a oportunidade";
    const status = message.includes("acesso") || message.includes("papel") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
