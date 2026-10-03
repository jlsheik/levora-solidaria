import { db } from "../helpers/db.js";
import { sql } from "kysely";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import { computeNeedProgress, getNeedFulfillmentBalance } from "../helpers/needFulfillment.js";
import { countedEffect, readLedgerRows, resolveLedgerChain, LEDGER_APPROVAL_ACTION_TYPES } from "../helpers/needFulfillmentCorrections.js";
import { getItemStockBalance } from "../helpers/stockBalance.js";
import { schema } from "./allocations-receipt-history_GET.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
      allocationId: url.searchParams.get("allocationId"),
    });

    // Membro ATIVO + logistica.leia (leitura: não exige organização aprovada).
    const membership = await requirePermissionToRead(user.id, input.organizationId, "logistica.leia");

    // A allocation precisa pertencer à organização (IDOR: 404 para qualquer outra).
    const allocation = await db
      .selectFrom("opportunityAllocations")
      .select(["id", "status"])
      .where("id", "=", input.allocationId)
      .where("organizationId", "=", input.organizationId)
      .executeTakeFirst();
    if (!allocation) {
      return new Response(superjson.stringify({ message: "Atribuição não encontrada", code: "atribuicao_nao_encontrada" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Leitura consistente (uma transação REPEATABLE READ): linhas, need,
    // saldo e pedido pendente do mesmo instante.
    const snapshot = await db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      const rows = await readLedgerRows(trx, input.allocationId, false);
      const chain = resolveLedgerChain(rows);
      const needId = rows.find((r) => r.needId !== null)?.needId ?? null;

      const need = needId
        ? await trx.selectFrom("needs").select(["id", "title", "unit", "quantityNeeded"]).where("id", "=", needId).where("organizationId", "=", input.organizationId).executeTakeFirst()
        : undefined;
      const progress = need ? computeNeedProgress(Number(need.quantityNeeded), await getNeedFulfillmentBalance(trx, need.id)) : null;

      // Movimentos físicos ligados às linhas (nem toda linha tem) e o item do recebimento.
      const linkedIds = rows.map((r) => r.stockTransactionId).filter((v): v is string => v !== null);
      const movements =
        linkedIds.length > 0
          ? await trx.selectFrom("stockTransactions").select(["id", "delta", "itemId"]).where("id", "in", linkedIds).where("organizationId", "=", input.organizationId).execute()
          : [];
      const itemId = movements[0]?.itemId ?? null;
      const itemRow = itemId !== null ? await trx.selectFrom("inventoryItems").select(["id", "name", "unit"]).where("id", "=", itemId).where("organizationId", "=", input.organizationId).executeTakeFirst() : undefined;
      const itemInfo = itemRow ? { id: itemRow.id, name: itemRow.name, unit: itemRow.unit, currentBalance: await getItemStockBalance(trx, itemRow.id) } : null;

      const authorIds = [...new Set(rows.map((r) => r.createdByUserId).filter((v): v is number => v !== null))];
      const authors = authorIds.length > 0 ? await trx.selectFrom("users").select(["id", "displayName"]).where("id", "in", authorIds).execute() : [];

      // O ledger não tem coluna de motivo: ele vem da trilha de auditoria
      // (um evento por operação, com `fulfillmentIds`), da MESMA organização.
      const events = await trx
        .selectFrom("auditLog")
        .select(["metadata"])
        .where("organizationId", "=", input.organizationId)
        .where("entityType", "=", "opportunity_allocation")
        .where("entityId", "=", String(input.allocationId))
        .where("action", "in", ["atribuicao.recebimento_corrigido", "atribuicao.recebimento_estornado"])
        .execute();

      const pending = await trx
        .selectFrom("approvalRequests")
        .innerJoin("users as requester", "requester.id", "approvalRequests.requestedByUserId")
        .select(["approvalRequests.id", "approvalRequests.actionType", "approvalRequests.reason", "approvalRequests.requestedByUserId", "requester.displayName as requestedByDisplayName", "approvalRequests.createdAt"])
        .where("approvalRequests.organizationId", "=", input.organizationId)
        .where("approvalRequests.status", "=", "pendente")
        .where("approvalRequests.actionType", "in", [...LEDGER_APPROVAL_ACTION_TYPES])
        .where(sql<boolean>`approval_requests.payload->>'allocationId' = ${String(input.allocationId)}`)
        .executeTakeFirst();

      return { rows, chain, need, progress, authors, events, pending, movements, itemInfo };
    });

    const authorName = new Map(snapshot.authors.map((a) => [a.id, a.displayName]));
    const eventByFulfillmentId = new Map<string, { reason: string | null; approvalRequestId: number | null }>();
    for (const event of snapshot.events) {
      const meta = event.metadata as { fulfillmentIds?: unknown; motivo?: unknown; approvalRequestId?: unknown } | null;
      if (!meta || !Array.isArray(meta.fulfillmentIds)) continue;
      const info = {
        reason: typeof meta.motivo === "string" ? meta.motivo : null,
        approvalRequestId: typeof meta.approvalRequestId === "number" ? meta.approvalRequestId : null,
      };
      for (const id of meta.fulfillmentIds) if (typeof id === "string") eventByFulfillmentId.set(id, info);
    }

    const movementDelta = new Map(snapshot.movements.map((m) => [String(m.id), Number(m.delta)]));
    const physicalBalance = snapshot.movements.length > 0 ? snapshot.movements.reduce((acc, m) => acc + Number(m.delta), 0) : null;

    const netCountedEffect = snapshot.chain.head && snapshot.chain.headState === "ativa" ? countedEffect(snapshot.chain.head) : 0;

    return new Response(
      superjson.stringify({
        allocation: { id: allocation.id, status: allocation.status },
        need: snapshot.need ? { id: snapshot.need.id, title: snapshot.need.title, unit: snapshot.need.unit, quantityNeeded: Number(snapshot.need.quantityNeeded) } : null,
        rows: snapshot.rows.map((r) => ({
          id: r.id,
          entryType: r.entryType,
          quantity: r.quantity,
          unit: r.unit,
          isCountable: r.isCountable,
          countedEffect: countedEffect(r),
          reversesFulfillmentId: r.reversesFulfillmentId,
          state: snapshot.chain.states.get(r.id) ?? "substituida",
          pairedWithCorrection: snapshot.chain.pairedReversals.has(r.id),
          createdByDisplayName: r.createdByUserId !== null ? (authorName.get(r.createdByUserId) ?? null) : null,
          createdAt: r.createdAt.toISOString(),
          reason: eventByFulfillmentId.get(r.id)?.reason ?? null,
          approvalRequestId: eventByFulfillmentId.get(r.id)?.approvalRequestId ?? null,
          stockTransactionId: r.stockTransactionId,
          physicalDelta: r.stockTransactionId !== null ? (movementDelta.get(r.stockTransactionId) ?? null) : null,
        })),
        item: snapshot.itemInfo,
        physicalBalance,
        vigenteFulfillmentId: snapshot.chain.vigenteFulfillmentId,
        chainState: snapshot.chain.headState,
        netCountedEffect,
        progress: snapshot.progress,
        pendingRequest: snapshot.pending
          ? {
              id: snapshot.pending.id,
              actionType: snapshot.pending.actionType,
              reason: snapshot.pending.reason,
              requestedByUserId: snapshot.pending.requestedByUserId,
              requestedByDisplayName: snapshot.pending.requestedByDisplayName,
              createdAt: snapshot.pending.createdAt.toISOString(),
            }
          : null,
        viewer: {
          userId: user.id,
          canRequest: roleHasPermission(membership.role, "logistica.gerencie"),
          canDecide: roleHasPermission(membership.role, "aprovacoes.decida"),
        },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao carregar histórico do recebimento:", error);
    return buildErrorResponse(error, "Falha ao carregar o histórico do recebimento");
  }
}
