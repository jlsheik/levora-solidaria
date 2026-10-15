import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { getItemStockBalance } from "../helpers/stockBalance.js";
import { APPROVAL_REQUEST_EXPIRATION_DAYS } from "../helpers/expireApprovalRequests.js";
import { buildLedgerAuditEntry, executeApprovedLedgerRequest, isLedgerApprovalActionType, type ApprovedLedgerResult } from "../helpers/needFulfillmentCorrections.js";
import { DESTINATION_APPROVAL_ACTION, executeApprovedDestinationRequest, markDestinationRequestRejected } from "../helpers/stockExit.js";
import { schema } from "./approval-requests-decide_POST.schema.js";
import superjson from "superjson";
import type { Json } from "../helpers/schema.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "aprovacoes.decida");

    const result = await db.transaction().execute(async (trx) => {
      const req = await trx
        .selectFrom("approvalRequests")
        .select(["id", "status", "actionType", "payload", "requestedByUserId", "organizationId", "createdAt"])
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

      // Pré-valida TUDO antes de tocar em approvalRequests.status — um
      // `return` normal aqui não desfaz nada já escrito na transação (só
      // uma exceção lançada faria rollback). Se a validação rodasse DEPOIS
      // do update de status, uma falha de validação deixaria o pedido
      // marcado como "aprovada" para sempre (não pode mais ser decidido de
      // novo, já que exige status "pendente"), mas sem a ação de fato ter
      // acontecido — um estado inconsistente silencioso.
      let stockAdjustment: { payload: { organizationId: number; itemId: number; type: "ajuste"; quantity: number; reason: string }; itemName: string } | null = null;

      if (input.decision === "aprovada" && req.actionType === "ajuste_estoque_alto_risco") {
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

        // Revalida o saldo no momento da APROVAÇÃO, não só no momento do
        // pedido — outras movimentações podem ter acontecido no meio
        // tempo (o pedido pode ficar dias pendente). Sem isto, aprovar um
        // ajuste negativo antigo poderia levar o estoque a negativo,
        // exatamente o que stock-transactions_POST.ts impede no
        // lançamento direto.
        const currentStock = await getItemStockBalance(trx, payload.itemId);
        const newStock = currentStock + payload.quantity;

        if (newStock < 0) {
          return { type: "insufficient_stock" as const, currentStock, itemName: item.name };
        }

        stockAdjustment = { payload, itemName: item.name };
      }

      // Pedidos do ledger de atendimento (Fase 78): a execução acontece AQUI,
      // na transação da decisão, sob a ordem global de locks (pedido já
      // travado acima → allocation → need → ledger → auditoria por último).
      // Tudo é validado ANTES de mudar o status: obsoleto/expirado/inválido
      // devolvem 409 sem escrever nada e o pedido continua `pendente`.
      let ledgerExecution: Extract<ApprovedLedgerResult, { type: "executed" }> | null = null;
      if (input.decision === "aprovada" && isLedgerApprovalActionType(req.actionType)) {
        const expirationCutoff = Date.now() - APPROVAL_REQUEST_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;
        if (req.createdAt.getTime() < expirationCutoff) return { type: "pedido_expirado" as const };

        const executed = await executeApprovedLedgerRequest(trx, req);
        if (executed.type === "payload_invalid") return { type: "ledger_payload_invalid" as const };
        if (executed.type === "pedido_obsoleto") return { type: "pedido_obsoleto" as const };
        if (executed.type === "insufficient_stock") return { type: "insufficient_stock" as const, currentStock: executed.currentStock, itemName: executed.itemName };
        ledgerExecution = executed;
      }

      // Saída de estoque com destinação (Fase 99E): a execução acontece AQUI, na transação da aprovação, reavaliando o estado atual; erro devolve 409/4xx sem escrever nada.
      let destinationAudit: ((t: typeof trx) => Promise<void>) | null = null;
      if (input.decision === "aprovada" && req.actionType === DESTINATION_APPROVAL_ACTION) {
        const executed = await executeApprovedDestinationRequest(trx, req, user.id);
        if (executed.type === "payload_invalid") return { type: "destination_payload_invalid" as const };
        if (executed.type === "error") return { type: "destination_error" as const, status: executed.status, message: executed.message, code: executed.code };
        destinationAudit = executed.run;
      }

      const [updated] = await trx
        .updateTable("approvalRequests")
        .set({ status: input.decision, decidedByUserId: user.id, decisionNotes: input.notes ?? null, decidedAt: new Date() })
        .where("id", "=", input.requestId)
        .returning(["id", "status"])
        .execute();

      if (input.decision === "aprovada" && destinationAudit) {
        await destinationAudit(trx);
      } else if (input.decision === "aprovada" && ledgerExecution) {
        const audit = buildLedgerAuditEntry(ledgerExecution.plan, ledgerExecution.result, {
          actorUserId: user.id,
          reason: ledgerExecution.payload.motivo,
          approvalRequestId: req.id,
          requesterUserId: req.requestedByUserId,
        });
        await recordAuditLogEntry(
          {
            organizationId: input.organizationId,
            actorUserId: user.id,
            action: audit.action,
            entityType: "opportunity_allocation",
            entityId: String(ledgerExecution.plan.allocationId),
            metadata: audit.metadata,
          },
          trx
        );
      } else if (input.decision === "aprovada") {
        // Reexecuta a ação real — hoje só existe um tipo de ação de alto
        // risco (ajuste de estoque); novos tipos entram aqui.
        if (stockAdjustment) {
          const { payload, itemName } = stockAdjustment;

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
              metadata: { approvalRequestId: req.id, delta: payload.quantity, itemName },
            },
            trx
          );
        }
      } else {
        if (req.actionType === DESTINATION_APPROVAL_ACTION) await markDestinationRequestRejected(trx, req.id, input.organizationId);
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
    if (result.type === "destination_payload_invalid") {
      return new Response(superjson.stringify({ message: "Não foi possível executar este pedido de saída: os dados do pedido são inválidos ou ele já foi tratado. Rejeite o pedido e peça de novo." }), { status: 409, headers: { "Content-Type": "application/json" } });
    }
    if (result.type === "destination_error") {
      return new Response(superjson.stringify({ message: `Não é possível aprovar: ${result.message}. Revise a situação atual ou rejeite o pedido.`, code: result.code }), { status: result.status === 403 || result.status === 404 ? 409 : result.status, headers: { "Content-Type": "application/json" } });
    }
    if (result.type === "ledger_payload_invalid") {
      // Mesmo status (409) e mesmo fluxo do payload_invalid de estoque; só a mensagem
      // é a do domínio do ledger (sem detalhes internos do payload).
      return new Response(superjson.stringify({ message: "Não foi possível executar este pedido: os dados da correção ou do estorno do recebimento são inválidos. Rejeite o pedido e solicite de novo." }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "pedido_obsoleto") {
      return new Response(
        superjson.stringify({ message: "O recebimento mudou desde o pedido, então ele não pode mais ser executado. Rejeite este pedido e peça de novo com o histórico atual.", code: "pedido_obsoleto" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }
    if (result.type === "pedido_expirado") {
      return new Response(superjson.stringify({ message: "Este pedido passou do prazo de decisão e não pode mais ser aprovado", code: "pedido_expirado" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (result.type === "insufficient_stock") {
      return new Response(
        superjson.stringify({
          message: `Não é possível aprovar: o saldo de "${result.itemName}" mudou desde o pedido e hoje é ${result.currentStock} — aplicar este ajuste deixaria o saldo negativo. Revise a situação atual do estoque antes de decidir.`,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(superjson.stringify({ request: result.request }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao decidir pedido de aprovação:", error);
    return buildErrorResponse(error, "Não foi possível registrar a decisão");
  }
}
