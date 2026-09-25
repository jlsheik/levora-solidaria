import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { hashInviteToken, expireInviteIfPast } from "../helpers/organizationInvites";
import { schema } from "./organization-invites-accept_POST.schema";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);
    const tokenHash = hashInviteToken(input.token);

    const result = await db.transaction().execute(async (trx) => {
      const invite = await trx
        .selectFrom("organizationInvites")
        .innerJoin("organizations", "organizations.id", "organizationInvites.organizationId")
        .select([
          "organizationInvites.id",
          "organizationInvites.status",
          "organizationInvites.email",
          "organizationInvites.role",
          "organizationInvites.expiresAt",
          "organizationInvites.organizationId",
          "organizationInvites.invitedByUserId",
          "organizations.name as organizationName",
        ])
        .where("organizationInvites.tokenHash", "=", tokenHash)
        .forUpdate()
        .executeTakeFirst();

      if (!invite) return { type: "invalido" as const };
      if (invite.status !== "pendente") return { type: "ja_processado" as const };
      if (await expireInviteIfPast(trx, invite)) {
        return { type: "expirado" as const };
      }
      if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
        return { type: "email_diferente" as const };
      }

      await trx
        .insertInto("memberships")
        .values({
          organizationId: invite.organizationId,
          userId: user.id,
          role: invite.role,
          status: "ativo",
          invitedByUserId: invite.invitedByUserId,
        })
        .onConflict((oc) =>
          oc.columns(["organizationId", "userId"]).doUpdateSet({ role: invite.role, status: "ativo" })
        )
        .execute();

      await trx
        .updateTable("organizationInvites")
        .set({ status: "aceito", acceptedAt: new Date(), acceptedByUserId: user.id })
        .where("id", "=", invite.id)
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: invite.organizationId,
          actorUserId: user.id,
          action: "organizacao.convite_aceito",
          entityType: "organization_invite",
          entityId: String(invite.id),
          metadata: { email: invite.email, role: invite.role },
        },
        trx
      );

      return { type: "sucesso" as const, organizationId: invite.organizationId, organizationName: invite.organizationName, role: invite.role };
    });

    if (result.type === "invalido") {
      return new Response(superjson.stringify({ message: "Convite não encontrado" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "ja_processado") {
      return new Response(superjson.stringify({ message: "Este convite já foi usado, revogado ou expirou" }), {
        status: 410,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "expirado") {
      return new Response(superjson.stringify({ message: "Este convite expirou" }), {
        status: 410,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "email_diferente") {
      return new Response(
        superjson.stringify({ message: "Este convite foi enviado para outro e-mail. Entre com a conta correspondente para aceitá-lo." }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      superjson.stringify({ organizationId: result.organizationId, organizationName: result.organizationName, role: result.role }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao aceitar convite:", error);
    return buildErrorResponse(error, "Não foi possível aceitar o convite");
  }
}
