import type { Kysely, Transaction } from "kysely";
import type { DB } from "./schema.js";

/**
 * M40 — correlação da JORNADA da necessidade. A correlação nasce no cadastro da necessidade (`needs.correlation_id`, gerada no servidor) e é HERDADA pelos registros de auditoria dos fluxos
 * que realmente envolvem aquela necessidade (atribuição, decisão, logística, recebimento, correção/estorno, destinação, encerramento). A herança passa pela necessidade JÁ PERSISTIDA
 * (`need_id`): nada é inferido por nome nem fabricado — necessidade sem correlação (anterior à M40) ou fluxo sem necessidade devolvem `null` e o registro fica sem correlação.
 */
type Ex = Kysely<DB> | Transaction<DB>;

export async function needCorrelation(ex: Ex, needId: number | string | null | undefined): Promise<string | null> {
  if (needId === null || needId === undefined || !/^[0-9]{1,12}$/.test(String(needId))) return null;
  const row = await ex.selectFrom("needs").select("correlationId").where("id", "=", Number(needId)).executeTakeFirst();
  return row?.correlationId ?? null;
}

/** A necessidade de uma atribuição: a escolhida explicitamente (manual) OU a da avaliação de matching que a criou — as duas fontes nunca coexistem (Fase 45). */
export async function allocationNeedId(ex: Ex, allocationId: number | string): Promise<number | null> {
  const a = await ex.selectFrom("opportunityAllocations").select("needId").where("id", "=", Number(allocationId)).executeTakeFirst();
  if (a?.needId) return a.needId;
  const m = await ex.selectFrom("matchEvaluations").select("needId").where("allocationId", "=", Number(allocationId)).orderBy("id", "asc").executeTakeFirst();
  return m?.needId ?? null;
}

export async function allocationCorrelation(ex: Ex, allocationId: number | string): Promise<string | null> {
  return needCorrelation(ex, await allocationNeedId(ex, allocationId));
}

/** A necessidade de uma destinação já persistida. */
export async function destinationCorrelation(ex: Ex, destinationId: number | string): Promise<string | null> {
  const d = await ex.selectFrom("stockDestinations").select("needId").where("id", "=", String(destinationId)).executeTakeFirst();
  return needCorrelation(ex, d?.needId ?? null);
}
