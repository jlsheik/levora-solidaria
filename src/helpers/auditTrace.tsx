import { sql } from "kysely";
import { db } from "./db.js";
import type { AuditEntryRow } from "./auditCenter.js";

/**
 * M38 — rastreabilidade: Oportunidade → Evento → Avaliação do Risk Engine → Decisão → Exceção/revisão humana → Reavaliação → Auditoria.
 *
 * SOMENTE LEITURA e só com vínculos que o sistema JÁ persiste:
 *   oportunidade ←(domain_events.entity_type/entity_id)← evento ←(agent_event_runs.event_id)← execução ←(agent_event_runs.exception_id)→ exceção ←(exception_decisions)
 *   execução ←(agent_event_reevaluations.run_id/correlation_id)  ·  oportunidade ←(opportunity_changes.correlation_id)
 *   auditoria ←(entity_type+entity_id)  ·  auditoria ←(metadata.correlacao = correlation_id), que só existe nos eventos M36/M37.
 * Quando um vínculo NÃO existe, o passo aparece SEM referência de auditoria (nunca é fabricado, nenhum evento histórico é reescrito). Toda consulta é filtrada pela organização do pedido.
 *
 * A decisão histórica NUNCA é recalculada aqui: `decisions[].recalculated` é sempre false; a comparação "considerado × atual" só informa.
 */

export type TraceStepKey = "oportunidade" | "evento" | "transicao" | "decisao" | "excecao" | "revisao_humana" | "reavaliacao" | "alteracao_categoria";

export interface TraceStep {
  key: TraceStepKey;
  at: string;
  title: string;
  detail: string | null;
  actor: string | null;
  ref: { kind: "oportunidade" | "evento" | "execucao" | "excecao" | "reavaliacao"; id: string } | null;
  correlationId: string | null;
  /** Id do registro de auditoria correspondente — só quando o vínculo é determinístico; null = "sem registro de auditoria associado". */
  auditEntryId: string | null;
  /** Por que este passo aponta para aquele registro: `direta` (mesma entidade) ou `correlacao` (correlação persistida). null = sem vínculo verificável. */
  linkKind: "direta" | "correlacao" | null;
}

export interface HistoricalDecision {
  runId: string;
  agentName: string;
  status: string;
  decision: string | null;
  reason: string | null;
  ruleCode: string | null;
  evaluatedAt: string;
  evaluationCount: number;
  /** Política considerada na avaliação: regras com resultado e limites vigentes naquele momento (gravados pelo motor). */
  policy: { rules: Array<{ code: string; title: string; result: string; reason: string }>; limits: Record<string, unknown> } | null;
  categoryConsidered: string | null;
  categoryOrigin: string | null;
  /** Versão do registro usada. null = não registrada (avaliação anterior à M38 sem releitura, ou evento original). */
  versionConsidered: number | null;
  /** Categoria/versão ATUAIS — null quando quem consulta não pode ler oportunidades. */
  currentCategory: string | null;
  currentVersion: number | null;
  categoryDiffers: boolean | null;
  laterChanges: Array<{ id: string; at: string; byName: string | null; previousValue: string | null; newValue: string | null; versionAfter: number; correlationId: string; auditEntryId: string | null }>;
  /** Sempre false: a decisão histórica foi preservada, não recalculada. */
  recalculated: false;
}

export interface TraceResult {
  subject: { kind: "oportunidade" | "execucao" | "excecao" | "correlacao"; id: string };
  opportunity: { id: number; title: string; status: string; currentCategory: string | null; version: number } | null;
  steps: TraceStep[];
  decisions: HistoricalDecision[];
  /** Registros de auditoria das entidades envolvidas (máx. 200, em ordem de inserção). */
  auditEntries: Array<AuditEntryRow & { link: "direta" | "correlacao" }>;
  /** Correlação persistida da jornada (herdada da origem). null = anterior à M39: nenhuma correlação é fabricada. */
  journey: { correlationId: string | null };
  /** Limites do que esta visão consegue afirmar. */
  limits: string[];
}

export interface TraceRequest {
  organizationId: number;
  canSeeOpportunity: boolean;
  canSeeAutomation: boolean;
  opportunityId?: number;
  runId?: string;
  exceptionId?: string;
  correlationId?: string;
}

