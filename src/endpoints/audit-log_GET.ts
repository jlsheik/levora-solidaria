import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { schema } from "./audit-log_GET.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
      limit: url.searchParams.get("limit") ?? undefined,
    });

    // A trilha de auditoria só pode ser lida por quem tem a permissão
    // auditoria.leia — hoje proprietário/administrador (ver
    // src/helpers/permissions.tsx), nunca operador/voluntário nem quem não
    // é membro. É leitura: usa requirePermissionToRead, não requirePermission
    // — o dono de uma organização ainda "em análise" continua podendo ver
    // a própria trilha de auditoria enquanto espera aprovação.
    await requirePermissionToRead(user.id, input.organizationId, "auditoria.leia");

    const rows = await db
      .selectFrom("auditLog")
      .leftJoin("users", "users.id", "auditLog.actorUserId")
      .select([
        "auditLog.id",
        "auditLog.action",
        "auditLog.entityType",
        "auditLog.entityId",
        "auditLog.metadata",
        "auditLog.actorUserId",
        "users.displayName as actorDisplayName",
        "auditLog.createdAt",
      ])
      .where("auditLog.organizationId", "=", input.organizationId)
      .orderBy("auditLog.createdAt", "desc")
      .limit(input.limit ?? 50)
      .execute();

    return new Response(
      superjson.stringify({
        entries: rows.map((r) => ({
          id: String(r.id),
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          metadata: r.metadata,
          actorUserId: r.actorUserId,
          actorDisplayName: r.actorDisplayName,
          createdAt: r.createdAt.toString(),
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao carregar auditoria:", error);
    return buildErrorResponse(error, "Falha ao carregar auditoria");
  }
}
