import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePermission } from "../helpers/organizationAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { generateInviteToken, hashInviteToken, buildInviteAcceptUrl, INVITE_EXPIRATION_DAYS } from "../helpers/organizationInvites";
import { emailAdapter } from "../helpers/emailAdapter";
import { schema } from "./organization-invites_POST.schema";
import { checkRateLimit, rateLimitResponse } from "../helpers/rateLimit";
import { sql } from "kysely";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse";

// Por usuário, não por IP: quem convida já está autenticado, e o risco
// aqui é alguém com uma conta legítima usando o próprio e-mail da
// plataforma para bombardear caixas de entrada alheias (e-mail bombing),
// não um bot anônimo.
const USER_RATE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 };

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);

    const userLimit = checkRateLimit({ bucket: "organization-invites-create", identifier: String(user.id), ...USER_RATE_LIMIT });
    if (!userLimit.allowed) {
      return rateLimitResponse(userLimit.retryAfterSeconds, "Muitos convites criados em pouco tempo. Aguarde antes de convidar mais pessoas.");
    }

    const json = superjson.parse(await request.text());
    const input = schema.parse(json);
    const normalizedEmail = input.email.toLowerCase();

    await requirePermission(user.id, input.organizationId, "membros.gerencie");

    const organization = await db
      .selectFrom("organizations")
      .select(["id", "name"])
      .where("id", "=", input.organizationId)
      .executeTakeFirstOrThrow();

    const result = await db.transaction().execute(async (trx) => {
      const alreadyMember = await trx
        .selectFrom("memberships")
        .innerJoin("users", "users.id", "memberships.userId")
        .select(["memberships.id"])
        .where("memberships.organizationId", "=", input.organizationId)
        .where("memberships.status", "=", "ativo")
        .where(sql`LOWER(users.email)`, "=", normalizedEmail)
        .executeTakeFirst();
      if (alreadyMember) {
        return { type: "already_member" as const };
      }

      // Já existe um convite pendente para este e-mail nesta organização?
      // Revoga o antigo (deixa rastro) e cria um novo — evita acumular
      // convites pendentes duplicados e dá à pessoa que convidou uma forma
      // simples de "reenviar" (que na prática é revogar+recriar).
      const existingPending = await trx
        .selectFrom("organizationInvites")
        .select(["id"])
        .where("organizationId", "=", input.organizationId)
        .where("status", "=", "pendente")
        .where(sql`LOWER(email)`, "=", normalizedEmail)
        .executeTakeFirst();

      if (existingPending) {
        await trx
          .updateTable("organizationInvites")
          .set({ status: "revogado", revokedAt: new Date(), revokedByUserId: user.id })
          .where("id", "=", existingPending.id)
          .execute();
      }

      const token = generateInviteToken();
      const tokenHash = hashInviteToken(token);
      const expiresAt = new Date(Date.now() + INVITE_EXPIRATION_DAYS * 24 * 60 * 60 * 1000);

      const [invite] = await trx
        .insertInto("organizationInvites")
        .values({
          organizationId: input.organizationId,
          email: normalizedEmail,
          role: input.role,
          tokenHash,
          invitedByUserId: user.id,
          expiresAt,
        })
        .returning(["id", "email", "role", "status", "expiresAt", "createdAt"])
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "organizacao.convite_criado",
          entityType: "organization_invite",
          entityId: String(invite.id),
          metadata: { email: normalizedEmail, role: input.role, substituiuConviteAnterior: Boolean(existingPending) },
        },
        trx
      );

      return { type: "success" as const, invite, token };
    });

    if (result.type === "already_member") {
      return new Response(
        superjson.stringify({ message: "Este e-mail já pertence a um membro ativo desta organização" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    const acceptUrl = buildInviteAcceptUrl(result.token);
    const roleLabel: Record<string, string> = { administrador: "administrador", operador: "operador", voluntario: "voluntário" };

    const emailResult = await emailAdapter.send({
      to: result.invite.email,
      subject: `Convite para participar da ${organization.name} na Levora Solidária`,
      text: [
        `Você foi convidado(a) por ${user.displayName} para participar da organização "${organization.name}" na Levora Solidária, como ${roleLabel[result.invite.role] ?? result.invite.role}.`,
        `Para aceitar, acesse: ${acceptUrl}`,
        `Este convite expira em ${INVITE_EXPIRATION_DAYS} dias.`,
        `Se você não esperava este convite, pode ignorar este e-mail.`,
      ].join("\n\n"),
    });

    return new Response(
      superjson.stringify({
        invite: {
          id: result.invite.id,
          email: result.invite.email,
          role: result.invite.role,
          status: result.invite.status,
          expiresAt: result.invite.expiresAt.toString(),
          createdAt: result.invite.createdAt.toString(),
        },
        acceptUrl,
        emailSent: emailResult.sent,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao criar convite:", error);
    return buildErrorResponse(error, "Não foi possível criar o convite");
  }
}
