import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { checkRateLimit, rateLimitResponse } from "../helpers/rateLimit.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { lockOrganization, readActorUnderLock } from "../helpers/membershipAdmin.js";
import { schema } from "./organization-name_POST.schema.js";
import superjson from "superjson";

const USER_RATE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 };

/**
 * Altera SOMENTE `organizations.name`. Autorização: `propriedade.gerencie` (só o proprietário ATIVO; administrador, operador, voluntário e
 * quem não é membro recebem 403) numa organização com acesso liberado — o mesmo guard das demais ações restritas. A permissão e a
 * membership são relidas SOB O LOCK da organização (um proprietário rebaixado/desativado no meio da requisição não renomeia). Nada
 * além do nome é tocado: slug (identificador público), tipo, status, localização, documento, matching, estoque e ledger ficam como estão.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);

    const limit = checkRateLimit({ bucket: "organization-name", identifier: String(user.id), ...USER_RATE_LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitas alterações de nome em pouco tempo. Aguarde antes de tentar de novo.");

    const input = schema.parse(superjson.parse(await request.text()));

    await requirePermission(user.id, input.organizationId, "propriedade.gerencie");

    const result = await db.transaction().execute(async (trx) => {
      await lockOrganization(trx, input.organizationId);
      await readActorUnderLock(trx, input.organizationId, user.id, "propriedade.gerencie");

      const current = await trx.selectFrom("organizations").select(["id", "name", "slug", "type", "status", "city", "state"]).where("id", "=", input.organizationId).executeTakeFirstOrThrow();
      if (current.name === input.name) return { changed: false as const, organization: current };

      const [updated] = await trx
        .updateTable("organizations")
        .set({ name: input.name })
        .where("id", "=", input.organizationId)
        .returning(["id", "name", "slug", "type", "status", "city", "state"])
        .execute();

      // auditoria por último (segura o lock global da cadeia até o commit); só ids e os dois nomes
      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "organizacao.nome_alterado",
          entityType: "organization",
          entityId: String(input.organizationId),
          metadata: { nomeAnterior: current.name, nomeNovo: updated.name },
        },
        trx
      );

      return { changed: true as const, organization: updated };
    });

    return new Response(superjson.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao alterar o nome da organização:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível alterar o nome da organização");
  }
}
