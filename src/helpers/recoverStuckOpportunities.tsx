import { sql } from "kysely";
import { db } from "./db.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { concludeOpportunityIfAllTerminalAndReceived } from "./concludeOpportunity.js";
import { reopenOpportunityIfNoActiveAllocations } from "./reopenOpportunity.js";

/**
 * Recuperação de oportunidades presas: `reservada`/`atribuida` SEM nenhuma atribuição em andamento (`proposta`, `aceita`, `em_coleta`, `em_transporte`).
 * Isso só acontece depois de uma falha entre o fim da última atribuição e a transição da oportunidade (processo morto no meio, versões antigas de
 * `expireReservations` que cancelavam as reservas e reabriam em transações separadas). Nada mais olhava para elas: o sweep só lê `aguardando_destinacao`.
 *
 * A regra é a MESMA dos caminhos normais (decisão, logística, expiração de reservas): sob a trava da linha da oportunidade, primeiro tenta concluir (há atribuição
 * `recebida` e todas as demais são terminais), senão reabre para `aguardando_destinacao`. Uma oportunidade que ainda tem qualquer atribuição em andamento
 * nunca é tocada — o filtro é refeito sob a trava, não confiado ao SELECT inicial. Cada oportunidade é uma transação própria (uma falha não impede as demais) e
 * cada transição deixa auditoria na mesma transação.
 */
const IN_PROGRESS = ["proposta", "aceita", "em_coleta", "em_transporte"] as const;
const MAX_PER_RUN = 200;

export interface RecoveryResult {
  reopened: number[];
  concluded: number[];
  failed: Array<{ opportunityId: number; message: string }>;
}

export async function recoverStuckOpportunities(): Promise<RecoveryResult> {
  const candidates = await db
    .selectFrom("opportunityRegistry")
    .select("id")
    .where("status", "in", ["reservada", "atribuida"])
    .where(sql<boolean>`NOT EXISTS (
      SELECT 1 FROM opportunity_allocations a
      WHERE a.opportunity_registry_id = opportunity_registry.id AND a.status IN ('proposta', 'aceita', 'em_coleta', 'em_transporte')
    )`)
    .orderBy("id")
    .limit(MAX_PER_RUN)
    .execute();

  const out: RecoveryResult = { reopened: [], concluded: [], failed: [] };
  for (const { id } of candidates) {
    try {
      const r = await db.transaction().execute(async (trx) => {
        // Trava a linha e confirma, já sob a trava, que continua presa (o SELECT acima pode estar velho).
        const opp = await trx.selectFrom("opportunityRegistry").select(["id", "status", "title"]).where("id", "=", id).forUpdate().executeTakeFirst();
        if (!opp || (opp.status !== "reservada" && opp.status !== "atribuida")) return "ignorada" as const;
        const active = await trx
          .selectFrom("opportunityAllocations")
          .select((eb) => eb.fn.countAll().as("n"))
          .where("opportunityRegistryId", "=", id)
          .where("status", "in", [...IN_PROGRESS])
          .executeTakeFirst();
        if (Number(active?.n ?? 0) > 0) return "ignorada" as const;

        const concluded = await concludeOpportunityIfAllTerminalAndReceived(trx, id);
        if (concluded) {
          await recordAuditLogEntry(
            { organizationId: null, actorUserId: null, action: "descoberta_central.concluida", entityType: "opportunity_registry", entityId: String(id), metadata: { origem: "recuperacao_automatica", statusAnterior: opp.status } },
            trx
          );
          return "concluida" as const;
        }
        const reopened = await reopenOpportunityIfNoActiveAllocations(trx, id);
        if (!reopened) return "ignorada" as const;
        await recordAuditLogEntry(
          { organizationId: null, actorUserId: null, action: "descoberta_central.reaberta_automaticamente", entityType: "opportunity_registry", entityId: String(id), metadata: { motivo: "sem_atribuicao_ativa", statusAnterior: opp.status, title: opp.title } },
          trx
        );
        return "reaberta" as const;
      });
      if (r === "concluida") out.concluded.push(id);
      else if (r === "reaberta") out.reopened.push(id);
    } catch (err) {
      out.failed.push({ opportunityId: id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
