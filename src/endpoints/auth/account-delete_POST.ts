import { db } from "../../helpers/db";
import { getServerUserSession } from "../../helpers/getServerUserSession";
import { recordAuditLogEntry } from "../../helpers/auditLog";
import { clearServerSession } from "../../helpers/getSetServerSession";
import { schema } from "./account-delete_POST.schema";
import { compare } from "bcryptjs";
import superjson from "superjson";
import { buildErrorResponse } from "../../helpers/errorResponse";

/**
 * Exclusão de conta (LGPD, art. 18 — direito de eliminação). Ver
 * docs/PRIVACY.md.
 *
 * Não apaga a linha de `users` — apagar quebraria toda referência de
 * chave estrangeira em audit_log/stock_transactions/etc., que são
 * append-only e não podem perder a rastreabilidade de quem fez o quê. Em
 * vez disso: anonimiza os campos pessoais (email, nome, avatar), remove
 * senha e sessões (login imediatamente impossível), e inativa todas as
 * memberships (perde acesso a todas as organizações). O registro de
 * auditoria de cada ação passada continua íntegro, só mostrando um nome
 * anonimizado quando exibido — a própria exclusão também vira um evento de
 * auditoria, gravado ANTES de anonimizar (ver ordem das operações abaixo).
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    const passwordRow = await db
      .selectFrom("userPasswords")
      .select(["passwordHash"])
      .where("userId", "=", user.id)
      .executeTakeFirst();

    if (!passwordRow) {
      return new Response(superjson.stringify({ message: "Não foi possível confirmar sua senha" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const passwordValid = await compare(input.password, passwordRow.passwordHash);
    if (!passwordValid) {
      return new Response(superjson.stringify({ message: "Senha incorreta" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Organização cujo único proprietário ativo é esta pessoa ficaria sem
    // ninguém capaz de administrá-la (não existe ainda um fluxo de
    // transferência de propriedade, ver docs/CONVITE_DE_MEMBROS.md) —
    // bloqueia a exclusão nesse caso em vez de deixar a organização órfã.
    // Uma query só (NOT EXISTS correlacionado), não uma por organização
    // possuída — quem é dono de N organizações não gera N idas ao banco.
    const blockingOrgs = await db
      .selectFrom("memberships")
      .innerJoin("organizations", "organizations.id", "memberships.organizationId")
      .select(["organizations.id", "organizations.name"])
      .where("memberships.userId", "=", user.id)
      .where("memberships.role", "=", "proprietario")
      .where("memberships.status", "=", "ativo")
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("memberships as otherOwner")
              .select("otherOwner.id")
              .whereRef("otherOwner.organizationId", "=", "memberships.organizationId")
              .where("otherOwner.role", "=", "proprietario")
              .where("otherOwner.status", "=", "ativo")
              .where("otherOwner.userId", "!=", user.id)
          )
        )
      )
      .execute();

    const blockingOrganizations = blockingOrgs.map((org) => org.name);

    if (blockingOrganizations.length > 0) {
      return new Response(
        superjson.stringify({
          message: `Você é o único proprietário d${blockingOrganizations.length === 1 ? "a organização" : "estas organizações"}: ${blockingOrganizations.join(", ")}. Não é possível excluir sua conta sem deixá-la(s) sem administração — entre em contato com a equipe da Levora Solidária para transferir a titularidade antes de excluir sua conta.`,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    await db.transaction().execute(async (trx) => {
      await recordAuditLogEntry(
        {
          organizationId: null,
          actorUserId: user.id,
          action: "usuario.conta_excluida",
          entityType: "user",
          entityId: String(user.id),
          metadata: { email: user.email },
        },
        trx
      );

      await trx
        .updateTable("memberships")
        .set({ status: "inativo", updatedAt: new Date() })
        .where("userId", "=", user.id)
        .execute();

      await trx.deleteFrom("userPasswords").where("userId", "=", user.id).execute();
      await trx.deleteFrom("sessions").where("userId", "=", user.id).execute();

      await trx
        .updateTable("users")
        .set({
          email: `usuario-excluido-${user.id}@removido.invalid`,
          displayName: "Usuário removido",
          avatarUrl: null,
          updatedAt: new Date(),
        })
        .where("id", "=", user.id)
        .execute();
    });

    const response = new Response(superjson.stringify({ message: "Conta excluída" }), {
      headers: { "Content-Type": "application/json" },
    });
    clearServerSession(response);
    return response;
  } catch (error: unknown) {
    console.error("Erro ao excluir conta:", error);
    return buildErrorResponse(error, "Não foi possível excluir a conta");
  }
}
