import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { runMatchingForOpportunity } from "../helpers/opportunityMatching";
import { schema } from "./allocations-logistics_POST.schema";
import superjson from "superjson";

// De onde para onde cada evento pode levar o status da atribuição. Registrar
// um evento fora daqui é rejeitado — a linha do tempo de logística não é
// só um log, ela decide o estado real.
const TRANSITIONS: Record<string, Record<string, string>> = {
  aceita: { coleta_agendada: "em_coleta", cancelado: "cancelada" },
  em_coleta: { coleta_concluida: "em_coleta", transporte_iniciado: "em_transporte", cancelado: "cancelada" },
  em_transporte: { cancelado: "cancelada" },
};

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requireOrganizationMembership(user.id, input.organizationId, [
      "proprietario",
      "administrador",
      "operador",
    ]);

    const result = await db.transaction().execute(async (trx) => {
      const allocation = await trx
        .selectFrom("opportunityAllocations")
        .select(["id", "status", "opportunityRegistryId"])
        .where("id", "=", input.allocationId)
        .where("organizationId", "=", input.organizationId)
        .forUpdate()
        .executeTakeFirst();

      if (!allocation) return { type: "not_found" as const };

      const nextStatus = TRANSITIONS[allocation.status]?.[input.eventType];
      if (!nextStatus) {
        return { type: "invalid_transition" as const, from: allocation.status };
      }

      if (nextStatus !== allocation.status) {
        await trx
          .updateTable("opportunityAllocations")
          .set({ status: nextStatus as never, updatedAt: new Date() })
          .where("id", "=", input.allocationId)
          .execute();
      }

      await trx
        .insertInto("logisticsEvents")
        .values({
          opportunityAllocationId: input.allocationId,
          organizationId: input.organizationId,
          eventType: input.eventType,
          scheduledFor: input.scheduledFor ?? null,
          notes: input.notes ?? null,
          actorUserId: user.id,
        })
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: `logistica.${input.eventType}`,
          entityType: "opportunity_allocation",
          entityId: String(input.allocationId),
          metadata: { statusAnterior: allocation.status, statusNovo: nextStatus },
        },
        trx
      );

      let reopenOpportunityId: number | null = null;
      if (input.eventType === "cancelado") {
        const remainingActive = await trx
          .selectFrom("opportunityAllocations")
          .select((eb) => eb.fn.countAll().as("count"))
          .where("opportunityRegistryId", "=", allocation.opportunityRegistryId)
          .where("status", "!=", "recusada")
          .where("status", "!=", "cancelada")
          .executeTakeFirst();

        if (Number(remainingActive?.count ?? 0) === 0) {
          await trx
            .updateTable("opportunityRegistry")
            .set({ status: "aguardando_destinacao", updatedAt: new Date() })
            .where("id", "=", allocation.opportunityRegistryId)
            .execute();
          reopenOpportunityId = allocation.opportunityRegistryId;
        }
      }

      return { type: "success" as const, status: nextStatus, reopenOpportunityId };
    });

    if (result.type === "not_found") {
      return new Response(superjson.stringify({ message: "Atribuição não encontrada" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "invalid_transition") {
      return new Response(
        superjson.stringify({ message: `Não é possível registrar "${input.eventType}" com a atribuição em status "${result.from}"` }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    if (result.reopenOpportunityId) {
      await runMatchingForOpportunity(result.reopenOpportunityId, user.id);
    }

    return new Response(superjson.stringify({ allocation: { id: input.allocationId, status: result.status } }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao registrar evento de logística:", error);
    const message = error instanceof Error ? error.message : "Não foi possível registrar o evento";
    const status = message.includes("acesso") || message.includes("papel") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
