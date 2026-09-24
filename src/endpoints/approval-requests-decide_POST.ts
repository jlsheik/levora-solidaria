import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { recordAuditLogEntry } from "../helpers/auditLog";
import { schema } from "./approval-requests-decide_POST.schema";
import { sql } from "kysely";
import superjson from "superjson";
import type { Json } from "../helpers/schema";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requireOrganizationMembership(user.id, input.organizationId, ["proprietario", "administrador"]);

    const result = await db.transaction().execute(async (trx) => {
      const req = await trx
        .selectFrom("approvalRequests")
        .select(["id", "status", "actionType", "payload", "requestedByUserId"])
        .where("id", "=", input.requestId)
        .where("organizationId", "=", input.organizationId)
        .forUpdate()
        .executeTakeFirst();

      if (!req) return { type: "not_found" as const };
      if (req.status !== "pendente") return { type: "invalid_status" as const, status: req.status };

      // O princípio central da dupla autorização: quem pediu não pode
      // aprovar o próprio pedido, nunca — nem sendo proprietário.
      if (req.requestedByUserId === user.id) {
        return { type: "self_approval" as const };
      }

      const [updated] = await trx
        .updateTable("approvalRequests")
        .set({ status: input.decision, decidedByUserId: user.id, decisionNotes: input.notes ?? null, decidedAt: new Date() })
        .where("id", "=", input.requestId)
        .returning(["id", "status"])
        .execute();

      if (input.decision === "aprovada") {
        // Reexecuta a ação real — hoje só existe um tipo de ação de alto
        // risco (ajuste de estoque); novos tipos entram aqui.
        if (req.actionType === "ajuste_estoque_alto_risco") {
          const payload = req.payload as { organizationId: number; itemId: number; type: "ajuste"; quantity: number; reason: string };

          const item = await trx
            .selectFrom("inventoryItems")
            .select(["id", "name", "organizationId"])
            .where("id", "=", payload.itemId)
            .forUpdate()
            .executeTakeFirst();

          if (!item || item.organizationId !== payload.organizationId) {
            return { type: "payload_invalid" as const };
          }

          await trx
            .insertInto("stockTransactions")
            .values({
              organizationId: payload.organizationId,
              itemId: payload.itemId,
              type: "ajuste",
              delta: payload.quantity,
              reason: `${payload.reason} (aprovado por segunda pessoa: ${user.displayName})`,
              createdByUserId: req.requestedByUserId,
            })
            .execute();

          await recordAuditLogEntry(
            {
              organizationId: payload.organizationId,
              actorUserId: user.id,
              action: "inventario.ajuste_aprovado_e_executado",
              entityType: "inventory_item",
              entityId: String(payload.itemId),
              metadata: { approvalRequestId: req.id, delta: payload.quantity, itemName: item.name },
            },
            trx
          );
        }
      } else {
        await recordAuditLogEntry(
          {
            organizationId: input.organizationId,
            actorUserId: user.id,
            action: "aprovacao.rejeitada",
            entityType: "approval_request",
            entityId: String(req.id),
            metadata: { actionType: req.actionType, notes: input.notes ?? null },
          },
          trx
        );
      }

      return { type: "success" as const, request: updated };
    });

    if (result.type === "not_found") {
      return new Response(superjson.stringify({ message: "Pedido de aprovação não encontrado" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "invalid_status") {
      return new Response(superjson.stringify({ message: `Este pedido já foi decidido (status: ${result.status})` }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "self_approval") {
      return new Response(
        superjson.stringify({ message: "Quem solicitou a ação não pode aprovar o próprio pedido — outra pessoa da organização precisa decidir" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }
    if (result.type === "payload_invalid") {
      return new Response(superjson.stringify({ message: "Não foi possível executar a ação: item de inventário não encontrado" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(superjson.stringify({ request: result.request }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao decidir pedido de aprovação:", error);
    const message = error instanceof Error ? error.message : "Não foi possível registrar a decisão";
    const status = message.includes("acesso") || message.includes("papel") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