type Explained = { decision?: string; evaluatedAt?: string; evaluationCount?: number; facts?: Record<string, unknown>; rules?: Array<{ code: string; title: string; result: string; reason: string }>; limits?: Record<string, unknown> };
const iso = (d: Date | string) => new Date(d).toISOString();
const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

export async function buildTrace(req: TraceRequest): Promise<TraceResult | null> {
  const org = req.organizationId;
  const limits: string[] = [
    "Só aparecem vínculos persistidos no sistema. Registros de auditoria anteriores à M36 não têm identificador de correlação; nesses casos o passo é mostrado sem registro de auditoria associado.",
    "A decisão histórica não é recalculada nem anulada por esta tela.",
  ];

  let opportunityId: number | null = req.opportunityId ?? null;
  let runIds: string[] = [];
  let exceptionId: string | null = req.exceptionId ?? null;
  let subject: TraceResult["subject"] | null = null;
  const correlations = new Set<string>();
  const journeyIds = new Set<string>(); // correlações PERSISTIDAS (coluna correlation_id) da jornada, herdadas da origem

  if (req.opportunityId) subject = { kind: "oportunidade", id: String(req.opportunityId) };
  if (req.runId) {
    if (!req.canSeeAutomation) return null;
    const run = await db.selectFrom("agentEventRuns").select(["id", "eventId"]).where("id", "=", req.runId).where("organizationId", "=", org).executeTakeFirst();
    if (!run) return null;
    runIds = [String(run.id)];
    const ev = await db.selectFrom("domainEvents").select(["entityType", "entityId"]).where("id", "=", run.eventId).executeTakeFirst();
    if (ev?.entityType === "donation_opportunity" && ev.entityId && /^[0-9]{1,12}$/.test(ev.entityId)) opportunityId = Number(ev.entityId);
    subject = { kind: "execucao", id: String(run.id) };
  }
  if (req.exceptionId) {
    if (!req.canSeeAutomation) return null;
    const ex = await db.selectFrom("exceptionQueue").select("id").where("id", "=", req.exceptionId).where("organizationId", "=", org).executeTakeFirst();
    if (!ex) return null;
    const run = await db.selectFrom("agentEventRuns").select(["id", "eventId"]).where("exceptionId", "=", req.exceptionId).where("organizationId", "=", org).orderBy("id", "asc").executeTakeFirst();
    if (run) {
      runIds = [String(run.id)];
      const ev = await db.selectFrom("domainEvents").select(["entityType", "entityId"]).where("id", "=", run.eventId).executeTakeFirst();
      if (ev?.entityType === "donation_opportunity" && ev.entityId && /^[0-9]{1,12}$/.test(ev.entityId)) opportunityId = Number(ev.entityId);
    }
    subject = { kind: "excecao", id: String(ex.id) };
  }
  if (req.correlationId) {
    correlations.add(req.correlationId);
    journeyIds.add(req.correlationId);
    const jo = req.canSeeOpportunity ? await db.selectFrom("donationOpportunities").select("id").where("correlationId", "=", req.correlationId).where("organizationId", "=", org).executeTakeFirst() : undefined;
    const jr = req.canSeeAutomation ? await db.selectFrom("agentEventRuns").select("id").where("correlationId", "=", req.correlationId).where("organizationId", "=", org).orderBy("id", "asc").executeTakeFirst() : undefined;
    if (jo) opportunityId = jo.id;
    else if (jr) runIds = [String(jr.id)];
    const re = await db.selectFrom("agentEventReevaluations").select("runId").where("correlationId", "=", req.correlationId).where("organizationId", "=", org).executeTakeFirst();
    const ch = await db.selectFrom("opportunityChanges").select("opportunityId").where("correlationId", "=", req.correlationId).where("organizationId", "=", org).executeTakeFirst();
    if (re && req.canSeeAutomation) {
      runIds = [String(re.runId)];
      const run = await db.selectFrom("agentEventRuns").select("eventId").where("id", "=", re.runId).executeTakeFirst();
      const ev = run ? await db.selectFrom("domainEvents").select(["entityType", "entityId"]).where("id", "=", run.eventId).executeTakeFirst() : undefined;
      if (ev?.entityType === "donation_opportunity" && ev.entityId) opportunityId = Number(ev.entityId);
    } else if (ch && req.canSeeOpportunity) opportunityId = ch.opportunityId;
    subject = { kind: "correlacao", id: req.correlationId };
  }
  if (!subject) return null;

  // --- oportunidade (sempre da organização do pedido) ---
  let opp: { id: number; title: string; status: string; category: string | null; version: number; createdAt: Date; correlationId: string | null } | null = null;
  if (opportunityId !== null) {
    const row = await db.selectFrom("donationOpportunities").select(["id", "title", "status", "category", "version", "createdAt", "correlationId"]).where("id", "=", opportunityId).where("organizationId", "=", org).executeTakeFirst();
    if (!row) { if (subject.kind === "oportunidade") return null; } else opp = row;
  }

  if (opp?.correlationId) journeyIds.add(opp.correlationId);
  const steps: TraceStep[] = [];
  const entityPairs: Array<[string, string]> = [];
  if (opp) entityPairs.push(["donation_opportunity", String(opp.id)]);

  // --- eventos e execuções (somente com automacao.leia) ---
  type RunInfo = { id: string; eventId: string; agentName: string; status: string; reasonCode: string | null; reason: string | null; ruleCode: string | null; exceptionId: string | null; detail: unknown; createdAt: Date; updatedAt: Date; correlationId: string | null };
  let runs: RunInfo[] = [];
  const events: Array<{ id: string; eventType: string; createdAt: Date }> = [];
  if (req.canSeeAutomation) {
    if (opp && runIds.length === 0) {
      const evs = await db.selectFrom("domainEvents").select(["id", "eventType", "createdAt"]).where("organizationId", "=", org).where("entityType", "=", "donation_opportunity").where("entityId", "=", String(opp.id)).orderBy("id", "asc").limit(20).execute();
      for (const e of evs) events.push({ id: String(e.id), eventType: e.eventType, createdAt: e.createdAt });
      if (evs.length) {
        const rr = await db.selectFrom("agentEventRuns as r").innerJoin("agentPrincipals as p", "p.id", "r.agentPrincipalId").select(["r.id", "r.eventId", "p.name", "r.status", "r.reasonCode", "r.reason", "r.ruleCode", "r.exceptionId", "r.detail", "r.createdAt", "r.updatedAt", "r.correlationId"]).where("r.organizationId", "=", org).where("r.eventId", "in", evs.map((e) => e.id)).orderBy("r.id", "asc").limit(50).execute();
        runs = rr.map((r) => ({ id: String(r.id), eventId: String(r.eventId), agentName: r.name, status: r.status, reasonCode: r.reasonCode, reason: r.reason, ruleCode: r.ruleCode, exceptionId: r.exceptionId === null ? null : String(r.exceptionId), detail: r.detail, createdAt: r.createdAt, updatedAt: r.updatedAt, correlationId: r.correlationId }));
      }
    } else if (runIds.length) {
      const rr = await db.selectFrom("agentEventRuns as r").innerJoin("agentPrincipals as p", "p.id", "r.agentPrincipalId").select(["r.id", "r.eventId", "p.name", "r.status", "r.reasonCode", "r.reason", "r.ruleCode", "r.exceptionId", "r.detail", "r.createdAt", "r.updatedAt", "r.correlationId"]).where("r.organizationId", "=", org).where("r.id", "in", runIds).execute();
      runs = rr.map((r) => ({ id: String(r.id), eventId: String(r.eventId), agentName: r.name, status: r.status, reasonCode: r.reasonCode, reason: r.reason, ruleCode: r.ruleCode, exceptionId: r.exceptionId === null ? null : String(r.exceptionId), detail: r.detail, createdAt: r.createdAt, updatedAt: r.updatedAt, correlationId: r.correlationId }));
      const evs = await db.selectFrom("domainEvents").select(["id", "eventType", "createdAt"]).where("organizationId", "=", org).where("id", "in", runs.map((r) => r.eventId)).execute();
      for (const e of evs) events.push({ id: String(e.id), eventType: e.eventType, createdAt: e.createdAt });
    }
    if (exceptionId === null) { const first = runs.find((r) => r.exceptionId); if (first) exceptionId = first.exceptionId; }
  }
  for (const r of runs) { entityPairs.push(["agent_event_run", r.id]); if (r.correlationId) journeyIds.add(r.correlationId); }
  const exceptionIds = [...new Set([...(exceptionId ? [exceptionId] : []), ...runs.map((r) => r.exceptionId).filter((x): x is string => x !== null)])];
  for (const x of exceptionIds) entityPairs.push(["exception", x]);

  // --- alterações de categoria (oportunidades.leia) ---
  const changes = opp && req.canSeeOpportunity
    ? await db.selectFrom("opportunityChanges as c").leftJoin("users as u", "u.id", "c.changedByUserId").select(["c.id", "c.previousValue", "c.newValue", "c.versionAfter", "c.correlationId", "c.createdAt", "u.displayName"]).where("c.opportunityId", "=", opp.id).where("c.organizationId", "=", org).orderBy("c.id", "asc").limit(100).execute()
    : [];
  for (const c of changes) correlations.add(c.correlationId);

  // --- reavaliações, histórico, exceções e decisões humanas ---
  const reevals = runs.length
    ? await db.selectFrom("agentEventReevaluations as h").leftJoin("users as u", "u.id", "h.requestedByUserId").select(["h.id", "h.runId", "h.outcome", "h.previousDecision", "h.newDecision", "h.correlationId", "h.createdAt", "u.displayName"]).where("h.organizationId", "=", org).where("h.runId", "in", runs.map((r) => r.id)).orderBy("h.id", "asc").limit(100).execute()
    : [];
  for (const h of reevals) correlations.add(h.correlationId);
  const history = runs.length
    ? await db.selectFrom("agentEventRunHistory as h").leftJoin("users as u", "u.id", "h.actorUserId").select(["h.id", "h.runId", "h.fromStatus", "h.toStatus", "h.reasonCode", "h.actorType", "h.createdAt", "u.displayName"]).where("h.runId", "in", runs.map((r) => r.id)).orderBy("h.id", "asc").limit(300).execute()
    : [];
  const exceptions = exceptionIds.length && req.canSeeAutomation
    ? await db.selectFrom("exceptionQueue as q").select(["q.id", "q.toolName", "q.ruleCode", "q.approvalsRequired", "q.status", "q.createdAt", "q.correlationId"]).where("q.organizationId", "=", org).where("q.id", "in", exceptionIds).execute()
    : [];
  const decisions = exceptions.length
    ? await db.selectFrom("exceptionDecisions as d").leftJoin("users as u", "u.id", "d.userId").select(["d.exceptionId", "d.userId", "d.decision", "d.decidedAt", "u.displayName"]).where("d.exceptionId", "in", exceptions.map((e) => e.id)).orderBy("d.decidedAt", "asc").execute()
    : [];

  // --- registros de auditoria relacionados (entidades + correlações), da própria organização ---
  for (const q of exceptions) if (q.correlationId) journeyIds.add(q.correlationId);
  const audit = await relatedAudit(org, entityPairs, [...correlations], [...journeyIds]);
  const findAudit = (pred: (e: AuditEntryRow) => boolean): string | null => audit.find(pred)?.id ?? null;

  // --- passos ---
  if (opp) steps.push({ key: "oportunidade", at: iso(opp.createdAt), title: `Oportunidade registrada: ${opp.title}`, detail: `situação atual: ${opp.status}`, actor: null, ref: { kind: "oportunidade", id: String(opp.id) }, correlationId: null, auditEntryId: null, linkKind: null });
  for (const e of events) steps.push({ key: "evento", at: iso(e.createdAt), title: `Evento ${e.eventType} publicado`, detail: null, actor: null, ref: { kind: "evento", id: e.id }, correlationId: null, auditEntryId: null, linkKind: null });
  const usedTransition = new Set<string>();
  for (const h of history) {
    const run = runs.find((r) => r.id === String(h.runId));
    const act = h.actorType === "user" ? h.displayName ?? "uma pessoa" : h.actorType === "agent" ? run?.agentName ?? "agente" : "sistema";
    const aud = h.actorType !== "user" ? audit.find((e) => !usedTransition.has(e.id) && e.entityType === "agent_event_run" && e.entityId === String(h.runId) && e.action === `agente.evento_${h.toStatus}`) : undefined;
    if (aud) usedTransition.add(aud.id);
    steps.push({ key: "transicao", at: iso(h.createdAt), title: `Execução #${h.runId}: ${h.fromStatus ?? "início"} → ${h.toStatus}`, detail: h.reasonCode, actor: act, ref: { kind: "execucao", id: String(h.runId) }, correlationId: null, auditEntryId: aud?.id ?? null, linkKind: null });
  }
  const decisionList: HistoricalDecision[] = [];
  for (const r of runs) {
    const ex = r.detail as Explained | null;
    const hasExplanation = !!ex && typeof ex === "object" && typeof ex.decision === "string";
    const evaluatedAt = hasExplanation && ex!.evaluatedAt ? ex!.evaluatedAt : iso(r.updatedAt);
    const considered = hasExplanation && typeof ex!.facts?.categoria === "string" ? (ex!.facts!.categoria as string) : null;
    const origin = hasExplanation && typeof ex!.facts?.origemCategoria === "string" ? (ex!.facts!.origemCategoria as string) : null;
    const versionFact = hasExplanation ? ex!.facts?.versaoOportunidade : undefined;
    const versionConsidered = typeof versionFact === "number" ? versionFact : (origin?.match(/versão (\d+)/)?.[1] ? Number(origin.match(/versão (\d+)/)![1]) : null);
    const later = opp && req.canSeeOpportunity && hasExplanation ? changes.filter((c) => c.createdAt.getTime() > new Date(evaluatedAt).getTime()) : [];
    if (hasExplanation) steps.push({ key: "decisao", at: evaluatedAt, title: `Decisão de ${r.agentName} (simulação): ${ex!.decision}`, detail: r.reason, actor: r.agentName, ref: { kind: "execucao", id: r.id }, correlationId: null, auditEntryId: null, linkKind: null });
    decisionList.push({
      runId: r.id, agentName: r.agentName, status: r.status, decision: hasExplanation ? ex!.decision! : null, reason: r.reason, ruleCode: r.ruleCode, evaluatedAt, evaluationCount: hasExplanation ? ex!.evaluationCount ?? 1 : 1,
      policy: hasExplanation ? { rules: (ex!.rules ?? []).map((x) => ({ code: x.code, title: x.title, result: x.result, reason: x.reason })), limits: ex!.limits ?? {} } : null,
      categoryConsidered: considered, categoryOrigin: origin, versionConsidered,
      currentCategory: opp && req.canSeeOpportunity ? opp.category : null, currentVersion: opp && req.canSeeOpportunity ? opp.version : null,
      categoryDiffers: opp && req.canSeeOpportunity && hasExplanation ? norm(considered) !== norm(opp.category) : null,
      laterChanges: later.map((c) => ({ id: String(c.id), at: iso(c.createdAt), byName: c.displayName, previousValue: c.previousValue, newValue: c.newValue, versionAfter: c.versionAfter, correlationId: c.correlationId, auditEntryId: findAudit((e) => e.action === "oportunidade.categoria_alterada" && e.operationId === c.correlationId) })),
      recalculated: false,
    });
  }
  for (const q of exceptions) {
    steps.push({ key: "excecao", at: iso(q.createdAt), title: `Exceção #${q.id} criada (regra ${q.ruleCode}; ${q.approvalsRequired === 2 ? "dupla autorização" : "revisão simples"})`, detail: `ferramenta ${q.toolName} · situação atual: ${q.status}`, actor: null, ref: { kind: "excecao", id: String(q.id) }, correlationId: null, auditEntryId: findAudit((e) => e.action === "agente.excecao_criada" && e.entityId === String(q.id)), linkKind: null });
  }
  for (const d of decisions) {
    steps.push({ key: "revisao_humana", at: iso(d.decidedAt), title: `Exceção #${d.exceptionId}: ${d.decision === "aprovar" ? "aprovada" : "rejeitada"} por ${d.displayName ?? "uma pessoa"}`, detail: null, actor: d.displayName, ref: { kind: "excecao", id: String(d.exceptionId) }, correlationId: null, auditEntryId: findAudit((e) => e.action === "automacao.excecao_decidida" && e.entityId === String(d.exceptionId) && e.actorUserId === d.userId), linkKind: null });
  }
  for (const h of reevals) {
    steps.push({ key: "reavaliacao", at: iso(h.createdAt), title: `Nova análise solicitada por ${h.displayName ?? "uma pessoa"} — ${h.outcome}`, detail: `${h.previousDecision ?? "sem decisão"} → ${h.newDecision ?? "—"}`, actor: h.displayName, ref: { kind: "reavaliacao", id: String(h.id) }, correlationId: h.correlationId, auditEntryId: findAudit((e) => e.operationId === h.correlationId && e.action.startsWith("agente.reavaliacao")), linkKind: null });
  }
  for (const c of changes) {
    steps.push({ key: "alteracao_categoria", at: iso(c.createdAt), title: `Categoria alterada por ${c.displayName ?? "uma pessoa"}: ${c.previousValue ?? "sem categoria"} → ${c.newValue ?? "sem categoria"} (versão ${c.versionAfter})`, detail: null, actor: c.displayName, ref: { kind: "oportunidade", id: String(opp!.id) }, correlationId: c.correlationId, auditEntryId: findAudit((e) => e.action === "oportunidade.categoria_alterada" && e.operationId === c.correlationId), linkKind: null });
  }
  for (const st of steps) st.linkKind = st.auditEntryId ? audit.find((e) => e.id === st.auditEntryId)?.link ?? null : null;
  steps.sort((a, b) => a.at.localeCompare(b.at));
  // Correlação sem NENHUM vínculo nesta organização: não existe aqui (404), em vez de uma tela vazia que sugira o contrário.
  if (subject.kind === "correlacao" && !opp && runs.length === 0 && audit.length === 0) return null;

  if (!req.canSeeAutomation) limits.push("Seu papel não lê a automação: execuções, exceções e reavaliações dos agentes não são exibidas.");
  if (!req.canSeeOpportunity) limits.push("Seu papel não lê oportunidades: categoria atual e alterações de categoria não são exibidas.");
  return {
    subject,
    opportunity: opp && req.canSeeOpportunity ? { id: opp.id, title: opp.title, status: opp.status, currentCategory: opp.category, version: opp.version } : null,
    steps, decisions: decisionList, auditEntries: audit, journey: { correlationId: opp?.correlationId ?? runs.find((r) => r.correlationId)?.correlationId ?? [...journeyIds][0] ?? null }, limits,
  };
}

