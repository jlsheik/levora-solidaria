import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { createApprovalRequest } from "../helpers/approvals.js";
import { getItemStockBalance } from "../helpers/stockBalance.js";
import { schema } from "./stock-transactions_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

// Ajuste negativo (redução de estoque sem uma saída rastreável por
// distribuição/entrega) é o vetor de fraude mais óbvio deste sistema —
// alguém reduz o saldo "no ajuste" para encobrir desvio. Acima deste
// limite, a ação não executa sozinha: vira um pedido de dupla
// autorização, que uma SEGUNDA pessoa da organização precisa aprovar.
const HIGH_RISK_ADJUSTMENT_ABSOLUTE = 20;
const HIGH_RISK_ADJUSTMENT_RATIO = 0.3;

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "inventario.lance");

    const result = await db.transaction().execute(async (trx) => {
      // Trava a linha do item para serializar lançamentos concorrentes do
      // mesmo item e evitar condição de corrida no cálculo de saldo.
      const item = await trx
        .selectFrom("inventoryItems")
        .select(["id", "name", "organizationId"])
        .where("id", "=", input.itemId)
        .forUpdate()
        .executeTakeFirst();

      if (!item || item.organizationId !== input.organizationId) {
        return { type: "not_found" as const };
      }

      const currentStock = await getItemStockBalance(trx, input.itemId);

      let delta: number;
      if (input.type === "entrada") {
        delta = Math.abs(input.quantity);
      } else if (input.type === "saida") {
        delta = -Math.abs(input.quantity);
      } else {
        delta = input.quantity;
      }

      const newStock = currentStock + delta;
      if (newStock < 0) {
        return { type: "insufficient_stock" as const, currentStock };
      }

      const isHighRiskAdjustment =
        input.type === "ajuste" &&
        delta < 0 &&
        (Math.abs(delta) >= HIGH_RISK_ADJUSTMENT_ABSOLUTE ||
          (currentStock > 0 && Math.abs(delta) >= currentStock * HIGH_RISK_ADJUSTMENT_RATIO));

      if (isHighRiskAdjustment) {
        const approval = await createApprovalRequest(
          {
            actionType: "ajuste_estoque_alto_risco",
            organizationId: input.organizationId,
            payload: { organizationId: input.organizationId, itemId: input.itemId, type: input.type, quantity: input.quantity, reason: input.reason },
            reason: `Redução de ${Math.abs(delta)} em "${item.name}" (saldo atual: ${currentStock}) — acima do limite de ajuste sem segunda aprovação`,
            requestedByUserId: user.id,
          },
          trx
        );

        await recordAuditLogEntry(
          {
            organizationId: input.organizationId,
            actorUserId: user.id,
            action: "inventario.ajuste_pendente_aprovacao",
            entityType: "inventory_item",
            entityId: String(input.itemId),
            metadata: { delta, reason: input.reason, itemName: item.name, approvalRequestId: approval.id },
          },
          trx
        );

        return { type: "requires_approval" as const, approvalRequestId: approval.id };
      }

      const [tx] = await trx
        .insertInto("stockTransactions")
        .values({
          organizationId: input.organizationId,
          itemId: input.itemId,
          type: input.type,
          delta,
          reason: input.reason,
          createdByUserId: user.id,
        })
        .returning(["id", "itemId", "type", "delta", "reason", "createdAt"])
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action:
            input.type === "entrada"
              ? "inventario.entrada_registrada"
              : input.type === "saida"
                ? "inventario.saida_registrada"
                : "inventario.ajuste_registrado",
          entityType: "inventory_item",
          entityId: String(input.itemId),
          metadata: { delta, reason: input.reason, itemName: item.name },
        },
        trx
      );

      return { type: "success" as const, tx, newStock };
    });

    if (result.type === "not_found") {
      return new Response(
        superjson.stringify({ message: "Item de inventário não encontrado nesta organização" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    if (result.type === "insufficient_stock") {
      return new Response(
        superjson.stringify({
          message: `Estoque insuficiente: saldo atual é ${result.currentStock}, a saída solicitada deixaria o saldo negativo`,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    if (result.type === "requires_approval") {
      return new Response(
        superjson.stringify({
          message: "Este ajuste reduz o estoque acima do limite permitido sem uma segunda aprovação. Foi criado um pedido de aprovação — outra pessoa com papel de proprietário ou administrador desta organização precisa aprovar antes que a movimentação seja registrada.",
          approvalRequestId: result.approvalRequestId,
        }),
        { status: 202, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      superjson.stringify({
        transaction: {
          id: String(result.tx.id),
          itemId: result.tx.itemId,
          type: result.tx.type,
          delta: Number(result.tx.delta),
          reason: result.tx.reason,
          createdAt: result.tx.createdAt.toString(),
        },
        newStock: result.newStock,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao registrar lançamento de estoque:", error);
    return buildErrorResponse(error, "Não foi possível registrar o lançamento");
  }
}
