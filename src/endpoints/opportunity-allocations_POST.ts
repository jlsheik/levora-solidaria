import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePlatformAdmin } from "../helpers/platformAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { getNeedFulfillmentBalance, computeNeedProgress } from "../helpers/needFulfillment";
import { schema } from "./opportunity-allocations_POST.schema";
import { sql } from "kysely";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse";

const ALLOCATABLE_STATUSES = ["validada", "aguardando_destinacao", "reservada"];

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);

    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    const result = await db.transaction().execute(async (trx) => {
      const opportunity = await trx
        .selectFrom("opportunityRegistry")
        .select(["id", "status", "quantity", "title"])
        .where("id", "=", input.opportunityId)
        .forUpdate()
        .executeTakeFirst();

      if (!opportunity) return { type: "not_found" as const };

      if (!ALLOCATABLE_STATUSES.includes(opportunity.status)) {
        return { type: "invalid_status" as const, status: opportunity.status };
      }

      const org = await trx
        .selectFrom("organizations")
        .select(["id", "name"])
        .where("id", "=", input.organizationId)
        .executeTakeFirst();

      if (!org) return { type: "org_not_found" as const };

      // need_id opcional (Fase 45): validado inteiramente no servidor,
      // nunca confiado do cliente. Alinhado com a mesma regra de
      // elegibilidade já aprovada no Matching 1.4 (Fase 43) — só needs
      // 'aberta' com requiredRemaining > 0 podem ser escolhidas. Quantity
      // maior que requiredRemaining continua permitido (Fase 44: vira
      // surplus, mesma política já aceita em todo o resto do sistema) —
      // não é validado aqui.
      if (input.needId !== undefined) {
        const need = await trx
          .selectFrom("needs")
          .select(["id", "organizationId", "status", "quantityNeeded"])
          .where("id", "=", input.needId)
          .executeTakeFirst();

        if (!need) return { type: "need_not_found" as const };
        if (need.organizationId !== input.organizationId) return { type: "need_org_mismatch" as const };
        if (need.status !== "aberta") return { type: "need_not_open" as const, status: need.status };

        const fulfilled = await getNeedFulfillmentBalance(trx, need.id);
        const progress = computeNeedProgress(Number(need.quantityNeeded), fulfilled);
        if (progress.requiredRemaining <= 0) return { type: "need_no_remaining" as const };
      }

      // Nunca deixamos a soma das atribuições passar da quantidade total
      // descoberta — isso é o que impede a Levora de "prometer" mais do que
      // existe, e é validado aqui, travando a linha, não só sugerido na
      // interface.
      if (opportunity.quantity !== null) {
        const allocatedRow = await trx
          .selectFrom("opportunityAllocations")
          .select((eb) => eb.fn.coalesce(eb.fn.sum("quantityAllocated"), sql<string>`0`).as("total"))
          .where("opportunityRegistryId", "=", input.opportunityId)
          .where("status", "!=", "recusada")
          .where("status", "!=", "cancelada")
          .executeTakeFirst();

        const alreadyAllocated = Number(allocatedRow?.total ?? 0);
        if (alreadyAllocated + input.quantityAllocated > Number(opportunity.quantity)) {
          return {
            type: "over_allocation" as const,
            available: Number(opportunity.quantity) - alreadyAllocated,
          };
        }
      }

      const [allocation] = await trx
        .insertInto("opportunityAllocations")
        .values({
          opportunityRegistryId: input.opportunityId,
          organizationId: input.organizationId,
          quantityAllocated: input.quantityAllocated,
          notes: input.notes || null,
          needId: input.needId ?? null,
          createdByUserId: user.id,
        })
        .returning(["id", "status"])
        .execute();

      let newOpportunityStatus = opportunity.status;
      if (opportunity.status === "validada" || opportunity.status === "aguardando_destinacao") {
        newOpportunityStatus = "reservada";
        await trx
          .updateTable("opportunityRegistry")
          .set({ status: "reservada", updatedAt: new Date() })
          .where("id", "=", input.opportunityId)
          .execute();
      }

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "atribuicao.proposta",
          entityType: "opportunity_allocation",
          entityId: String(allocation.id),
          metadata: {
            opportunityId: input.opportunityId,
            opportunityTitle: opportunity.title,
            organizationName: org.name,
            quantityAllocated: input.quantityAllocated,
            needId: input.needId ?? null,
          },
        },
        trx
      );
      await recordAuditLogEntry(
        {
          organizationId: null,
          actorUserId: user.id,
          action: "descoberta_central.atribuida",
          entityType: "opportunity_registry",
          entityId: String(input.opportunityId),
          metadata: { organizationId: input.organizationId, organizationName: org.name, quantityAllocated: input.quantityAllocated },
        },
        trx
      );

      return { type: "success" as const, allocation, opportunityStatus: newOpportunityStatus };
    });

    if (result.type === "not_found") {
      return new Response(superjson.stringify({ message: "Descoberta não encontrada" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "org_not_found") {
      return new Response(superjson.stringify({ message: "Organização não encontrada" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "need_not_found") {
      return new Response(superjson.stringify({ message: "Necessidade não encontrada" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "need_org_mismatch") {
      return new Response(superjson.stringify({ message: "Esta necessidade não pertence à organização selecionada" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "need_not_open") {
      return new Response(
        superjson.stringify({ message: `Esta necessidade não está aberta (status: ${result.status}) e não pode ser selecionada` }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }
    if (result.type === "need_no_remaining") {
      return new Response(
        superjson.stringify({ message: "Esta necessidade não tem mais saldo pendente pela rede (requiredRemaining=0)" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }
    if (result.type === "invalid_status") {
      return new Response(
        superjson.stringify({ message: `Descoberta com status "${result.status}" não pode ser atribuída agora` }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }
    if (result.type === "over_allocation") {
      return new Response(
        superjson.stringify({ message: `Quantidade excede o disponível. Restam ${result.available} para atribuir.` }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      superjson.stringify({ allocation: result.allocation, opportunityStatus: result.opportunityStatus }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao atribuir oportunidade:", error);
    return buildErrorResponse(error, "Não foi possível atribuir a oportunidade");
  }
}
