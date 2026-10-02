import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { schema } from "./opportunities-status_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse, ConflictError } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "oportunidades.gerencie");

    if (input.linkedNeedId) {
      const need = await db
        .selectFrom("needs")
        .select(["id"])
        .where("id", "=", input.linkedNeedId)
        .where("organizationId", "=", input.organizationId)
        .executeTakeFirst();
      if (!need) {
        return new Response(
          superjson.stringify({ message: "Necessidade informada não pertence a esta organização" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const result = await db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("donationOpportunities")
        .select(["id", "status", "title", "linkedNeedId"])
        .where("id", "=", input.opportunityId)
        .where("organizationId", "=", input.organizationId)
        .executeTakeFirst();

      if (!existing) return null;

      // "recebida" só é atingido pelo endpoint dedicado de recebimento, que
      // exige item e quantidade reais e gera a entrada de estoque
      // correspondente — nunca por uma simples troca de status.
      if (existing.status === "recebida") {
        throw new ConflictError("Esta oportunidade já foi recebida e não pode ter o status alterado por aqui");
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (input.status) updates.status = input.status;
      if (input.linkedNeedId !== undefined) updates.linkedNeedId = input.linkedNeedId;

      const [updated] = await trx
        .updateTable("donationOpportunities")
        .set(updates as never)
        .where("id", "=", input.opportunityId)
        .returning(["id", "status", "linkedNeedId"])
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "oportunidade.atualizada",
          entityType: "donation_opportunity",
          entityId: String(input.opportunityId),
          metadata: {
            title: existing.title,
            statusAnterior: existing.status,
            statusNovo: input.status ?? existing.status,
            linkedNeedIdAnterior: existing.linkedNeedId,
            linkedNeedIdNovo: input.linkedNeedId !== undefined ? input.linkedNeedId : existing.linkedNeedId,
          },
        },
        trx
      );

      return updated;
    });

    if (!result) {
      return new Response(
        superjson.stringify({ message: "Oportunidade não encontrada nesta organização" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(superjson.stringify({ opportunity: result }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao atualizar oportunidade:", error);
    // Fase 65: trocado o `msg.includes("recebida") ? 409 : undefined` (o
    // mesmo padrão frágil de comparar TEXTO de mensagem que este arquivo
    // documenta no topo como já tendo sido eliminado — não tinha sido,
    // neste único lugar) por ConflictError, reconhecido por tipo em
    // buildErrorResponse. Também corrige uma quebra real que essa
    // comparação de texto teria sofrido com a correção desta mesma fase
    // (erros não tipados não expõem mais `error.message` ao cliente, então
    // "recebida" nunca mais apareceria na mensagem pública para o
    // `.includes()` encontrar).
    return buildErrorResponse(error, "Não foi possível atualizar a oportunidade");
  }
}
