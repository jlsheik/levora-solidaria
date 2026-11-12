import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { schema } from "./integrity-alerts_GET.schema.js";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
      status: url.searchParams.get("status") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });

    await requirePermissionToRead(user.id, input.organizationId, "automacao.leia");

    let query = db
      .selectFrom("integrityAlerts")
      .leftJoin("agentPrincipals", "agentPrincipals.id", "integrityAlerts.createdByAgentPrincipalId")
      .select([
        "integrityAlerts.id",
        "integrityAlerts.level",
        "integrityAlerts.category",
        "integrityAlerts.title",
        "integrityAlerts.detail",
        "integrityAlerts.entityType",
        "integrityAlerts.entityId",
        "integrityAlerts.status",
        "integrityAlerts.createdAt",
        "integrityAlerts.acknowledgedAt",
        "integrityAlerts.resolvedAt",
        "integrityAlerts.resolutionNote",
        "agentPrincipals.name as agentName",
      ])
      .where("integrityAlerts.organizationId", "=", input.organizationId);

    query = input.status
      ? query.where("integrityAlerts.status", "=", input.status)
      : query.where("integrityAlerts.status", "in", ["aberto", "reconhecido"]);

    const rows = await query.orderBy("integrityAlerts.id", "desc").limit(input.limit).execute();

    return new Response(
      superjson.stringify({
        alerts: rows.map((row) => ({
          ...row,
          id: String(row.id),
          createdAt: row.createdAt.toString(),
          acknowledgedAt: row.acknowledgedAt?.toString() ?? null,
          resolvedAt: row.resolvedAt?.toString() ?? null,
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar alertas de integridade:", error);
    return buildErrorResponse(error, "Não foi possível carregar os alertas");
  }
}
