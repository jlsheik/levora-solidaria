import { sql } from "kysely";
import { db } from "./db.js";
import type { AgentEventRunStatus, Json } from "./schema.js";
import type { AgentName } from "./agentRegistry.js";
import { invokeAgentTool, type AgentToolResult } from "./agentTools.js";
import { getAutomationState } from "./automationControls.js";
import { createIntegrityAlert } from "./integrityAlerts.js";
import { ConflictError } from "./errorResponse.js";
import { getEffectivePolicyLimits } from "./policyLimits.js";
import { PENDING_RULES, assessEvent, summarizeDecision, type Assessment } from "./agentAssessment.js";
import { computeSupplement, type Supplement } from "./agentReevaluation.js";
import { RETRIABLE_BLOCK_CODES, noteRunAttempt, transitionRun, type RunActor } from "./agentEventRuns.js";

/**
 * Motor de eventos dos agentes (M34) — SOMENTE SIMULAÇÃO. Reaproveita o barramento da Fase 74 (`domain_events`, publicado na mesma transação do negócio) e a camada de ferramentas
 * (`invokeAgentTool`, que já aplica: agente ligado → matriz → entrada → escopo de organização → pausa/emergência → limites efetivos → regras → exceção). Este módulo acrescenta o que faltava:
 *
 *   evento interno → [recebido] → validação (tipo, estrutura, organização) → [validado | ignorado] → agente autorizado (principal ligado, da organização ou global) → ferramenta
 *   `assess_event` (política, limites, pausa) → [bloqueado_politica | aguardando_aprovacao | autorizado_simulacao → simulacao_concluida] → auditoria + alerta interno quando cabe.
 *
 * Regras de segurança do motor:
 *   - Nunca registra um agente nem o liga: só processa principais JÁ registrados e ligados por uma pessoa. Sem agente ligado, o motor não faz nada (comportamento seguro sem configuração).
 *   - Só avalia eventos publicados DEPOIS do registro do agente (sem inundar com o histórico ao ligar).
 *   - Um agente de organização só enxerga eventos da própria organização; evento sem organização só vai a agente global e, mesmo assim, fica `ignorado`.
 *   - Idempotente: (evento, agente) tem no máximo UMA execução (UNIQUE); transições são compare-and-set; repetir o processamento não duplica decisão, exceção nem alerta.
 *   - Pausa/emergência: a execução é registrada e fica `bloqueado_politica`; NADA avança e, quando a pausa cessa, o motor retoma de onde parou (o histórico não é apagado).
 *   - Nada aqui executa ação externa: `simulated` é sempre true (CHECK no banco), não há integração, mensagem, pagamento nem mudança de dado de negócio.
 */

/**
 * Evento → agente (docs/AGENTES_ESPECIFICACAO.md §4). Validação do payload, fatos e regras vivem em `agentAssessment.tsx` (função pura). M35: contratos versionados — payload sem `v` é a versão 1.
 */
export const EVENT_CONTRACTS = {
  "stock_transaction.created": { agent: "sentinela-integridade" as AgentName },
  "allocation.received": { agent: "sentinela-integridade" as AgentName },
  "opportunity.created": { agent: "risk-engine" as AgentName },
} as const;
export type ContractedEventType = keyof typeof EVENT_CONTRACTS;
export const CONTRACTED_EVENT_TYPES = Object.keys(EVENT_CONTRACTS) as ContractedEventType[];

const MAX_ATTEMPTS = 3;
/** Execução parada em `recebido`/`validado` há mais que isto é considerada abandonada (processo caiu) e retomada; protege contra dois processos tocando a mesma ao mesmo tempo. */
const STALE_SECONDS = 30;

export interface EngineOptions {
  /** Restringe o processamento a uma organização (usado pela ação manual da própria organização). Omitido = todas (tarefa agendada). */
  organizationId?: number;
  batchSize?: number;
}

export interface EngineSummary {
  registered: number;
  advanced: number;
  byStatus: Partial<Record<AgentEventRunStatus, number>>;
  conflicts: number;
}

