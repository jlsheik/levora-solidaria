import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { runMatchingForOpportunity } from "../helpers/opportunityMatching";
import { schema } from "./allocations-decide_POST.schema";
import superjson from "superjson";

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

      let reopenedForRematch = false;
      if (input.decision === "recusada") {
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
            .where("status", "=", "reservada")
            .execute();
          reopenedForRematch = true;
        }
      }

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
    const message = error instanceof Error ? error.message : "Não foi possível registrar a decisão";
    const status = message.includes("acesso") || message.includes("papel") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
