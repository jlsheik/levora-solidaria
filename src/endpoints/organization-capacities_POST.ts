import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePermission } from "../helpers/organizationAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { schema } from "./organization-capacities_POST.schema";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse";

/**
 * Cria ou atualiza o teto de capacidade para uma (categoria, unidade) da
 * própria organização — nunca um contador que sobe/desce sozinho (ver
 * db/schema.sql, comentário de organization_capacities). "Disponível" é
 * calculado por quem consome este dado (o motor de matching), nunca
 * armazenado aqui, para não duplicar a fonte de verdade que já existe em
 * stock_transactions/inventory_items.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "organizacao.gerencie");

    const capacity = await db.transaction().execute(async (trx) => {
      const [row] = await trx
        .insertInto("organizationCapacities")
        .values({
          organizationId: input.organizationId,
          category: input.category,
          unit: input.unit,
          maxCapacity: input.maxCapacity,
          createdByUserId: user.id,
        })
        .onConflict((oc) =>
          oc.columns(["organizationId", "category", "unit"]).doUpdateSet({ maxCapacity: input.maxCapacity, updatedAt: new Date() })
        )
        .returning(["id", "category", "unit", "maxCapacity"])
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "organizacao.capacidade_alterada",
          entityType: "organization_capacity",
          entityId: String(row.id),
          metadata: { category: input.category, unit: input.unit, maxCapacity: input.maxCapacity },
        },
        trx
      );

      return row;
    });

    return new Response(
      superjson.stringify({ capacity: { ...capacity, maxCapacity: Number(capacity.maxCapacity) } }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao salvar capacidade:", error);
    return buildErrorResponse(error, "Não foi possível salvar a capacidade");
  }
}