type RunRow = {
  id: string;
  status: AgentEventRunStatus;
  organizationId: number | null;
  agentPrincipalId: number;
  exceptionId: string | null;
  attempts: number;
  eventType: string;
  reasonCode: string | null;
  payload: Json;
  detail: Json;
  entityId: string | null;
  /** M39: correlação do evento de origem (herdada). null = evento anterior à M39 (nenhuma correlação é fabricada). */
  correlationId: string | null;
};

/** Frases (pt-BR) para os motivos de bloqueio vindos da camada de ferramentas. */
const BLOCK_REASON_TEXT: Record<string, string> = {
  agent_disabled: "O agente está desligado: o evento aguarda.",
  tool_not_allowed: "A ferramenta não está permitida para este agente.",
  invalid_input: "A entrada da avaliação é inválida.",
  organization_mismatch: "O agente não pode agir nesta organização.",
  automation_paused: "A automação está pausada: nada avança até ser retomada.",
  automation_emergency: "Modo emergência: nada avança até ser encerrado.",
  exception_not_valid: "A aprovação existente não cobre a política atual.",
};

const agentActor = (principalId: number): RunActor => ({ type: "agent", agentPrincipalId: principalId });

/** 1) Registra as execuções novas: um par (evento, agente ligado) ainda sem execução. A UNIQUE torna a corrida segura — quem perde simplesmente não cria. */
async function registerNewRuns(options: EngineOptions, limit: number): Promise<string[]> {
  const created: string[] = [];
  for (const eventType of CONTRACTED_EVENT_TYPES) {
    const agent = EVENT_CONTRACTS[eventType].agent;
    const orgFilter = options.organizationId !== undefined ? sql`AND e.organization_id = ${options.organizationId}` : sql``;
    const candidates = await sql<{ eventId: string; principalId: number; organizationId: number | null; correlationId: string | null }>`
      SELECT e.id AS event_id, p.id AS principal_id, e.organization_id, e.correlation_id
      FROM domain_events e
      JOIN agent_principals p
        ON p.name = ${agent} AND p.enabled = true
       AND (p.organization_id IS NULL OR p.organization_id = e.organization_id)
       AND e.created_at >= p.created_at
      WHERE e.event_type = ${eventType}
        ${orgFilter}
        AND NOT (p.organization_id IS NULL AND EXISTS (
          SELECT 1 FROM agent_principals p2 WHERE p2.name = p.name AND p2.enabled = true AND p2.organization_id = e.organization_id))
        AND NOT EXISTS (SELECT 1 FROM agent_event_runs r WHERE r.event_id = e.id AND r.agent_principal_id = p.id)
      ORDER BY e.id ASC
      LIMIT ${limit}
    `.execute(db);
    for (const c of candidates.rows) {
      const runId = await db.transaction().execute(async (trx) => {
        const inserted = await trx
          .insertInto("agentEventRuns")
          .values({ eventId: c.eventId, agentPrincipalId: c.principalId, organizationId: c.organizationId, eventType, status: "recebido", reasonCode: "evento_recebido", reason: "Evento interno recebido pelo motor.", correlationId: c.correlationId })
          .onConflict((oc) => oc.columns(["eventId", "agentPrincipalId"]).doNothing())
          .returning("id")
          .executeTakeFirst();
        if (!inserted) return null;
        await trx.insertInto("agentEventRunHistory").values({ runId: inserted.id, fromStatus: null, toStatus: "recebido", reasonCode: "evento_recebido", actorType: "agent" }).execute();
        return String(inserted.id);
      });
      if (runId) created.push(runId);
    }
  }
  return created;
}

async function loadRun(runId: string): Promise<RunRow | null> {
  const row = await db
    .selectFrom("agentEventRuns as r")
    .innerJoin("domainEvents as e", "e.id", "r.eventId")
    .select(["r.id", "r.status", "r.organizationId", "r.agentPrincipalId", "r.exceptionId", "r.attempts", "r.eventType", "r.reasonCode", "r.detail", "r.correlationId", "e.payload", "e.entityId"])
    .where("r.id", "=", runId)
    .executeTakeFirst();
  return row ? { ...row, id: String(row.id), exceptionId: row.exceptionId === null ? null : String(row.exceptionId) } : null;
}

