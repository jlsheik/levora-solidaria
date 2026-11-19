import type { Transaction } from "kysely";
import type { AgentEventRunStatus, AuditOutcome, DB, Json } from "./schema.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { ConflictError } from "./errorResponse.js";

/**
 * Estado de uma execução do motor de eventos (M34). Toda mudança de estado é um COMPARE-AND-SET (só avança se o estado atual ainda for o esperado) e grava, na mesma transação, a linha
 * de histórico (append-only) e — quando o autor é agente ou sistema — a auditoria. Quem perde a corrida recebe ConflictError e nada muda: não existe estado "meio avançado".
 *
 * Estados e o que significam (nenhum deles é execução real):
 *   recebido              o motor registrou o evento para este agente;
 *   validado              tipo, estrutura e organização conferem;
 *   ignorado              fora do contrato (tipo/estrutura/escopo): terminal, com motivo;
 *   bloqueado_politica    pausa, emergência, agente desligado ou regra impediu: NÃO avançou; pode ser reprocessado quando o motivo cessar;
 *   aguardando_aprovacao  uma regra de proteção criou uma exceção para pessoas decidirem;
 *   rejeitado             uma pessoa rejeitou a exceção: terminal;
 *   autorizado_simulacao  política permitiu (ou as aprovações necessárias foram dadas): autorizado SOMENTE para simulação;
 *   simulacao_concluida   simulação registrada: terminal; nada foi executado fora do sistema;
 *   falha                 erro inesperado repetido: terminal; o histórico fica.
 */

export const TERMINAL_STATUSES: readonly AgentEventRunStatus[] = ["ignorado", "rejeitado", "simulacao_concluida", "falha"]; // `dados_insuficientes` não é terminal só por regra do motor: só uma reavaliação AUTORIZADA o reabre (agent-event-reevaluate_POST)

/** Códigos de motivo cujo bloqueio cessa sozinho quando a condição some (reprocessáveis). */
export const RETRIABLE_BLOCK_CODES: readonly string[] = ["automation_paused", "automation_emergency", "agent_disabled"];

export type RunActor = { type: "agent"; agentPrincipalId: number } | { type: "user"; userId: number } | { type: "system" };

export interface TransitionInput {
  runId: string;
  from: AgentEventRunStatus | readonly AgentEventRunStatus[];
  to: AgentEventRunStatus;
  reasonCode: string;
  /** Frase em português para a tela; nunca dado pessoal nem conteúdo do evento. */
  reason: string;
  actor: RunActor;
  exceptionId?: string | null;
  ruleCode?: string | null;
  detail?: Json;
}

export async function transitionRun(trx: Transaction<DB>, input: TransitionInput): Promise<{ eventType: string; organizationId: number | null; agentPrincipalId: number; fromStatus: AgentEventRunStatus }> {
  const froms = Array.isArray(input.from) ? [...input.from] : [input.from as AgentEventRunStatus];
  const before = await trx.selectFrom("agentEventRuns").select(["status"]).where("id", "=", input.runId).forUpdate().executeTakeFirst();
  if (!before || !froms.includes(before.status)) {
    throw new ConflictError("A execução já avançou: esta transição não vale mais");
  }
  const patch: Record<string, unknown> = { status: input.to, reasonCode: input.reasonCode, reason: input.reason.slice(0, 400) };
  if (input.exceptionId !== undefined) patch.exceptionId = input.exceptionId;
  if (input.ruleCode !== undefined) patch.ruleCode = input.ruleCode;
  if (input.detail !== undefined) patch.detail = input.detail;
  const row = await trx
    .updateTable("agentEventRuns")
    .set(patch)
    .where("id", "=", input.runId)
    .where("status", "=", before.status)
    .returning(["eventType", "organizationId", "agentPrincipalId", "correlationId"])
    .executeTakeFirst();
  if (!row) throw new ConflictError("A execução já avançou: esta transição não vale mais");

  await trx
    .insertInto("agentEventRunHistory")
    .values({
      runId: input.runId,
      fromStatus: before.status,
      toStatus: input.to,
      reasonCode: input.reasonCode,
      actorType: input.actor.type,
      actorUserId: input.actor.type === "user" ? input.actor.userId : null,
      exceptionId: input.exceptionId ?? null,
    })
    .execute();

  if (input.actor.type !== "user") {
    await recordAuditLogEntry(
      {
        organizationId: row.organizationId,
        actorUserId: null,
        actorType: input.actor.type,
        actorAgentPrincipalId: input.actor.type === "agent" ? input.actor.agentPrincipalId : null,
        action: `agente.evento_${input.to}`,
        outcome: outcomeForRunStatus(input.to), // desfecho REAL do estado em que a execução entrou (nunca derivado do nome da ação)
        correlationId: row.correlationId,
        entityType: "agent_event_run",
        entityId: input.runId,
        metadata: { tipoEvento: row.eventType, de: before.status, motivo: input.reasonCode, simulado: true },
      },
      trx
    );
  }
  return { ...row, fromStatus: before.status };
}

