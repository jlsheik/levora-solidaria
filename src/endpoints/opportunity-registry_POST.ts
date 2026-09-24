import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePlatformAdmin } from "../helpers/platformAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { schema } from "./opportunity-registry_POST.schema";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);

    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    const source = await db
      .selectFrom("sources")
      .select(["id", "status", "connectorKey"])
      .where("id", "=", input.sourceId)
      .executeTakeFirst();

    if (!source) {
      return new Response(superjson.stringify({ message: "Fonte não encontrada" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Regra imposta pelo servidor: só uma fonte com conector configurado e
    // ativo pode gerar uma descoberta. Isso é o que impede alguém de criar
    // uma oportunidade "via Facebook" antes de esse conector existir de
    // verdade.
    if (source.status !== "ativa") {
      return new Response(
        superjson.stringify({
          message: `Conector não configurado para esta fonte (status atual: ${source.status}). Configure e ative a fonte antes de registrar descobertas por ela.`,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    const opportunity = await db.transaction().execute(async (trx) => {
      const [created] = await trx
        .insertInto("opportunityRegistry")
        .values({
          sourceId: input.sourceId,
          discoveredByUserId: user.id,
          discoveryAgent: source.connectorKey,
          title: input.title,
          description: input.description || null,
          category: input.category || null,
          quantity: input.quantity ?? null,
          unit: input.unit || null,
          condition: input.condition || null,
          locationCity: input.locationCity || null,
          locationState: input.locationState || null,
          availability: input.availability || null,
          originReference: input.originReference || null,
          originContact: input.originContact || null,
          urgency: input.urgency,
          evidenceUrl: input.evidenceUrl || null,
          confidence: input.confidence ?? null,
          expiresAt: input.expiresAt ?? null,
          status: "descoberta",
        })
        .returning(["id", "title", "status", "createdAt"])
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: null,
          actorUserId: user.id,
          action: "descoberta_central.registrada",
          entityType: "opportunity_registry",
          entityId: String(created.id),
          metadata: { title: created.title, sourceId: input.sourceId, quantity: input.quantity ?? null, unit: input.unit ?? null },
        },
        trx
      );

      return created;
    });

    return new Response(
      superjson.stringify({ opportunity: { ...opportunity, createdAt: opportunity.createdAt.toString() } }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao registrar descoberta:", error);
    const message = error instanceof Error ? error.message : "Não foi possível registrar a descoberta";
    const status = message.includes("restrita") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
