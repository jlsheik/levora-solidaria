import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { schema } from "./allocations-logistics_GET.schema";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
      allocationId: url.searchParams.get("allocationId"),
    });

    await requireOrganizationMembership(user.id, input.organizationId);

    const rows = await db
      .selectFrom("logisticsEvents")
      .leftJoin("users", "users.id", "logisticsEvents.actorUserId")
      .select([
        "logisticsEvents.id",
        "logisticsEvents.eventType",
        "logisticsEvents.scheduledFor",
        "logisticsEvents.notes",
        "logisticsEvents.proofUrl",
        "users.displayName as actorDisplayName",
        "logisticsEvents.occurredAt",
      ])
      .where("logisticsEvents.opportunityAllocationId", "=", input.allocationId)
      .where("logisticsEvents.organizationId", "=", input.organizationId)
      .orderBy("logisticsEvents.occurredAt", "asc")
      .execute();

    return new Response(
      superjson.stringify({
        events: rows.map((r) => ({
          ...r,
          id: String(r.id),
          scheduledFor: r.scheduledFor ? r.scheduledFor.toString() : null,
          occurredAt: r.occurredAt.toString(),
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao carregar linha do tempo de logística:", error);
    const message = error instanceof Error ? error.message : "Falha ao carregar linha do tempo";
    const status = message.includes("acesso") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
