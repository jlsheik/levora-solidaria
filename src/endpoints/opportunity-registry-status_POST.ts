import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { closeOpenProposals, countInProgressAllocations, lockOfferAllocations } from "../helpers/offerClosure.js";
import { runMatchingForOpportunity } from "../helpers/opportunityMatching.js";
import { schema } from "./opportunity-registry-status_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

// Máquina de estados validada no servidor — a interface pode sugerir o
// próximo passo, mas é esta tabela que decide o que é permitido.
// "reservada", "atribuida" e "concluida" não aparecem aqui: são
// consequência de criar/decidir/receber uma atribuição (ver
// opportunity-allocations*), nunca de uma troca de status manual.
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  descoberta: ["em_verificacao", "cancelada", "bloqueada", "duplicada"],
  em_verificacao: ["validada", "recusada", "cancelada", "bloqueada", "duplicada"],
  validada: ["aguardando_destinacao", "expirada", "cancelada"],
  aguardando_destinacao: ["expirada", "cancelada"],
  reservada: ["cancelada", "expirada"],
};

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);

    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    const result = await db.transaction().execute(async (trx) => {
      // Fase 98: ordem de travas atribuições → oportunidade (a mesma de decisão/logística/recebimento/expiração), para que uma aceitação concorrente e o encerramento da
      // oferta se serializem sem deadlock: quem obtiver as travas primeiro vence e o outro lê o estado confirmado.
      await lockOfferAllocations(trx, input.opportunityId);
      const existing = await trx
        .selectFrom("opportunityRegistry")
        .select(["id", "status", "title"])
        .where("id", "=", input.opportunityId)
        .forUpdate()
        .executeTakeFirst();

      if (!existing) return { type: "not_found" as const };

      const allowed = ALLOWED_TRANSITIONS[existing.status] ?? [];
      if (!allowed.includes(input.status)) {
        return { type: "invalid_transition" as const, from: existing.status };
      }

      // Encerrar a oferta (cancelar/expirar) com atribuição EM ANDAMENTO não é permitido (mesma proteção da Fase 95); com propostas pendentes, elas são encerradas
      // junto, na mesma transação (nunca ficam aceitáveis numa oferta encerrada).
      const closing = input.status === "cancelada" || input.status === "expirada";
      if (closing && (await countInProgressAllocations(trx, input.opportunityId)) > 0) return { type: "in_progress" as const };

      const [updated] = await trx
        .updateTable("opportunityRegistry")
        .set({ status: input.status, statusReason: input.reason || null, updatedAt: new Date() })
        .where("id", "=", input.opportunityId)
        .returning(["id", "status"])
        .execute();

      const closedProposals = closing
        ? await closeOpenProposals(trx, input.opportunityId, input.status === "cancelada" ? "oferta_cancelada_admin" : "oferta_expirada_admin", user.id)
        : [];

      await recordAuditLogEntry(
        {
          organizationId: null,
          actorUserId: user.id,
          action: "descoberta_central.status_alterado",
          entityType: "opportunity_registry",
          entityId: String(input.opportunityId),
          metadata: { title: existing.title, statusAnterior: existing.status, statusNovo: input.status, motivo: input.reason ?? null, ...(closedProposals.length > 0 ? { propostasEncerradas: closedProposals } : {}) },
        },
        trx
      );

      return { type: "success" as const, opportunity: updated, closedProposals: closedProposals.length };
    });

    if (result.type === "not_found") {
      return new Response(superjson.stringify({ message: "Descoberta não encontrada" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "in_progress") {
      return new Response(
        superjson.stringify({ message: "Há atribuição em andamento (aceita, em coleta ou em transporte) nesta oferta; ela não pode ser encerrada agora" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }
    if (result.type === "invalid_transition") {
      return new Response(
        superjson.stringify({ message: `Não é possível ir de "${result.from}" para "${input.status}" diretamente` }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    // Entrar em "aguardando destinação" dispara o matching automático na
    // hora — não fica esperando um humano escolher a organização.
    if (input.status === "aguardando_destinacao") {
      await runMatchingForOpportunity(input.opportunityId, user.id, "mudanca_de_estado");
    }

    return new Response(superjson.stringify({ opportunity: result.opportunity, closedProposals: result.closedProposals }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao atualizar status da descoberta:", error);
    return buildErrorResponse(error, "Não foi possível atualizar a descoberta");
  }
}
