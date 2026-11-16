import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { needCorrelation, allocationCorrelation, destinationCorrelation } from "../helpers/journeyCorrelation.js";
import { runMatchingForOpportunity } from "../helpers/opportunityMatching.js";
import { reopenOpportunityIfNoActiveAllocations } from "../helpers/reopenOpportunity.js";
import { concludeOpportunityIfAllTerminalAndReceived } from "../helpers/concludeOpportunity.js";
import { schema } from "./allocations-decide_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

// Estados em que a oferta (oportunidade) já foi encerrada: nenhuma proposta dela pode ser aceita.
const CLOSED_OFFER_STATUSES: string[] = ["expirada", "cancelada", "recusada", "bloqueada", "duplicada", "concluida"];

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "atribuicoes.decida");

    const result = await db.transaction().execute(async (trx) => {
      const allocation = await trx
        .selectFrom("opportunityAllocations")
        .select(["id", "status", "opportunityRegistryId"])
        .where("id", "=", input.allocationId)
        .where("organizationId", "=", input.organizationId)
        .forUpdate()
        .executeTakeFirst();

      if (!allocation) return { type: "not_found" as const };
      if (allocation.status !== "proposta") {
        return { type: "invalid_status" as const, status: allocation.status };
      }

      // Fase 98: aceitar exige que a OFERTA ainda exista como oferta. Lido sob a trava da linha da oportunidade (ordem: atribuição → oportunidade, a mesma dos outros
      // caminhos). Se o cancelamento/expiração da oferta venceu a disputa, a proposta já foi encerrada junto com ela (ou é um resíduo antigo): não pode mais ser aceita.
      // Recusar continua permitido.
      if (input.decision === "aceita") {
        const offer = await trx.selectFrom("opportunityRegistry").select("status").where("id", "=", allocation.opportunityRegistryId).forUpdate().executeTakeFirst();
        if (!offer || CLOSED_OFFER_STATUSES.includes(offer.status)) return { type: "offer_closed" as const };
      }

      const [updated] = await trx
        .updateTable("opportunityAllocations")
        .set({ status: input.decision, decidedByUserId: user.id, updatedAt: new Date() })
        .where("id", "=", input.allocationId)
        .returning(["id", "status"])
        .execute();

      if (input.decision === "aceita") {
        await trx
          .updateTable("opportunityRegistry")
          .set({ status: "atribuida", updatedAt: new Date() })
          .where("id", "=", allocation.opportunityRegistryId)
          .where("status", "=", "reservada")
          .execute();
      }

      // Recusar pode CONCLUIR a oportunidade (se já existir uma allocation
      // irmã "recebida" e esta recusa fizer todas ficarem terminais —
      // achado de auditoria: antes, só allocations-receive_POST checava
      // essa condição) ou REABRIR (se nenhuma foi recebida ainda). As duas
      // condições são mutuamente exclusivas pelos mesmos dados — tenta
      // concluir primeiro; só tenta reabrir se não concluiu. Ambos os
      // helpers travam a linha da oportunidade ANTES de qualquer
      // recordAuditLogEntry desta transação (que trava o advisory lock
      // GLOBAL da auditoria) — mesma ordem em toda a transação, evitando o
      // deadlock que a Fase 27 encontrou.
      let concluded = false;
      let reopenedForRematch = false;
      if (input.decision === "recusada") {
        concluded = await concludeOpportunityIfAllTerminalAndReceived(trx, allocation.opportunityRegistryId);
        if (!concluded) {
          reopenedForRematch = await reopenOpportunityIfNoActiveAllocations(trx, allocation.opportunityRegistryId);
        }
      }

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: input.decision === "aceita" ? "atribuicao.aceita" : "atribuicao.recusada",
          outcome: "concluida", // a DECISÃO foi registrada (aceita/recusada está na ação); não é falha nem pendência
          correlationId: await allocationCorrelation(trx, input.allocationId),
          entityType: "opportunity_allocation",
          entityId: String(input.allocationId),
          metadata: { opportunityRegistryId: allocation.opportunityRegistryId },
        },
        trx
      );

      if (concluded) {
        await recordAuditLogEntry(
          {
            organizationId: null,
            actorUserId: user.id,
            action: "descoberta_central.concluida",
            outcome: "concluida",
            entityType: "opportunity_registry",
            entityId: String(allocation.opportunityRegistryId),
            metadata: {},
          },
          trx
        );
      }

      return { type: "success" as const, allocation: updated, opportunityRegistryId: allocation.opportunityRegistryId, reopenedForRematch };
    });

    if (result.type === "not_found") {
      return new Response(superjson.stringify({ message: "Atribuição não encontrada" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "offer_closed") {
      return new Response(
        superjson.stringify({ message: "A oferta desta atribuição foi encerrada e a proposta não pode mais ser aceita" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }
    if (result.type === "invalid_status") {
      return new Response(
        superjson.stringify({ message: `Esta atribuição já foi decidida (status: ${result.status})` }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    if (result.reopenedForRematch) {
      await runMatchingForOpportunity(result.opportunityRegistryId, user.id, "reabertura");
    }

    return new Response(superjson.stringify({ allocation: result.allocation }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao decidir atribuição:", error);
    return buildErrorResponse(error, "Não foi possível registrar a decisão");
  }
}
