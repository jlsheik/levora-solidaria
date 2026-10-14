import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { checkRateLimit, rateLimitResponse } from "../helpers/rateLimit.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { schema } from "./source-name_POST.schema.js";
import superjson from "superjson";

const USER_RATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };

/**
 * Altera SOMENTE `sources.name`. Autorização: administrador da plataforma (o mesmo guard do cadastro de fontes); sem aprovação adicional.
 * Nada além do nome é escrito: tipo, conector, endereço, credencial, permissões, status/estado de conexão e campos de execução ficam como
 * estão (o `UPDATE` só tem `name`; o corpo é estrito). A linha é travada para serializar com outras escritas da mesma fonte.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);

    const limit = checkRateLimit({ bucket: "source-name", identifier: String(user.id), ...USER_RATE_LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitas alterações de nome em pouco tempo. Aguarde antes de tentar de novo.");

    const input = schema.parse(superjson.parse(await request.text()));

    const result = await db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom("sources").select(["id", "name"]).where("id", "=", input.sourceId).forUpdate().executeTakeFirst();
      if (!current) return null;
      if (current.name === input.name) return { changed: false as const, source: current };

      const [updated] = await trx.updateTable("sources").set({ name: input.name }).where("id", "=", input.sourceId).returning(["id", "name"]).execute();

      // auditoria por último (segura o lock global da cadeia até o commit); só id e os dois nomes
      await recordAuditLogEntry(
        {
          organizationId: null,
          actorUserId: user.id,
          action: "fonte.nome_alterado",
          entityType: "source",
          entityId: String(input.sourceId),
          metadata: { nomeAnterior: current.name, nomeNovo: updated.name },
        },
        trx
      );
      return { changed: true as const, source: updated };
    });

    if (!result) {
      return new Response(superjson.stringify({ message: "Fonte não encontrada" }), { status: 404, headers: { "Content-Type": "application/json" } });
    }
    return new Response(superjson.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao alterar o nome da fonte:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível alterar o nome da fonte");
  }
}
