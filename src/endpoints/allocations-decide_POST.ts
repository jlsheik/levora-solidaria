import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePermission } from "../helpers/organizationAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { runMatchingForOpportunity } from "../helpers/opportunityMatching";
import { reopenOpportunityIfNoActiveAllocations } from "../helpers/reopenOpportunity";
import { schema } from "./allocations-decide_POST.schema";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse";

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

      // reopenOpportunityIfNoActiveAllocations trava a linha da oportunidade
      // ANTES de contar atribuições-irmãs ainda ativas — serializa essa
      // decisão contra qualquer outra transação concorrente terminando uma
      // atribuição diferente da mesma oportunidade (achado de auditoria:
      // sem essa travação, duas transações concorrentes podiam cada uma ver
      // a outra ainda "ativa" e nenhuma reabrir a oportunidade).
      const reopenedForRematch =
        input.decision === "recusada"
          ? await reopenOpportunityIfNoActiveAllocations(trx, allocation.opportunityRegistryId)
          : false;

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: input.decision === "aceita" ? "atribuicao.aceita" : "atribuicao.recusada",
          entityType: "opportunity_allocation",
          entityId: String(input.allocationId),
          metadata: { opportunityRegistryId: allocation.opportunityRegistryId },
        },
        trx
      );

      return { type: "success" as const, allocation: updated, opportunityRegistryId: allocation.opportunityRegistryId, reopenedForRematch };
    });

    if (result.type === "not_found") {
      return new Response(superjson.stringify({ message: "Atribuição não encontrada" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "invalid_status") {
      return new Response(
        superjson.stringify({ message: `Esta atribuição já foi decidida (status: ${result.status})` }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    if (result.reopenedForRematch) {
      await runMatchingForOpportunity(result.opportunityRegistryId, user.id);
    }

    return new Response(superjson.stringify({ allocation: result.allocation }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao decidir atribuição:", error);
    return buildErrorResponse(error, "Não foi possível registrar a decisão");
  }
}
