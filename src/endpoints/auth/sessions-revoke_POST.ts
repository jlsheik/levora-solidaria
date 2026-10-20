import { db } from "../../helpers/db.js";
import { getServerUserSession } from "../../helpers/getServerUserSession.js";
import { NotAuthenticatedError } from "../../helpers/getSetServerSession.js";
import { recordAuditLogEntry } from "../../helpers/auditLog.js";
import { lockUserSessions, sessionHandle } from "../../helpers/userSessions.js";
import { buildErrorResponse } from "../../helpers/errorResponse.js";
import { schema } from "./sessions-revoke_POST.schema.js";
import superjson from "superjson";

const json = (status: number, body: Record<string, unknown>) =>
  new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Revoga UMA sessão do próprio usuário (Fase 88). Proteção contra IDOR: o identificador só é resolvido DENTRO do
 * conjunto de sessões do usuário autenticado (travado); handle inventado, de outro usuário ou já revogado = 404, sem
 * distinguir os casos. Revogar a sessão atual é recusado (409) — para isso existe o logout.
 * Duas revogações simultâneas da mesma sessão: serializam no lock; a segunda não encontra a sessão e recebe 404.
 */
export async function handle(request: Request) {
  try {
    const { user, session } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));

    const result = await db.transaction().execute(async (trx) => {
      const rows = await lockUserSessions(trx, user.id, session.id);
      const target = rows.find((r) => sessionHandle(r.id) === input.sessionHandle);
      if (!target) return "nao_encontrada" as const;
      if (target.id === session.id) return "atual" as const;
      await trx.deleteFrom("sessions").where("id", "=", target.id).where("userId", "=", user.id).execute();
      await recordAuditLogEntry(
        { organizationId: null, actorUserId: user.id, action: "usuario.sessao_revogada", entityType: "user", entityId: String(user.id), metadata: { sessionHandle: input.sessionHandle } },
        trx
      );
      return "ok" as const;
    });

    if (result === "nao_encontrada") return json(404, { message: "Sessão não encontrada", code: "sessao_nao_encontrada" });
    if (result === "atual") return json(409, { message: "Esta é a sua sessão atual. Use \"Sair\" para encerrá-la.", code: "sessao_atual" });
    return json(200, { message: "Sessão encerrada" });
  } catch (error: unknown) {
    if (error instanceof NotAuthenticatedError) return json(401, { error: "Not authenticated" });
    console.error("Erro ao revogar sessão:", error);
    return buildErrorResponse(error, "Não foi possível encerrar a sessão");
  }
}
