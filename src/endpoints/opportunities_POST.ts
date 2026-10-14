import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { schema } from "./opportunities_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "oportunidades.gerencie");

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
    return buildErrorResponse(error, "Não foi possível registrar a oportunidade");
  }
}
