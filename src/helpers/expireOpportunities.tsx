import { db } from "./db.js";
import { claimTaskRun, finishTaskRun, failTaskRun } from "./backgroundTasks.js";
import { recordAuditLogEntry } from "./auditLog.js";
import type { OpportunityRegistryStatus } from "./schema.js";
import { withScheduledTaskLock } from "./scheduledTaskLock.js";

const TERMINAL_STATUSES: OpportunityRegistryStatus[] = ["concluida", "recusada", "expirada", "cancelada", "bloqueada", "duplicada"];

/** Atribuição EM ANDAMENTO real: a organização aceitou (ou o recurso está em coleta/transporte). Uma oferta assim não expira sozinha. */
const IN_PROGRESS_ALLOCATION_STATUSES = ["aceita", "em_coleta", "em_transporte"] as const;
/** Atribuições que podem mudar de estado enquanto a expiração decide (travadas antes da oportunidade, mesma ordem dos outros caminhos). */
const LOCKABLE_ALLOCATION_STATUSES = ["proposta", "aceita", "em_coleta", "em_transporte"] as const;

/**
 * Tarefa agendada (static/__dev/scheduled-jobs.json): expira descobertas do
 * registro central cuja validade (expires_at) já passou. A maioria das
 * descobertas hoje não tem expires_at preenchido (a interface ainda não
 * coleta esse campo no formulário rápido), então esta tarefa
 * frequentemente não encontra nada — isso é esperado, não é um bug.
 *
 * `withScheduledTaskLock` (achado de auditoria) impede que duas chamadas
 * concorrentes desta função (cron sobreposto, ou reprocessamento manual ao
 * mesmo tempo) executem o corpo simultaneamente. `claimTaskRun` continua
 * inalterado.
 *
 * FASE 95 — duas correções:
 *  1. Uma oferta com atribuição EM ANDAMENTO (`aceita`, `em_coleta`, `em_transporte`) NÃO expira: antes, a validade da oferta vencia no meio do atendimento, o
 *     recebimento ainda era aceito, mas a oportunidade ficava `expirada` para sempre (a conclusão só parte de `atribuida`) e a prestação de contas mostrava como
 *     expirado um recurso que foi entregue. Quando a atribuição termina (recebida, cancelada, recusada) a oferta segue o caminho normal: conclui, ou reabre e, se
 *     a validade já passou, a próxima execução a expira.
 *  2. Cada oportunidade é uma transação própria: a verificação, a mudança de status e a auditoria são confirmadas juntas (antes o UPDATE em lote e a auditoria
 *     eram operações separadas).
 *
 * Concorrência: as atribuições da oportunidade são travadas com `FOR UPDATE` ANTES da linha da oportunidade (ordem de decisão/logística/recebimento), e tudo é
 * reverificado sob as travas. Assim, uma aceitação concorrente ou ganha (a oferta não expira) ou perde (a atribuição ainda era proposta; o aceite depois não
 * consegue mudar a oportunidade expirada, como já era). Fora do escopo desta etapa (decisão de produto pendente): oferta `reservada` com PROPOSTA ativa continua
 * expirando como antes.
 */
export async function expireOpportunities() {
  await withScheduledTaskLock("expireOpportunities", () => runExpireOpportunities());
}

type Outcome = "expirada" | "protegida" | "ignorada";

async function expireOne(opportunityId: number): Promise<Outcome> {
  return db.transaction().execute(async (trx) => {
    await trx
      .selectFrom("opportunityAllocations")
      .select("id")
      .where("opportunityRegistryId", "=", opportunityId)
      .where("status", "in", [...LOCKABLE_ALLOCATION_STATUSES])
      .orderBy("id")
      .forUpdate()
      .execute();

    const opp = await trx
      .selectFrom("opportunityRegistry")
      .select(["id", "title", "status", "expiresAt"])
      .where("id", "=", opportunityId)
      .forUpdate()
      .executeTakeFirst();
    // Reverificado sob a trava: outro caminho pode ter concluído/cancelado/expirado, ou a validade pode ter sido alterada.
    if (!opp || TERMINAL_STATUSES.includes(opp.status) || opp.expiresAt === null || opp.expiresAt.getTime() >= Date.now()) return "ignorada";

    const inProgress = await trx
      .selectFrom("opportunityAllocations")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("opportunityRegistryId", "=", opportunityId)
      .where("status", "in", [...IN_PROGRESS_ALLOCATION_STATUSES])
      .executeTakeFirst();
    if (Number(inProgress?.n ?? 0) > 0) return "protegida";

    await trx
      .updateTable("opportunityRegistry")
      .set({ status: "expirada", statusReason: "validade vencida (expires_at)", updatedAt: new Date() })
      .where("id", "=", opportunityId)
      .where("status", "not in", TERMINAL_STATUSES)
      .execute();

    await recordAuditLogEntry(
      {
        organizationId: null,
        actorUserId: null,
        action: "descoberta_central.expirada_automaticamente",
        entityType: "opportunity_registry",
        entityId: String(opportunityId),
        metadata: { title: opp.title },
      },
      trx
    );
    return "expirada";
  });
}

async function runExpireOpportunities() {
  const claim = await claimTaskRun({ taskName: "expireOpportunities" });
  if (!claim.claimed) return;

  try {
    const candidates = await db
      .selectFrom("opportunityRegistry")
      .select("id")
      .where("expiresAt", "is not", null)
      .where("expiresAt", "<", new Date())
      .where("status", "not in", TERMINAL_STATUSES)
      .orderBy("id")
      .execute();

    let expiradas = 0;
    let protegidas = 0;
    const failures: Array<{ opportunityId: number; message: string }> = [];
    for (const { id } of candidates) {
      try {
        const outcome = await expireOne(id);
        if (outcome === "expirada") expiradas += 1;
        else if (outcome === "protegida") protegidas += 1;
      } catch (err) {
        failures.push({ opportunityId: id, message: err instanceof Error ? err.message : String(err) });
      }
    }

    if (failures.length > 0) {
      const error = new Error(`expireOpportunities: ${failures.length} oportunidade(s) com falha (as demais foram processadas)`);
      await failTaskRun(claim.runId, error, { falhas: failures.slice(0, 20).map((f) => ({ opportunityId: f.opportunityId, message: f.message.slice(0, 300) })) });
      throw error;
    }

    await finishTaskRun(claim.runId, { expiradas, protegidasPorAtribuicaoEmAndamento: protegidas });
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith("expireOpportunities: "))) await failTaskRun(claim.runId, err);
    throw err;
  }
}
