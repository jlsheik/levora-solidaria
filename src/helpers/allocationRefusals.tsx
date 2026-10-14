import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";
import type { DB } from "./schema.js";
import { REASSIGNMENT_PAUSE_DAYS } from "./assignmentSettings.js";

/**
 * Recusa/cancelamento EXPLÍCITO de uma organização sobre uma oportunidade (Fase 97).
 *
 * Regra de produto: uma organização que recusou ou cancelou, ela mesma, uma atribuição de uma oportunidade NÃO volta a recebê-la automaticamente. A restrição é
 * do par (oportunidade, organização) — nunca uma suspensão global da organização.
 *
 * Como o ator é identificado (sem coluna nova e sem reconstruir histórico): só há DOIS caminhos de código que levam uma atribuição a esses estados por decisão da
 * organização, e ambos deixam um registro durável e imutável:
 *  - `allocations-decide_POST` com decisão "recusada" → `opportunity_allocations.status = 'recusada'` (e `decided_by_user_id`); nenhum outro caminho escreve esse status;
 *  - `allocations-logistics_POST` com evento "cancelado" → `status = 'cancelada'` + linha em `logistics_events` (event_type 'cancelado', actor_user_id), tabela com gatilhos
 *    que bloqueiam UPDATE/DELETE.
 * Já `cancelada` SEM esse evento (hoje: expiração automática da reserva em `expireReservations`, ou qualquer linha sem evidência do ator) NÃO é recusa: continua elegível.
 * A linha da atribuição nunca é apagada (só por cascata se a oportunidade ou a organização forem removidas), então a restrição vale entre execuções, reinicializações e
 * varreduras. Uma única consulta indexada por oportunidade (sem N+1).
 */
export interface ExplicitRefusal {
  allocationId: number;
  organizationId: number;
  status: "recusada" | "cancelada";
}

type Db = Kysely<DB> | Transaction<DB>;

export async function getExplicitRefusals(trx: Db, opportunityRegistryId: number, organizationId?: number): Promise<ExplicitRefusal[]> {
  let q = trx
    .selectFrom("opportunityAllocations as a")
    .select(["a.id as allocationId", "a.organizationId", "a.status"])
    .where("a.opportunityRegistryId", "=", opportunityRegistryId)
    .where((eb) =>
      eb.or([
        eb("a.status", "=", "recusada"),
        eb.and([
          eb("a.status", "=", "cancelada"),
          eb.exists(
            eb
              .selectFrom("logisticsEvents as le")
              .select(sql<number>`1`.as("x"))
              .whereRef("le.opportunityAllocationId", "=", "a.id")
              .where("le.eventType", "=", "cancelado")
          ),
        ]),
      ])
    )
    .orderBy("a.id");
  if (organizationId !== undefined) q = q.where("a.organizationId", "=", organizationId);
  return (await q.execute()) as ExplicitRefusal[];
}

export async function getRefusingOrganizationIds(trx: Db, opportunityRegistryId: number): Promise<Set<number>> {
  return new Set((await getExplicitRefusals(trx, opportunityRegistryId)).map((r) => r.organizationId));
}

/**
 * Pausa temporária de reatribuição (Fase 98): organizações cuja atribuição AUTOMÁTICA desta oportunidade foi encerrada por EXPIRAÇÃO DO PRAZO nos últimos
 * REASSIGNMENT_PAUSE_DAYS dias (relógio do banco). Diferente da recusa explícita: expira sozinha, não é permanente e nunca é confundida com ela (o motivo vem de
 * `closed_reason = 'prazo_expirado'`, gravado só pela tarefa de expiração do prazo).
 */
export async function getReassignmentPausedOrganizationIds(trx: Db, opportunityRegistryId: number): Promise<Set<number>> {
  const rows = await trx
    .selectFrom("opportunityAllocations")
    .select("organizationId")
    .where("opportunityRegistryId", "=", opportunityRegistryId)
    .where("closedReason", "=", "prazo_expirado")
    .where(sql<boolean>`closed_at > now() - make_interval(days => ${REASSIGNMENT_PAUSE_DAYS})`)
    .execute();
  return new Set(rows.map((r) => r.organizationId));
}