/** 2) Validação + avaliação explicável (M35): tipo contratado, estrutura (v1 ou v2), organização presente e fatos/regras avaliados contra os limites efetivos AGORA. */
async function assess(run: RunRow): Promise<{ ok: true; assessment: Assessment; supplement: Supplement | null } | { ok: false; code: string; text: string }> {
  if (!(run.eventType in EVENT_CONTRACTS)) return { ok: false, code: "tipo_nao_suportado", text: "Tipo de evento sem contrato para este agente." };
  if (run.organizationId === null) return { ok: false, code: "sem_organizacao", text: "Evento sem organização: agentes de organização não o processam." };
  const limits = await getEffectivePolicyLimits(db, run.organizationId);
  // M36: dados complementares de uma REAVALIAÇÃO autorizada (lidos dos registros de origem pelo servidor, com origem registrada). Só estes campos, e só se existirem na execução; o evento NÃO é alterado.
  // M37: numa reavaliação os dados complementares são relidos A CADA avaliação (nunca reutilizados de uma leitura antiga), com a versão do registro, que a conclusão confere sob trava.
  const reevaluated = Boolean(((run.detail ?? {}) as { supplement?: unknown }).supplement);
  const supplement = reevaluated ? await computeSupplement(db, { eventType: run.eventType, organizationId: run.organizationId, entityId: run.entityId, payload: run.payload }) : null;
  const allowed = new Set(["category", "itemHasPriorDistribution", "quantityAllocated", "sameUnit"]);
  const payload = { ...((run.payload ?? {}) as Record<string, unknown>), ...Object.fromEntries(Object.entries(supplement?.fields ?? {}).filter(([k]) => allowed.has(k))) };
  const result = assessEvent(run.eventType as ContractedEventType, payload, limits);
  return result.ok ? { ok: true, assessment: result.assessment, supplement } : result;
}

const compact = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;

/** Grava a EXPLICAÇÃO da avaliação em `agent_event_runs.detail` (só fatos numéricos/booleanos/ids, regras e limites; nunca texto livre). Reavaliações mantêm as decisões anteriores (últimas 5). */
async function saveExplanation(run: RunRow, a: Assessment, decision: string, supplement: Supplement | null = null): Promise<void> {
  const prev = (run.detail ?? {}) as { evaluationCount?: number; decision?: string; evaluatedAt?: string; previous?: Array<{ decision: string; at: string }>; supplement?: unknown };
  const previous = [...(prev.previous ?? []), ...(prev.decision && prev.evaluatedAt ? [{ decision: prev.decision, at: prev.evaluatedAt }] : [])].slice(-5);
  // M37: de onde veio o dado considerado (nunca apresentar como "atual" o que veio do evento original)
  const facts = run.eventType === "opportunity.created" ? { ...a.facts, origemCategoria: supplement?.opportunity ? `registro da oportunidade (versão ${supplement.opportunity.version})` : "evento original", ...(supplement?.opportunity ? { versaoOportunidade: supplement.opportunity.version } : {}) } : a.facts;
  const detail = {
    contractVersion: a.contractVersion, facts, missingRequired: a.missingRequired, missingOptional: a.missingOptional, completeness: a.completeness, rules: a.rules, limits: a.limits,
    pendingRules: PENDING_RULES[run.eventType as ContractedEventType] ?? [], decision, evaluatedAt: new Date().toISOString(), evaluationCount: (prev.evaluationCount ?? 0) + 1, previous, simulated: true,
    ...(prev.supplement ? { supplement: { ...(prev.supplement as object), ...(supplement ? { fields: supplement.fields, sources: supplement.sources } : {}) } } : {}),
  };
  await db.updateTable("agentEventRuns").set({ detail: detail as unknown as Json }).where("id", "=", run.id).execute();
}

async function alertFor(run: RunRow, args: { level: "alto_risco" | "operacional" | "seguranca"; category: string; title: string; dedupeKey: string; detail?: Json }) {
  await db.transaction().execute((trx) =>
    createIntegrityAlert(trx, { organizationId: run.organizationId, level: args.level, category: args.category, title: args.title, detail: args.detail ?? { execucao: run.id, tipoEvento: run.eventType, simulado: true }, entityType: "agent_event_run", entityId: run.id, dedupeKey: args.dedupeKey, agentPrincipalId: run.agentPrincipalId })
  );
}

