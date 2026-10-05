import { db } from "../../helpers/db.js";
import { getServerUserSession } from "../../helpers/getServerUserSession.js";
import { recordAuditLogEntry } from "../../helpers/auditLog.js";
import { clearServerSession } from "../../helpers/getSetServerSession.js";
import { schema } from "./account-delete_POST.schema.js";
import { compare } from "bcryptjs";
import { checkRateLimit, rateLimitResponse } from "../../helpers/rateLimit.js";
import superjson from "superjson";
import { ConflictError, buildErrorResponse } from "../../helpers/errorResponse.js";
import { lockOrganizationsInOrder } from "../../helpers/membershipAdmin.js";
import { lockPlatformAccessInOrder, lockUsersInOrder } from "../../helpers/lockOrder.js";

// Fase 52 (SEC-07): achado da varredura "qualquer endpoint com bcrypt" —
// este endpoint comparava a senha (bcrypt.compare) sem nenhum limite,
// diferente de login_with_password_POST (que já tem bloqueio por e-mail +
// por IP). A barreira de autenticação (precisa já ter uma sessão válida)
// reduz o risco — não é um endpoint público —, mas não o elimina: uma
// sessão comprometida (XSS, dispositivo compartilhado) poderia tentar
// senhas repetidamente sem throttling. Por usuário (não por IP): quem
// ataca aqui já está autenticado como essa pessoa, então o identificador
// natural é o próprio user id, não o IP de origem.
const USER_RATE_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 };

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

    const userLimit = checkRateLimit({ bucket: "account-delete", identifier: String(user.id), ...USER_RATE_LIMIT });
    if (!userLimit.allowed) {
      return rateLimitResponse(userLimit.retryAfterSeconds, "Muitas tentativas de confirmar a senha em pouco tempo. Aguarde antes de tentar de novo.");
    }

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

    await db.transaction().execute(async (trx) => {
      // Organização cujo único proprietário ativo é esta pessoa ficaria sem
      // ninguém capaz de administrá-la — bloqueia a exclusão nesse caso. A
      // verificação roda DENTRO da transação, depois de travar (em ordem
      // crescente de id) todas as organizações em que a pessoa é membro ativa:
      // sem isso, dois co-proprietários excluindo a conta ao mesmo tempo
      // deixariam a organização sem proprietário (docs/MEMBROS_ESPECIFICACAO.md, A1).
      const memberships = await trx
        .selectFrom("memberships")
        .select("organizationId")
        .where("userId", "=", user.id)
        .where("status", "=", "ativo")
        .execute();
      await lockOrganizationsInOrder(trx, memberships.map((row) => row.organizationId));

      // Ordem canônica de locks (lockOrder.tsx): organizações → users → platform_access → credenciais → sessões → audit.
      // Fase 89: titular de platform_access ATIVO (owner ou admin) não exclui a conta — o último owner nunca some, e a
      // anonimização nunca deixa "acesso de plataforma sem identidade". O trigger de banco é a defesa final.
      await lockUsersInOrder(trx, [user.id]);
      const [platformRow] = await lockPlatformAccessInOrder(trx, [user.id]);
      if (platformRow && platformRow.status === "active") {
        throw new ConflictError(
          platformRow.level === "owner"
            ? "Você é o proprietário da plataforma. Transfira a propriedade antes de excluir a conta."
            : "Você possui acesso de plataforma. Peça ao proprietário para revogá-lo antes de excluir a conta.",
          "plataforma_acesso_ativo"
        );
      }

      const blockingOrgs = await trx
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
        throw new ConflictError(`Você é o único proprietário d${blockingOrganizations.length === 1 ? "a organização" : "estas organizações"}: ${blockingOrganizations.join(", ")}. Não é possível excluir sua conta sem deixá-la(s) sem administração — promova outro proprietário (aba Equipe) antes de excluir sua conta.`);
      }

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

      // Fase 90: segredo TOTP, recovery codes e challenges são dados de credencial — saem junto com a senha.
      await trx.deleteFrom("mfaMethods").where("userId", "=", user.id).execute();
      await trx.deleteFrom("mfaRecoveryCodes").where("userId", "=", user.id).execute();
      await trx.deleteFrom("authChallenges").where("userId", "=", user.id).execute();
      await trx.deleteFrom("userPasswords").where("userId", "=", user.id).execute();
      await trx.deleteFrom("sessions").where("userId", "=", user.id).execute();

      await trx
        .updateTable("users")
        .set({
          email: `usuario-excluido-${user.id}@removido.invalid`,
          displayName: "Usuário removido",
          avatarUrl: null,
          anonymizedAt: new Date(),
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
