import { db } from "../../helpers/db.js";
import { getServerUserSession } from "../../helpers/getServerUserSession.js";
import { NotAuthenticatedError } from "../../helpers/getSetServerSession.js";
import { recordAuditLogEntry } from "../../helpers/auditLog.js";
import { generatePasswordHash } from "../../helpers/generatePasswordHash.js";
import { lockUserSessions } from "../../helpers/userSessions.js";
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
 * Troca de senha AUTENTICADA (Fase 88). A sessão atual é mantida; todas as outras sessões do usuário são revogadas
 * (decisão D-A1). Nunca recebe nem devolve e-mail, papel ou organização. Não há recuperação de senha aqui (depende de
 * SMTP); `passwordChangeRequired` do JWT é um resíduo inerte do template e não participa deste fluxo.
 *
 * Concorrência: uma transação curta. Ordem de locks `user_passwords` → `sessions` (a de `account-delete_POST`). Duas
 * trocas simultâneas serializam na linha da senha: a segunda compara a senha atual informada com o hash JÁ trocado e
 * falha (401) — nunca duas trocas "vencem" com a mesma senha antiga.
 */
export async function handle(request: Request) {
  try {
    const { user, session } = await getServerUserSession(request);

    const limit = checkRateLimit({ bucket: "password-change", identifier: String(user.id), ...USER_RATE_LIMIT });
    if (!limit.allowed) {
      return rateLimitResponse(limit.retryAfterSeconds, "Muitas tentativas de alterar a senha em pouco tempo. Aguarde antes de tentar de novo.");
    }

    const input = schema.parse(superjson.parse(await request.text()));
    // O custo do bcrypt fica FORA da transação para o hash novo (nenhum lock segurado durante ele).
    const newHash = await generatePasswordHash(input.newPassword);

    const result = await db.transaction().execute(async (trx) => {
      const passwordRows = await trx.selectFrom("userPasswords").select(["id", "passwordHash"]).where("userId", "=", user.id).orderBy("id", "asc").forUpdate().execute();
      if (passwordRows.length === 0) return { type: "sem_senha" as const };

      await lockUserSessions(trx, user.id, session.id);

      // Compara contra o hash lido SOB o lock (o mais recente), nunca contra um hash lido antes.
      if (!(await compare(input.currentPassword, passwordRows[0].passwordHash))) return { type: "senha_atual_incorreta" as const };
      if (await compare(input.newPassword, passwordRows[0].passwordHash)) return { type: "senha_igual" as const };

      await trx.updateTable("userPasswords").set({ passwordHash: newHash }).where("userId", "=", user.id).execute();
      const revoked = await trx.deleteFrom("sessions").where("userId", "=", user.id).where("id", "<>", session.id).returning(["id"]).execute();

      // Auditoria por último. Metadata: só a contagem — nunca senha, hash, token ou cookie.
      await recordAuditLogEntry(
        { organizationId: null, actorUserId: user.id, action: "usuario.senha_alterada", entityType: "user", entityId: String(user.id), metadata: { outrasSessoesRevogadas: revoked.length } },
        trx
      );
      return { type: "ok" as const, revoked: revoked.length };
    });

    if (result.type === "sem_senha") return json(400, { message: "Não foi possível confirmar sua senha", code: "sem_senha" });
    if (result.type === "senha_atual_incorreta") return json(401, { message: "Senha atual incorreta", code: "senha_atual_incorreta" });
    if (result.type === "senha_igual") return json(422, { message: "A nova senha precisa ser diferente da atual", code: "senha_igual" });
    return json(200, { message: "Senha alterada. As outras sessões foram encerradas.", revokedSessions: result.revoked });
  } catch (error: unknown) {
    if (error instanceof NotAuthenticatedError) return json(401, { error: "Not authenticated" });
    console.error("Erro ao alterar senha:", error);
    return buildErrorResponse(error, "Não foi possível alterar a senha");
  }
}