/** Avança UMA execução o quanto a política permitir. Devolve o estado final observado. Perder uma corrida (ConflictError) não é falha: outra instância já avançou. */
type AdvanceOutcome = { status: AgentEventRunStatus | "conflito" | "inexistente"; revalidate?: boolean };
export async function advanceRun(runId: string): Promise<{ status: AgentEventRunStatus | "conflito" | "inexistente" }> {
  let outcome = await advanceOnce(runId);
  // Revalidação dentro da transação (pausa/limite/agente mudaram entre a checagem e o commit): reavalia TUDO uma vez, sem usar a decisão anterior.
  if (outcome.status === "conflito" && outcome.revalidate) outcome = await advanceOnce(runId);
  return { status: outcome.status };
}

async function advanceOnce(runId: string): Promise<AdvanceOutcome> {
  try {
    let run = await loadRun(runId);
    if (!run) return { status: "inexistente" };
    const actor = agentActor(run.agentPrincipalId);

    if (run.status === "recebido") {
      const v = await assess(run);
      if (!v.ok) {
        await db.transaction().execute((trx) => transitionRun(trx, { runId, from: "recebido", to: "ignorado", reasonCode: v.code, reason: v.text, actor }));
        return { status: "ignorado" };
      }
      await db.transaction().execute((trx) => transitionRun(trx, { runId, from: "recebido", to: "validado", reasonCode: "evento_valido", reason: "Tipo, estrutura e organização conferem.", actor }));
      run = { ...run, status: "validado" };
    }

    if (run.status === "bloqueado_politica") {
      if (!run.reasonCode || !RETRIABLE_BLOCK_CODES.includes(run.reasonCode)) return { status: "bloqueado_politica" };
      const state = await getAutomationState(db, run.organizationId);
      if (state.paused || state.emergency) return { status: "bloqueado_politica" };
      const principal = await db.selectFrom("agentPrincipals").select("enabled").where("id", "=", run.agentPrincipalId).executeTakeFirst();
      if (!principal?.enabled) return { status: "bloqueado_politica" };
      await db.transaction().execute((trx) => transitionRun(trx, { runId, from: "bloqueado_politica", to: "validado", reasonCode: "reprocessado", reason: "O motivo do bloqueio cessou: o evento foi retomado.", actor }));
      run = { ...run, status: "validado" };
    }

    if (run.status !== "validado" && run.status !== "autorizado_simulacao") return { status: run.status };

    const v = await assess(run);
    if (!v.ok) {
      await db.transaction().execute((trx) => transitionRun(trx, { runId, from: run!.status, to: "ignorado", reasonCode: v.code, reason: v.text, actor }));
      return { status: "ignorado" };
    }
    if (run.attempts >= MAX_ATTEMPTS) return finalizeFailure(run, "falha_repetida");

    // M35 — dado OBRIGATÓRIO ausente: a análise é INSUFICIENTE e NÃO é aprovação. O motor registra o que faltou e para (sem exceção, sem conclusão da simulação).
    if (v.assessment.completeness === "insuficiente") {
      await saveExplanation(run, v.assessment, "dados_insuficientes", v.supplement);
      await db.transaction().execute((trx) => transitionRun(trx, { runId, from: run!.status, to: "dados_insuficientes", reasonCode: "dados_insuficientes", reason: `Análise incompleta: falta ${v.assessment.missingRequired.join(", ")}. Nada foi aprovado.`, actor }));
      return { status: "dados_insuficientes" };
    }
    await saveExplanation(run, v.assessment, summarizeDecision(v.assessment), v.supplement);
    const toolInput = { organizationId: run.organizationId, runId, ...compact(v.assessment.policy), ...(v.supplement?.opportunity ? { opportunityId: v.supplement.opportunity.id, opportunityVersion: v.supplement.opportunity.version } : {}) };

    // Aprovação humana já dada para esta execução (uso único): a ferramenta a confere e consome na mesma transação da conclusão.
    let approvedExceptionId: string | undefined;
    if (run.exceptionId) {
      const ex = await db.selectFrom("exceptionQueue").select(["status", "consumedAt"]).where("id", "=", run.exceptionId).executeTakeFirst();
      if (ex && ex.status === "aprovada" && ex.consumedAt === null) approvedExceptionId = run.exceptionId;
    }

    let result: AgentToolResult;
    try {
      result = await invokeAgentTool({ principalId: run.agentPrincipalId, toolName: "assess_event", input: toolInput, approvedExceptionId, correlationId: run.correlationId });
      if (result.status === "blocked" && result.reason === "exception_not_valid" && approvedExceptionId) {
        // A política mudou entre a criação e a revisão (ou a aprovação foi usada): reavalia sem a aprovação antiga → pode gerar uma NOVA exceção.
        result = await invokeAgentTool({ principalId: run.agentPrincipalId, toolName: "assess_event", input: toolInput, correlationId: run.correlationId });
        if (result.status === "needs_review") {
          await db.transaction().execute((trx) => transitionRun(trx, { runId, from: run!.status, to: "aguardando_aprovacao", reasonCode: "politica_alterada", reason: "A política mudou depois da aprovação: uma nova exceção foi aberta.", actor, exceptionId: result.status === "needs_review" ? result.exceptionId : null, ruleCode: result.status === "needs_review" ? result.ruleCode : null }));
          const fresh = (await loadRun(runId))!;
          await alertForException(fresh, result);
          return { status: "aguardando_aprovacao" };
        }
      }
    } catch (error) {
      if (error instanceof ConflictError) return { status: "conflito", revalidate: error.message.startsWith("revalidar") };
      await db.transaction().execute((trx) => noteRunAttempt(trx, runId, "erro_inesperado"));
      const after = await loadRun(runId);
      if (after && after.attempts >= MAX_ATTEMPTS) return finalizeFailure(after, "falha_repetida");
      return { status: after?.status ?? "validado" };
    }

    if (result.status === "ok") {
      await saveExplanation({ ...run, detail: ((await loadRun(runId))?.detail ?? {}) as Json }, v.assessment, approvedExceptionId ? "aprovado_por_pessoas_simulacao" : v.assessment.completeness === "parcial" ? "permitido_analise_parcial" : "permitido", v.supplement);
      return { status: "simulacao_concluida" };
    }

    if (result.status === "needs_review") {
      await db.transaction().execute((trx) => transitionRun(trx, { runId, from: run!.status, to: "aguardando_aprovacao", reasonCode: "excecao_aberta", reason: "Uma regra de proteção interrompeu o evento: aguarda a decisão de uma pessoa.", actor, exceptionId: result.exceptionId, ruleCode: result.ruleCode }));
      await alertForException((await loadRun(runId))!, result);
      return { status: "aguardando_aprovacao" };
    }

    // blocked
    const code = result.reason;
    if (run.status === "validado" || run.status === "autorizado_simulacao") {
      if (code === "invalid_input") return finalizeFailure(run, "entrada_invalida");
      await db.transaction().execute((trx) => transitionRun(trx, { runId, from: run!.status, to: "bloqueado_politica", reasonCode: code, reason: BLOCK_REASON_TEXT[code] ?? result.message, actor }));
    }
    const blocked = (await loadRun(runId))!;
    if (code === "automation_paused" || code === "automation_emergency") {
      await alertFor(blocked, { level: "operacional", category: "automacao_pausada", title: code === "automation_emergency" ? "Eventos aguardando: modo emergência ativo" : "Eventos aguardando: automação pausada", dedupeKey: `pausa:${blocked.organizationId}:${code}`, detail: { motivo: code, simulado: true } });
    } else if (code === "organization_mismatch" || code === "tool_not_allowed") {
      await alertFor(blocked, { level: "seguranca", category: "agente_bloqueado_politica", title: "Um agente foi impedido de avaliar um evento por regra de escopo", dedupeKey: `bloq:${blocked.id}`, detail: { motivo: code, simulado: true } });
    }
    return { status: "bloqueado_politica" };
  } catch (error) {
    if (error instanceof ConflictError) return { status: "conflito", revalidate: error.message.startsWith("revalidar") };
    throw error;
  }
}