async function relatedAudit(organizationId: number, pairs: Array<[string, string]>, operationIds: string[], journeyIds: string[]): Promise<Array<AuditEntryRow & { link: "direta" | "correlacao" }>> {
  if (pairs.length === 0 && operationIds.length === 0 && journeyIds.length === 0) return [];
  const rows = await db
    .selectFrom("auditLog")
    .leftJoin("users as u", "u.id", "auditLog.actorUserId")
    .leftJoin("agentPrincipals as ap", "ap.id", "auditLog.actorAgentPrincipalId")
    .select(["auditLog.id", "auditLog.action", "auditLog.entityType", "auditLog.entityId", "auditLog.actorType", "auditLog.actorUserId", "u.displayName as userName", "ap.name as agentName", "auditLog.createdAt", "auditLog.eventHash", "auditLog.outcome", "auditLog.correlationId", "auditLog.recordVersion", sql<unknown>`audit_log.metadata -> 'correlacao'`.as("correlacao")])
    .where("auditLog.organizationId", "=", organizationId)
    .where((eb) => eb.or([
      ...pairs.map(([t, id]) => eb.and([eb("auditLog.entityType", "=", t), eb("auditLog.entityId", "=", id)])),
      ...(operationIds.length ? [sql<boolean>`audit_log.metadata ->> 'correlacao' IN (${sql.join(operationIds)})`] : []),
      ...(journeyIds.length ? [sql<boolean>`audit_log.correlation_id IN (${sql.join(journeyIds)})`] : []),
    ]))
    .orderBy("auditLog.id", "asc")
    .limit(200)
    .execute();
  const pairSet = new Set(pairs.map(([t, id]) => `${t}:${id}`));
  return rows.map((r) => ({
    id: String(r.id), action: r.action, entityType: r.entityType, entityId: r.entityId, actorType: r.actorType, actorUserId: r.actorUserId,
    actorName: r.actorType === "agent" ? r.agentName : r.actorType === "system" ? "Sistema" : r.userName,
    createdAt: r.createdAt.toISOString(), outcome: r.outcome, correlationId: r.correlationId, operationId: typeof r.correlacao === "string" ? r.correlacao : null, recordVersion: r.recordVersion, chained: r.eventHash !== null,
    // direta = a MESMA entidade; correlacao = outra entidade ligada só pela correlação persistida. Nenhuma ordem cronológica é tomada como prova de causalidade.
    link: (pairSet.has(`${r.entityType}:${r.entityId}`) ? "direta" : "correlacao") as "direta" | "correlacao",
  }));
}