/**
 * M39 — desfecho da OPERAÇÃO "a execução entrou neste estado". Mapeamento explícito e testado (nunca por texto):
 *   concluida = a etapa terminou normalmente (recebida, validada, autorizada só para simulação, simulação concluída);
 *   pendente  = aguarda alguém/algo (revisão humana ou dados) — o desfecho final vem depois;
 *   recusada  = barrada por regra de domínio (política/pausa/limite, rejeição humana, fora do contrato);
 *   falhou    = falha técnica da execução.
 */
export function outcomeForRunStatus(to: string): AuditOutcome {
  switch (to) {
    case "aguardando_aprovacao":
    case "dados_insuficientes":
      return "pendente";
    case "bloqueado_politica":
    case "rejeitado":
    case "ignorado":
      return "recusada";
    case "falha":
      return "falhou";
    default:
      return "concluida";
  }
}

/** Um registro de histórico sem mudar o estado (ex.: tentativa que falhou e vai ser repetida). */
export async function noteRunAttempt(trx: Transaction<DB>, runId: string, reasonCode: string): Promise<void> {
  const row = await trx
    .updateTable("agentEventRuns")
    .set((eb) => ({ attempts: eb("attempts", "+", 1), reasonCode }))
    .where("id", "=", runId)
    .returning(["status"])
    .executeTakeFirst();
  if (!row) return;
  await trx.insertInto("agentEventRunHistory").values({ runId, fromStatus: row.status, toStatus: row.status, reasonCode, actorType: "agent" }).execute();
}

/**
 * Chamada por `decideException` NA MESMA TRANSAÇÃO da decisão humana: a execução ligada à exceção acompanha o resultado — rejeitada → `rejeitado` (terminal); aprovada (todas as aprovações exigidas) →
 * `autorizado_simulacao`. Aprovar NÃO conclui nem executa nada: a conclusão simulada é um passo separado do motor, que reconfere pausa, limites e política. O alerta "exceção aguardando revisão" é
 * encerrado porque a exceção foi de fato decidida por uma pessoa (nunca por mera visualização).
 */
export async function syncRunsAfterDecision(
  trx: Transaction<DB>,
  input: { organizationId: number; exceptionId: string; status: "pendente" | "aprovada" | "rejeitada"; userId: number }
): Promise<void> {
  if (input.status === "pendente") return;
  const runs = await trx
    .selectFrom("agentEventRuns")
    .select(["id", "status"])
    .where("exceptionId", "=", input.exceptionId)
    .where("organizationId", "=", input.organizationId)
    .where("status", "=", "aguardando_aprovacao")
    .forUpdate()
    .execute();
  for (const run of runs) {
    if (input.status === "rejeitada") {
      await transitionRun(trx, { runId: String(run.id), from: "aguardando_aprovacao", to: "rejeitado", reasonCode: "excecao_rejeitada", reason: "Uma pessoa rejeitou a exceção: a operação não avança.", actor: { type: "user", userId: input.userId }, exceptionId: input.exceptionId });
    } else {
      await transitionRun(trx, { runId: String(run.id), from: "aguardando_aprovacao", to: "autorizado_simulacao", reasonCode: "excecao_aprovada", reason: "As aprovações exigidas foram dadas: autorizado somente para simulação (nada é executado fora do sistema).", actor: { type: "user", userId: input.userId }, exceptionId: input.exceptionId });
    }
  }
  const resolved = await trx
    .updateTable("integrityAlerts")
    .set({ status: "resolvido", resolvedAt: new Date(), resolvedByUserId: input.userId, resolutionNote: input.status === "aprovada" ? "Exceção aprovada por uma pessoa." : "Exceção rejeitada por uma pessoa." })
    .where("organizationId", "=", input.organizationId)
    .where("dedupeKey", "=", `exc:${input.exceptionId}`)
    .where("status", "in", ["aberto", "reconhecido"])
    .returning("id")
    .execute();
  for (const alert of resolved) {
    await recordAuditLogEntry(
      { organizationId: input.organizationId, actorUserId: input.userId, action: "automacao.alerta_atualizado", entityType: "integrity_alert", entityId: String(alert.id), metadata: { de: "aberto", para: "resolvido", origem: "excecao_decidida" } },
      trx
    );
  }
}