async function alertForException(run: RunRow, r: Extract<AgentToolResult, { status: "needs_review" }>) {
  await alertFor(run, {
    level: r.approvalsRequired === 2 ? "alto_risco" : "operacional",
    category: "agente_excecao_pendente",
    title: r.approvalsRequired === 2 ? "Exceção aguardando dupla autorização" : "Exceção aguardando revisão",
    dedupeKey: `exc:${r.exceptionId}`,
    detail: { excecao: r.exceptionId, regra: r.ruleCode, aprovacoesNecessarias: r.approvalsRequired, execucao: run.id, tipoEvento: run.eventType, simulado: true },
  });
}

async function finalizeFailure(run: RunRow, code: string): Promise<AdvanceOutcome> {
  const reason = code === "falha_repetida" ? "A avaliação falhou repetidas vezes: encerrada com falha (o histórico foi mantido)." : "A entrada da avaliação é inválida.";
  await db.transaction().execute((trx) => transitionRun(trx, { runId: run.id, from: run.status, to: "falha", reasonCode: code, reason, actor: agentActor(run.agentPrincipalId) }));
  await alertFor(run, { level: "operacional", category: code === "falha_repetida" ? "agente_falha_repetida" : "agente_falha_processamento", title: code === "falha_repetida" ? "Um agente falhou repetidamente ao avaliar um evento" : "Falha ao processar um evento", dedupeKey: `falha:${run.id}` });
  return { status: "falha" };
}

