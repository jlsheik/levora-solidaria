import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { schema } from "./audit-log_GET.schema";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
      limit: url.searchParams.get("limit") ?? undefined,
    });

    // A trilha de auditoria só pode ser lida por proprietário/administrador
    // da organização — nunca por operador/voluntário, e nunca por quem não
    // é membro.
    await requireOrganizationMembership(user.id, input.organizationId, [
      "proprietario",
      "administrador",
    ]);

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
    const message = error instanceof Error ? error.message : "Falha ao carregar auditoria";
    const status = message.includes("acesso") || message.includes("papel") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
