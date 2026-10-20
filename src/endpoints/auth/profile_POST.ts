import { db } from "../../helpers/db.js";
import { getServerUserSession } from "../../helpers/getServerUserSession.js";
import { NotAuthenticatedError } from "../../helpers/getSetServerSession.js";
import { recordAuditLogEntry } from "../../helpers/auditLog.js";
import { lockUserSessions } from "../../helpers/userSessions.js";
import { buildErrorResponse } from "../../helpers/errorResponse.js";
import type { User } from "../../helpers/User.js";
import { schema } from "./profile_POST.schema.js";
import superjson from "superjson";

const json = (status: number, body: Record<string, unknown>) =>
  new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Atualiza o PRÓPRIO nome de exibição (Fase 88). O alvo é sempre o usuário da sessão — não existe parâmetro de id.
 * Auditoria só quando o nome de fato muda, e SEM gravar o nome (dado pessoal): só quais campos mudaram.
 */
export async function handle(request: Request) {
  try {
    const { user, session } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));

    const updated = await db.transaction().execute(async (trx) => {
      await lockUserSessions(trx, user.id, session.id);
      const current = await trx.selectFrom("users").select(["displayName"]).where("id", "=", user.id).forUpdate().executeTakeFirstOrThrow();
      if (current.displayName === input.displayName) return null;
      await trx.updateTable("users").set({ displayName: input.displayName, updatedAt: new Date() }).where("id", "=", user.id).execute();
      await recordAuditLogEntry(
        { organizationId: null, actorUserId: user.id, action: "usuario.perfil_atualizado", entityType: "user", entityId: String(user.id), metadata: { campos: ["displayName"] } },
        trx
      );
      return input.displayName;
    });

    const result: User = { ...user, displayName: updated ?? user.displayName };
    if (updated === null) {
      // Sem mudança: devolve o nome já gravado (pode ter sido alterado por outra sessão desde o início da requisição).
      const fresh = await db.selectFrom("users").select(["displayName"]).where("id", "=", user.id).executeTakeFirstOrThrow();
      result.displayName = fresh.displayName;
    }
    return json(200, { user: result });
  } catch (error: unknown) {
    if (error instanceof NotAuthenticatedError) return json(401, { error: "Not authenticated" });
    console.error("Erro ao atualizar perfil:", error);
    return buildErrorResponse(error, "Não foi possível salvar o perfil");
  }
}