/** Execuções já existentes que podem avançar agora (retomada após pausa, autorizadas por aprovação, abandonadas por queda do processo). */
async function pickupRuns(options: EngineOptions, limit: number): Promise<string[]> {
  const org = options.organizationId !== undefined ? sql`AND r.organization_id = ${options.organizationId}` : sql``;
  const rows = await sql<{ id: string }>`
    SELECT r.id FROM agent_event_runs r
    WHERE (
      r.status = 'autorizado_simulacao'
      OR (r.status = 'bloqueado_politica' AND r.reason_code IN (${sql.join(RETRIABLE_BLOCK_CODES.map((c) => sql.lit(c)))}))
      OR (r.status IN ('recebido', 'validado') AND r.updated_at < now() - make_interval(secs => ${STALE_SECONDS}))
    ) ${org}
    ORDER BY r.id ASC LIMIT ${limit}
  `.execute(db);
  return rows.rows.map((r) => String(r.id));
}

export async function runAgentEventEngine(options: EngineOptions = {}): Promise<EngineSummary> {
  const batch = Math.min(Math.max(options.batchSize ?? 50, 1), 200);
  const summary: EngineSummary = { registered: 0, advanced: 0, byStatus: {}, conflicts: 0 };
  const fresh = await registerNewRuns(options, batch);
  summary.registered = fresh.length;
  const picked = await pickupRuns(options, batch);
  const ids = [...new Set([...fresh, ...picked])];
  for (const id of ids) {
    const outcome = await advanceRun(id);
    if (outcome.status === "conflito") summary.conflicts += 1;
    else if (outcome.status !== "inexistente") {
      summary.advanced += 1;
      summary.byStatus[outcome.status] = (summary.byStatus[outcome.status] ?? 0) + 1;
    }
  }
  return summary;
}

/** Quantos eventos contratados esperam por um agente ligado e ainda não têm execução (para a tela: nunca um zero inventado). */
export async function countUnprocessedEvents(organizationId: number): Promise<number> {
  let total = 0;
  for (const eventType of CONTRACTED_EVENT_TYPES) {
    const agent = EVENT_CONTRACTS[eventType].agent;
    const r = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM domain_events e
      JOIN agent_principals p ON p.name = ${agent} AND p.enabled = true AND (p.organization_id IS NULL OR p.organization_id = e.organization_id) AND e.created_at >= p.created_at
      WHERE e.event_type = ${eventType} AND e.organization_id = ${organizationId}
        AND NOT (p.organization_id IS NULL AND EXISTS (SELECT 1 FROM agent_principals p2 WHERE p2.name = p.name AND p2.enabled = true AND p2.organization_id = e.organization_id))
        AND NOT EXISTS (SELECT 1 FROM agent_event_runs r WHERE r.event_id = e.id AND r.agent_principal_id = p.id)
    `.execute(db);
    total += Number(r.rows[0]?.n ?? 0);
  }
  return total;
}

export const ENGINE_AGENT_NAMES = [...new Set(Object.values(EVENT_CONTRACTS).map((c) => c.agent))] as AgentName[];
