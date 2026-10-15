import { sql } from "kysely";
import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { createApprovalRequest } from "../helpers/approvals.js";
import { RISK_LABELS } from "../helpers/destinationRules.js";
import { auditExecutedExit, DESTINATION_APPROVAL_ACTION, executeDestinationExit, hashDestinationInput, prepareDestinationExit, type DestinationExitInput } from "../helpers/stockExit.js";
import { schema, type OutputType } from "./stock-destinations_POST.schema.js";
import superjson from "superjson";
import type { Json } from "../helpers/schema.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";

const json = (status: number, body: unknown) => new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Fase 99E — registra, numa ÚNICA transação, a saída física de estoque e a sua destinação (e o pedido idempotente e a auditoria). É o único caminho de saída de estoque.
 * Autorização: `inventario.lance` (proprietário, administrador, operador); data retroativa (> 7 dias) exige `organizacao.gerencie`. Risco (perda/descarte, ou ≥ 30% do saldo
 * atual do item): NADA é baixado — vira um pedido de segunda aprovação pelo mecanismo existente e a saída só nasce na aprovação. Idempotência: chave por organização com UNIQUE
 * no banco + hash do conteúdo. Ver src/helpers/stockExit.tsx para a ordem de travas.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));
    const membership = await requirePermission(user.id, input.organizationId, "inventario.lance");
    const actorCanAuthorizeLate = roleHasPermission(membership.role, "organizacao.gerencie");

    const exitInput: DestinationExitInput = {
      organizationId: input.organizationId,
      itemId: input.itemId,
      quantity: input.quantity,
      destinationType: input.destinationType,
      needId: input.needId ?? null,
      deliveredOn: input.deliveredOn,
      peopleServed: input.peopleServed ?? null,
      peopleUnit: input.peopleUnit ?? null,
      notes: input.notes && input.notes.length > 0 ? input.notes : null,
      lateRegistrationReason: input.lateRegistrationReason && input.lateRegistrationReason.length > 0 ? input.lateRegistrationReason : null,
    };
    const hash = hashDestinationInput(exitInput);

    const result = await db.transaction().execute(async (trx) => {
      // 1) serializa pedidos com a MESMA chave (a unicidade do banco é a rede de proteção)
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`stockexit:${input.organizationId}:${input.idempotencyKey}`}))`.execute(trx);
      const existing = await trx
        .selectFrom("stockExitRequests")
        .select(["id", "payloadHash", "status", "approvalRequestId", "stockTransactionId", "stockDestinationId"])
        .where("organizationId", "=", input.organizationId)
        .where("idempotencyKey", "=", input.idempotencyKey)
        .executeTakeFirst();

      if (existing) {
        if (existing.payloadHash !== hash) return { type: "key_reuse" as const };
        if (existing.status === "executada") {
          const d = await trx.selectFrom("stockDestinations").select(["id", "destinationType", "deliveredOn", "isCountable", "quantity"]).where("id", "=", existing.stockDestinationId!).executeTakeFirstOrThrow();
          const stockNow = await trx.selectFrom("stockTransactions").select(["id", "delta"]).where("id", "=", existing.stockTransactionId!).executeTakeFirstOrThrow();
          const balance = await trx.selectFrom("stockTransactions").select(sql<string>`COALESCE(SUM(delta), 0)`.as("t")).where("itemId", "=", input.itemId).executeTakeFirstOrThrow();
          return { type: "replay_executed" as const, d, tx: stockNow, balance: Number(balance.t) };
        }
        const approval = await trx.selectFrom("approvalRequests").select(["id", "status"]).where("id", "=", existing.approvalRequestId!).executeTakeFirstOrThrow();
        if (approval.status === "pendente") return { type: "replay_pending" as const, approvalRequestId: approval.id };
        return { type: "replay_closed" as const, status: approval.status };
      }

      // 2) valida tudo (item travado, saldo recalculado, unidade, necessidade, data) — nada é gravado se algo falhar
      const prepared = await prepareDestinationExit(trx, exitInput, { actorCanAuthorizeLate });
      if (prepared.type === "error") return prepared;

      // 3a) risco: NÃO baixa estoque nem cria destinação; registra o pedido de segunda aprovação e a chave
      if (prepared.risk.length > 0) {
        const approval = await createApprovalRequest(
          {
            actionType: DESTINATION_APPROVAL_ACTION,
            organizationId: input.organizationId,
            payload: { input: exitInput, idempotencyKey: input.idempotencyKey, riskReasons: prepared.risk, balanceAtRequest: prepared.balanceBefore } as unknown as Json,
            reason: `Saída de ${input.quantity} ${prepared.item.unit} de "${prepared.item.name}" (finalidade: ${input.destinationType}; saldo atual ${prepared.balanceBefore}) — ${prepared.risk.map((r) => RISK_LABELS[r]).join("; ")}`,
            requestedByUserId: user.id,
          },
          trx
        );
        await trx
          .insertInto("stockExitRequests")
          .values({ organizationId: input.organizationId, idempotencyKey: input.idempotencyKey, payloadHash: hash, status: "pendente_aprovacao", approvalRequestId: approval.id, requestedByUserId: user.id })
          .execute();
        await recordAuditLogEntry(
          {
            organizationId: input.organizationId,
            actorUserId: user.id,
            action: "destinacao.pendente_aprovacao",
            entityType: "inventory_item",
            entityId: String(input.itemId),
            metadata: { approvalRequestId: approval.id, finalidade: input.destinationType, quantidade: input.quantity, saldoAtual: prepared.balanceBefore, riscoAvaliado: prepared.risk, dataEfetiva: input.deliveredOn },
          },
          trx
        );
        return { type: "pending" as const, approvalRequestId: approval.id, risk: prepared.risk };
      }

      // 3b) saída direta: saída + destinação + pedido + auditoria juntos
      const executed = await executeDestinationExit(trx, exitInput, prepared, { creatorUserId: user.id, authorizerUserId: user.id });
      await trx
        .insertInto("stockExitRequests")
        .values({
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
          payloadHash: hash,
          status: "executada",
          stockTransactionId: executed.stockTransactionId,
          stockDestinationId: executed.destinationId,
          requestedByUserId: user.id,
        })
        .execute();
      await auditExecutedExit(trx, exitInput, prepared, executed, { actorUserId: user.id }, input.idempotencyKey);
      return { type: "executed" as const, executed, prepared };
    });

    switch (result.type) {
      case "error":
        return json(result.status, { message: result.message, code: result.code, ...(result.details ?? {}) });
      case "key_reuse":
        return json(409, { message: "Esta chave de idempotência já foi usada com um conteúdo diferente. Gere uma nova chave para uma nova saída.", code: "chave_reutilizada" });
      case "replay_closed":
        return json(409, { message: `O pedido original desta chave foi encerrado (${result.status}) sem registrar a saída. Gere uma nova chave para tentar de novo.`, code: "pedido_encerrado" });
      case "replay_pending":
        return json(202, { requiresApproval: true, replayed: true, approvalRequestId: result.approvalRequestId, riskReasons: [], message: "Este pedido já foi enviado e aguarda a segunda aprovação." } satisfies OutputType);
      case "pending":
        return json(202, {
          requiresApproval: true,
          replayed: false,
          approvalRequestId: result.approvalRequestId,
          riskReasons: result.risk,
          message: `Esta saída exige a aprovação de uma segunda pessoa (${result.risk.map((r) => RISK_LABELS[r]).join("; ")}). Nada foi baixado do estoque: a saída só é registrada quando outra pessoa aprovar.`,
        } satisfies OutputType);
      case "replay_executed":
        return json(200, {
          requiresApproval: false,
          replayed: true,
          destination: { id: String(result.d.id), destinationType: result.d.destinationType!, deliveredOn: String(result.d.deliveredOn instanceof Date ? result.d.deliveredOn.toISOString().slice(0, 10) : result.d.deliveredOn), isCountable: result.d.isCountable === true },
          transaction: { id: String(result.tx.id), delta: Number(result.tx.delta) },
          newStock: result.balance,
          notice: null,
        } satisfies OutputType);
      case "executed":
        return json(200, {
          requiresApproval: false,
          replayed: false,
          destination: { id: result.executed.destinationId, destinationType: input.destinationType, deliveredOn: input.deliveredOn, isCountable: result.prepared.isCountable },
          transaction: { id: result.executed.stockTransactionId, delta: -input.quantity },
          newStock: result.executed.newStock,
          notice:
            input.needId != null && !result.prepared.isCountable
              ? "A saída foi registrada, mas a unidade da necessidade não é a mesma do item: ela NÃO conta como atendimento da necessidade (nada é convertido)."
              : null,
        } satisfies OutputType);
    }
  } catch (error: unknown) {
    console.error("Erro ao registrar saída com destinação:", error);
    return buildErrorResponse(error, "Não foi possível registrar a saída");
  }
}
