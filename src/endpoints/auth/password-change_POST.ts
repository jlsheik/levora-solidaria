import { db } from "../../helpers/db.js";
import { getServerUserSession } from "../../helpers/getServerUserSession.js";
import { NotAuthenticatedError, setServerSession } from "../../helpers/getSetServerSession.js";
import { recordAuditLogEntry } from "../../helpers/auditLog.js";
import { generatePasswordHash } from "../../helpers/generatePasswordHash.js";
import { lockSessionsOf } from "../../helpers/userSessions.js";
import { lockUsersInOrder } from "../../helpers/lockOrder.js";
import { rotateSessionInTx } from "../../helpers/sessionLifecycle.js";
import { getMfaMethod } from "../../helpers/mfa.js";
import { requireRecentAuth } from "../../helpers/stepUp.js";
import { checkRateLimit, rateLimitResponse } from "../../helpers/rateLimit.js";
import { buildErrorResponse } from "../../helpers/errorResponse.js";
import { schema } from "./password-change_POST.schema.js";
import { compare } from "bcryptjs";
import superjson from "superjson";

// Mesmo limite de `account-delete_POST` (também exige a senha atual): confirmar a senha é um oráculo de tentativa.
const USER_RATE_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 };

const json = (status: number, body: Record<string, unknown>) =>
  new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Troca de senha AUTENTICADA (Fase 88, adaptada à identidade). Exige a senha atual e, quando a conta tem segundo fator ATIVO, um step-up
 * RECENTE (stepUp.tsx; a senha sozinha não basta numa sessão sequestrada de uma conta protegida). Todas as OUTRAS sessões do usuário são
 * revogadas (decisão D-A1) e a sessão atual é ROTACIONADA (novo id, mesmo created_at e mesmo teto absoluto: a troca de credencial nunca
 * prolonga a sessão). Conta sem senha (só login social) não tem o que trocar: 400 `sem_senha`; esta função não inventa uma senha.
 * Nunca recebe nem devolve e-mail, papel ou organização.
 *
 * Locks na ORDEM CANÔNICA (lockOrder.tsx): users → credenciais (user_passwords) → sessions → audit. O hash da senha nova é calculado ANTES e
 * fora da transação (nenhum lock segurado durante o bcrypt). Duas trocas simultâneas serializam na linha da senha: a segunda compara a senha
 * atual informada com o hash JÁ trocado e falha (401).
 */
export async function handle(request: Request) {
  try {
    const { user, session } = await getServerUserSession(request);

    const limit = checkRateLimit({ bucket: "password-change", identifier: String(user.id), ...USER_RATE_LIMIT });
    if (!limit.allowed) {
      return rateLimitResponse(limit.retryAfterSeconds, "Muitas tentativas de alterar a senha em pouco tempo. Aguarde antes de tentar de novo.");
    }

    const input = schema.parse(superjson.parse(await request.text()));
    const newHash = await generatePasswordHash(input.newPassword);

    const result = await db.transaction().execute(async (trx) => {
      // 2. users (e a conta ainda existe)
      if ((await lockUsersInOrder(trx, [user.id])).length === 0) throw new NotAuthenticatedError();
      const owner = await trx.selectFrom("users").select("anonymizedAt").where("id", "=", user.id).executeTakeFirst();
      if (!owner || owner.anonymizedAt) throw new NotAuthenticatedError();
      // 4. credenciais
      const passwordRows = await trx.selectFrom("userPasswords").select(["id", "passwordHash"]).where("userId", "=", user.id).orderBy("id", "asc").forUpdate().execute();
      if (passwordRows.length === 0) return { type: "sem_senha" as const };
      // 5. sessions (confere que a sessão ATUAL ainda existe)
      const sessions = await lockSessionsOf(trx, user.id, session.id);
      const fresh = sessions.find((s) => s.id === session.id)!;

      // Segundo fator ativo ⇒ step-up recente (lança 403 reauth_required; a página abre o diálogo e repete).
      if (await getMfaMethod(trx, user.id, "active")) requireRecentAuth({ mfaVerifiedAt: fresh.mfaVerifiedAt, lastReauthAt: fresh.lastReauthAt });

      // Compara contra o hash lido SOB o lock (o mais recente), nunca contra um hash lido antes.
      if (!(await compare(input.currentPassword, passwordRows[0].passwordHash))) return { type: "senha_atual_incorreta" as const };
      if (await compare(input.newPassword, passwordRows[0].passwordHash)) return { type: "senha_igual" as const };

      await trx.updateTable("userPasswords").set({ passwordHash: newHash }).where("userId", "=", user.id).execute();
      const revoked = await trx.deleteFrom("sessions").where("userId", "=", user.id).where("id", "<>", session.id).returning(["id"]).execute();
      const rotated = await rotateSessionInTx(trx, session.id);

      // 7. Auditoria por último. Metadata: só a contagem — nunca senha, hash, token ou cookie.
      await recordAuditLogEntry(
        { organizationId: null, actorUserId: user.id, action: "usuario.senha_alterada", entityType: "user", entityId: String(user.id), metadata: { outrasSessoesRevogadas: revoked.length } },
        trx
      );
      return { type: "ok" as const, revoked: revoked.length, rotated };
    });

    if (result.type === "sem_senha") return json(400, { message: "Esta conta não tem senha para alterar.", code: "sem_senha" });
    if (result.type === "senha_atual_incorreta") return json(401, { message: "Senha atual incorreta", code: "senha_atual_incorreta" });
    if (result.type === "senha_igual") return json(422, { message: "A nova senha precisa ser diferente da atual", code: "senha_igual" });

    const response = json(200, { message: "Senha alterada. As outras sessões foram encerradas.", revokedSessions: result.revoked });
    await setServerSession(
      response,
      { id: result.rotated.newId, createdAt: result.rotated.createdAt.getTime(), lastAccessed: Date.now() },
      { absoluteExpiresAt: result.rotated.absoluteExpiresAt }
    );
    return response;
  } catch (error: unknown) {
    if (error instanceof NotAuthenticatedError) return json(401, { error: "Not authenticated" });
    console.error("Erro ao alterar senha:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível alterar a senha");
  }
}
