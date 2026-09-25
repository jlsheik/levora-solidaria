import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePermission, OrganizationAccessError } from "../helpers/organizationAccess";
import { roleHasPermission } from "../helpers/permissions";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { getItemStockBalance } from "../helpers/stockBalance";
import { schema } from "./needs-status_POST.schema";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    const membership = await requirePermission(user.id, input.organizationId, "necessidades.gerencie");

    // Marcar como "atendida" pode disparar baixa automática de estoque (ver
    // abaixo) — uma mutação de estoque de verdade, não só de necessidade.
    // Exige explicitamente inventario.lance também, em vez de confiar que
    // todo papel com necessidades.gerencie sempre vai ter inventario.lance
    // (verdade hoje em src/helpers/permissions.tsx, mas não uma garantia
    // que este endpoint deveria depender silenciosamente do catálogo nunca
    // mudar).
    if (input.status === "atendida" && !roleHasPermission(membership.role, "inventario.lance")) {
      throw new OrganizationAccessError("Seu papel nesta organização não permite dar baixa em estoque, necessária para marcar esta necessidade como atendida");
    }

    const result = await db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("needs")
        .select(["id", "status", "title", "itemId", "quantityNeeded", "unit"])
        .where("id", "=", input.needId)
        .where("organizationId", "=", input.organizationId)
        .executeTakeFirst();

      if (!existing) return { type: "not_found" as const };

      // Vínculo automático necessidade→estoque (master prompt, "estoque
      // atualizado" nunca sem transação registrada): só dispara na
      // transição PARA "atendida" vinda de outro status, e só quando a
      // necessidade está vinculada a um item de inventário. Reverter o
      // status depois NÃO desfaz a saída automaticamente — isso exigiria um
      // lançamento manual explícito (ajuste), para nunca alterar o
      // histórico de estoque em silêncio.
      const willConsumeStock = input.status === "atendida" && existing.status !== "atendida" && existing.itemId !== null;
      let stockAuditEntry: { itemId: number; itemName: string; delta: number } | null = null;

      if (willConsumeStock) {
        const item = await trx
          .selectFrom("inventoryItems")
          .select(["id", "name"])
          .where("id", "=", existing.itemId!)
          .where("organizationId", "=", input.organizationId)
          .forUpdate()
          .executeTakeFirst();

        // Item foi excluído/movido depois que a necessidade foi criada —
        // não impede marcar como atendida, mas não há como dar baixa.
        if (item) {
          const currentStock = await getItemStockBalance(trx, item.id);
          const quantity = Number(existing.quantityNeeded);
          const newStock = currentStock - quantity;

          if (newStock < 0) {
            return { type: "insufficient_stock" as const, currentStock, quantity, itemName: item.name };
          }

          await trx
            .insertInto("stockTransactions")
            .values({
              organizationId: input.organizationId,
              itemId: item.id,
              type: "saida",
              delta: -quantity,
              reason: `Baixa automática: necessidade "${existing.title}" marcada como atendida`,
              createdByUserId: user.id,
            })
            .execute();

          stockAuditEntry = { itemId: item.id, itemName: item.name, delta: -quantity };
        }
      }

      const [updated] = await trx
        .updateTable("needs")
        .set({ status: input.status, updatedAt: new Date() })
        .where("id", "=", input.needId)
        .returning(["id", "status"])
        .execute();

      // As duas gravações de auditoria ficam juntas, no fim da transação —
      // recordAuditLogEntry segura um advisory lock global até o commit
      // (ver comentário em auditLog.tsx), então quanto menos trabalho
      // acontecer DEPOIS dela dentro desta transação, menos tempo outras
      // transações que também precisam gravar em audit_log ficam esperando.
      if (stockAuditEntry) {
        await recordAuditLogEntry(
          {
            organizationId: input.organizationId,
            actorUserId: user.id,
            action: "inventario.saida_registrada",
            entityType: "inventory_item",
            entityId: String(stockAuditEntry.itemId),
            metadata: { delta: stockAuditEntry.delta, itemName: stockAuditEntry.itemName, motivo: "necessidade_atendida", needId: existing.id },
          },
          trx
        );
      }

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "necessidade.status_alterado",
          entityType: "need",
          entityId: String(input.needId),
          metadata: { title: existing.title, statusAnterior: existing.status, statusNovo: input.status, baixaEstoqueAutomatica: willConsumeStock },
        },
        trx
      );

      return { type: "success" as const, need: updated };
    });

    if (result.type === "not_found") {
      return new Response(
        superjson.stringify({ message: "Necessidade não encontrada nesta organização" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    if (result.type === "insufficient_stock") {
      return new Response(
        superjson.stringify({
          message: `Não é possível marcar como atendida: o item "${result.itemName}" tem saldo de ${result.currentStock}, insuficiente para a quantidade necessária de ${result.quantity}. Ajuste o estoque ou a quantidade antes de tentar novamente.`,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(superjson.stringify({ need: result.need }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao atualizar necessidade:", error);
    return buildErrorResponse(error, "Não foi possível atualizar a necessidade");
  }
}
