import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { readActorUnderLock } from "../helpers/membershipAdmin.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { checkRateLimit, rateLimitResponse } from "../helpers/rateLimit.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import type { Json } from "../helpers/schema.js";
import { schema } from "./need-details_POST.schema.js";
import superjson from "superjson";

const USER_RATE_LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 };

/**
 * Edição CADASTRAL da necessidade: SOMENTE `title`, `description` e `priority` (corpo estrito; o `UPDATE` só tem essas colunas). Mesma
 * permissão e mesmo guard da criação (`necessidades.gerencie`, organização com acesso liberado), relida sob lock na transação. Não toca
 * quantidade, unidade, item, status, ledger, estoque nem recebimentos; não dispara matching, reserva nem atribuição: o motor lê a necessidade
 * VIVA na próxima varredura (as avaliações já gravadas em `match_evaluations` são imutáveis e continuam mostrando o que foi avaliado na época).
 *
 * Lock da necessidade: FOR NO KEY UPDATE (Fase 81) — serializa edições/mudanças de status da mesma necessidade, mas NÃO conflita com o
 * FOR KEY SHARE que a FK do ledger toma ao registrar um recebimento (FOR UPDATE aqui fechava um ciclo de deadlock já visto nesta base).
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);

    const limit = checkRateLimit({ bucket: "need-details", identifier: String(user.id), ...USER_RATE_LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitas alterações de necessidade em pouco tempo. Aguarde antes de tentar de novo.");

    const input = schema.parse(superjson.parse(await request.text()));

    await requirePermission(user.id, input.organizationId, "necessidades.gerencie");

    const result = await db.transaction().execute(async (trx) => {
      await readActorUnderLock(trx, input.organizationId, user.id, "necessidades.gerencie");

      const current = await trx
        .selectFrom("needs")
        .select(["id", "title", "description", "priority"])
        .where("id", "=", input.needId)
        .where("organizationId", "=", input.organizationId) // a necessidade tem de ser DESTA organização
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!current) return null;

      const changes: Record<string, { de: string | null; para: string | null }> = {};
      const next = { title: current.title, description: current.description, priority: current.priority };
      if (input.title !== undefined && input.title !== current.title) {
        changes.title = { de: current.title, para: input.title };
        next.title = input.title;
      }
      if (input.description !== undefined && input.description !== current.description) {
        changes.description = { de: current.description, para: input.description };
        next.description = input.description;
      }
      if (input.priority !== undefined && input.priority !== current.priority) {
        changes.priority = { de: current.priority, para: input.priority };
        next.priority = input.priority;
      }
      if (Object.keys(changes).length === 0) return { changed: false as const, need: { id: current.id, ...next } };

      // só as 3 colunas cadastrais (+ `updated_at` pelo gatilho): nada de quantidade, unidade, item ou status
      const [updated] = await trx
        .updateTable("needs")
        .set({ title: next.title, description: next.description, priority: next.priority })
        .where("id", "=", input.needId)
        .where("organizationId", "=", input.organizationId)
        .returning(["id", "title", "description", "priority"])
        .execute();

      // auditoria por último (segura o lock global da cadeia até o commit); só ids e os valores dos campos alterados
      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "necessidade.editada",
          entityType: "need",
          entityId: String(input.needId),
          metadata: { alteracoes: changes as unknown as Json },
        },
        trx
      );

      return { changed: true as const, need: updated };
    });

    if (!result) {
      return new Response(superjson.stringify({ message: "Necessidade não encontrada nesta organização" }), { status: 404, headers: { "Content-Type": "application/json" } });
    }
    return new Response(superjson.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao alterar a necessidade:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível alterar a necessidade");
  }
}
