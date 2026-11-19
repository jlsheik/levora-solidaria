import { sql, type Transaction } from "kysely";
import type { DB } from "./schema.js";
import { publishDomainEvent } from "./domainEvents.js";
import { getItemStockBalance } from "./stockBalance.js";

/**
 * Publicadores de eventos de domínio com CONTRATO v2 (M35). Regras que valem para todos:
 *   - são chamados DENTRO da transação do fluxo de domínio, depois do último passo que pode falhar → se a operação falhar ou for revertida, o evento nem existe (outbox transacional);
 *   - só publicam fatos que JÁ estão persistidos (ou derivam deles na mesma transação): nenhum valor vem do navegador;
 *   - o ator é só o identificador numérico do usuário; nenhum nome, e-mail, contato ou texto livre entra no payload;
 *   - valor desconhecido é omitido (NUNCA 0); quantidades e saldos preservam a unidade do item (a unidade vai junto quando existe);
 *   - `v: 2` identifica o contrato; eventos publicados antes da M35 não têm `v` (versão 1) e continuam aceitos pelo motor, que apenas registra o que falta.
 */

export const EVENT_CONTRACT_VERSION = 2;

/**
 * Origem do lançamento do ledger (M36 amplia a lista). `estorno_*`/`correcao_*` são lançamentos de ESTORNO ou CORREÇÃO e NUNCA entradas novas: carregam a referência ao registro original
 * (`reversesStockTransactionId` e/ou `reversesAllocationId`). `estoque_inicial` é a quantidade informada no cadastro do item (lançamento do ledger, não uma entrada operacional posterior).
 */
export type StockEventSource =
  | "lancamento_manual"
  | "ajuste_aprovado"
  | "destinacao_saida"
  | "estoque_inicial"
  | "recebimento_oportunidade"
  | "estorno_destinacao"
  | "correcao_destinacao"
  | "estorno_recebimento"
  | "correcao_recebimento";

/** `stock_transaction.created`: chamar logo depois de inserir a linha em `stock_transactions`, com o item já travado pelo fluxo (o saldo lido aqui é o saldo APÓS o lançamento). */
export async function publishStockTransactionCreated(
  trx: Transaction<DB>,
  input: { organizationId: number; transactionId: string | number; itemId: number; type: "entrada" | "saida" | "ajuste"; delta: number; source: StockEventSource; actorUserId: number | null; correlationId?: string | null; reversesStockTransactionId?: string | number | null; reversesAllocationId?: number | null }
): Promise<void> {
  const newStock = await getItemStockBalance(trx, input.itemId);
  const prior = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM stock_transactions
     WHERE item_id = ${input.itemId} AND organization_id = ${input.organizationId} AND type = 'saida' AND id < ${String(input.transactionId)}`.execute(trx);
  await publishDomainEvent(trx, {
    eventType: "stock_transaction.created",
    correlationId: input.correlationId,
    organizationId: input.organizationId,
    entityType: "stock_transaction",
    entityId: String(input.transactionId),
    payload: {
      v: EVENT_CONTRACT_VERSION,
      itemId: input.itemId,
      type: input.type,
      delta: input.delta,
      newStock,
      previousStock: Number((newStock - input.delta).toFixed(3)),
      source: input.source,
      itemHasPriorDistribution: Number(prior.rows[0]?.n ?? 0) > 0,
      ...(input.reversesStockTransactionId ? { reversesStockTransactionId: String(input.reversesStockTransactionId) } : {}),
      ...(input.reversesAllocationId ? { reversesAllocationId: input.reversesAllocationId } : {}),
      ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
    },
  });
}

const normUnit = (u: string | null | undefined) => (u ?? "").trim().toLowerCase();

/** `allocation.received`: `sameUnit` só é true quando a unidade da oferta e a do item são IGUAIS (sem conversão numérica); caso contrário as quantidades não são comparáveis. */
export async function publishAllocationReceived(
  trx: Transaction<DB>,
  input: { organizationId: number; allocationId: number; itemId: number; quantityReceived: number; quantityAllocated: number; offerUnit: string | null; itemUnit: string | null; stockTransactionId: string; opportunityConcluded: boolean; correlationId?: string | null; actorUserId: number | null }
): Promise<void> {
  await publishDomainEvent(trx, {
    eventType: "allocation.received",
    correlationId: input.correlationId,
    organizationId: input.organizationId,
    entityType: "opportunity_allocation",
    entityId: String(input.allocationId),
    payload: {
      v: EVENT_CONTRACT_VERSION,
      allocationId: input.allocationId,
      itemId: input.itemId,
      quantityReceived: input.quantityReceived,
      quantityAllocated: input.quantityAllocated,
      sameUnit: normUnit(input.offerUnit) !== "" && normUnit(input.offerUnit) === normUnit(input.itemUnit),
      stockTransactionId: input.stockTransactionId,
      opportunityConcluded: input.opportunityConcluded,
      ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
    },
  });
}

/** `opportunity.created`: categoria e quantidade como registradas (nulas quando não informadas — nunca 0). */
export async function publishOpportunityCreated(
  trx: Transaction<DB>,
  input: { organizationId: number; opportunityId: number; category: string | null; quantityOffered: number | null; unit: string | null; linkedNeed: boolean; actorUserId: number | null; correlationId?: string | null }
): Promise<void> {
  await publishDomainEvent(trx, {
    eventType: "opportunity.created",
    correlationId: input.correlationId,
    organizationId: input.organizationId,
    entityType: "donation_opportunity",
    entityId: String(input.opportunityId),
    payload: {
      v: EVENT_CONTRACT_VERSION,
      category: input.category,
      quantityOffered: input.quantityOffered,
      unit: input.unit,
      linkedNeed: input.linkedNeed,
      ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
    },
  });
}
