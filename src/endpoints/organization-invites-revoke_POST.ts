import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePermission } from "../helpers/organizationAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { schema } from "./organization-invites-revoke_POST.schema";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "membros.gerencie");

    const invite = await db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("organizationInvites")
        .select(["id", "status", "email"])
        .where("id", "=", input.inviteId)
        .where("organizationId", "=", input.organizationId)
        .executeTakeFirst();

      if (!existing) return null;
      if (existing.status !== "pendente") return existing;

      const [updated] = await trx
        .updateTable("organizationInvites")
        .set({ status: "revogado", revokedAt: new Date(), revokedByUserId: user.id })
        .where("id", "=", input.inviteId)
        .returning(["id", "status"])
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "organizacao.convite_revogado",
          entityType: "organization_invite",
          entityId: String(input.inviteId),
          metadata: { email: existing.email },
        },
        trx
      );

      return updated;
    });

    if (!invite) {
      return new Response(
        superjson.stringify({ message: "Convite não encontrado nesta organização" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(superjson.stringify({ invite: { id: invite.id, status: invite.status } }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao revogar convite:", error);
    return buildErrorResponse(error, "Não foi possível revogar o convite");
  }
}
