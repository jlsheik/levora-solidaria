import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { hashInviteToken, expireInviteIfPast } from "../helpers/organizationInvites.js";
import { lockOrganization } from "../helpers/membershipAdmin.js";
import { ConflictError } from "../helpers/errorResponse.js";
import { schema } from "./organization-invites-accept_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);
    const tokenHash = hashInviteToken(input.token);

    const result = await db.transaction().execute(async (trx) => {
      // Ordem global de locks: organização → membership → convite. A
      // organização do convite só é conhecida pelo token, então ela é lida
      // sem lock, travada, e só então o convite é relido FOR UPDATE.
      const inviteOrganization = await trx
        .selectFrom("organizationInvites")
        .select("organizationId")
        .where("tokenHash", "=", tokenHash)
        .executeTakeFirst();
      if (!inviteOrganization) return { type: "invalido" as const };
      await lockOrganization(trx, inviteOrganization.organizationId);

      // 2º da ordem global: a membership de quem aceita (se existir), travada
      // ANTES da linha do convite. Só a linha do convite é travada abaixo —
      // sem JOIN com `organizations`, que já está travada com NO KEY UPDATE e
      // não deve ser promovida a FOR UPDATE.
      const existingMembership = await trx
        .selectFrom("memberships")
        .select(["id", "role", "status"])
        .where("organizationId", "=", inviteOrganization.organizationId)
        .where("userId", "=", user.id)
        .forUpdate()
        .executeTakeFirst();

      // 3º da ordem global: o convite.
      const invite = await trx
        .selectFrom("organizationInvites")
        .select([
          "id",
          "status",
          "email",
          "role",
          "expiresAt",
          "organizationId",
          "invitedByUserId",
        ])
        .where("tokenHash", "=", tokenHash)
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

      const organizationRow = await trx
        .selectFrom("organizations")
        .select("name")
        .where("id", "=", invite.organizationId)
        .executeTakeFirstOrThrow();

      // Convite antigo nunca pode rebaixar/promover quem já é membro ativo.
      if (existingMembership?.status === "ativo") {
        throw new ConflictError("Você já é membro desta organização");
      }

      const reactivation = existingMembership !== undefined;
      if (existingMembership) {
        await trx
          .updateTable("memberships")
          .set({ role: invite.role, status: "ativo", invitedByUserId: invite.invitedByUserId, updatedAt: new Date() })
          .where("id", "=", existingMembership.id)
          .execute();
      } else {
        await trx
          .insertInto("memberships")
          .values({
            organizationId: invite.organizationId,
            userId: user.id,
            role: invite.role,
            status: "ativo",
            invitedByUserId: invite.invitedByUserId,
          })
          .execute();
      }

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
          metadata: {
            email: invite.email,
            role: invite.role,
            reativacao: reactivation,
            ...(existingMembership ? { papelAnterior: existingMembership.role } : {}),
          },
        },
        trx
      );

      return { type: "sucesso" as const, organizationId: invite.organizationId, organizationName: organizationRow.name, role: invite.role };
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
