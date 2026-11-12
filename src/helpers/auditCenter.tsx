import { sql, type ExpressionBuilder, type SelectQueryBuilder } from "kysely";
import { db } from "./db.js";
import type { AuditOutcome, DB } from "./schema.js";

/**
 * M38 — consultas da Central de Auditoria. Tudo é SOMENTE LEITURA sobre `audit_log` (a cadeia existente) e sobre as tabelas de domínio já persistidas. Nada aqui grava, repara
 * ou recalcula; nenhum vínculo é inventado: só os identificadores que o sistema já persiste (entidade+id, `agent_event_runs.exception_id`, `agent_event_reevaluations.correlation_id`,
 * `opportunity_changes.correlation_id` e `metadata.correlacao` dos eventos M36/M37).
 *
 * Paginação: por CURSOR no `id` (BIGSERIAL, ordem de inserção = ordem de commit pela trava da cadeia). Página N+1 = `id < último id da página N`. Registros novos têm id MAIOR, então
 * nunca duplicam nem deslocam páginas já lidas; `sinceId` conta quantos chegaram depois do topo mostrado, sem recarregar a lista.
 */

export const AREA_PREFIXES: Record<string, string[]> = {
  agentes: ["agente"],
  automacao: ["automacao"],
  oportunidades: ["oportunidade"],
  politicas: ["politica"],
  organizacao: ["organizacao"],
  necessidades: ["necessidade"],
  inventario: ["inventario"],
  destinacao: ["destinacao", "atribuicao", "regularizacao"],
  aprovacoes: ["aprovacao"],
  acesso: ["usuario", "mfa", "step_up", "codigo_acesso"],
  arquivos: ["arquivo", "anexar", "anexado", "removido", "remover"],
};
export const AREA_KEYS = Object.keys(AREA_PREFIXES) as [string, ...string[]];

/**
 * M39 — o RESULTADO vem da coluna `audit_log.outcome`, gravada no ponto do código que conhece o desfecho. NULL = "resultado não registrado" (todo o histórico anterior à M39 e as
 * operações ainda não instrumentadas): nunca é presumido sucesso e NUNCA é deduzido do nome da ação (a inferência da M38 foi removida).
 */
export const OUTCOME_FILTERS = ["concluida", "recusada", "falhou", "pendente", "nao_registrado"] as const;
export type OutcomeFilter = (typeof OUTCOME_FILTERS)[number];

export interface AuditFilters {
  from?: Date;
  to?: Date;
  area?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  actorUserId?: number;
  actorType?: "user" | "agent" | "system";
  outcome?: OutcomeFilter;
  correlationId?: string;
}

function applyFilters<O>(q: SelectQueryBuilder<DB, "auditLog", O>, organizationId: number, f: AuditFilters): SelectQueryBuilder<DB, "auditLog", O> {
  let query = q.where("auditLog.organizationId", "=", organizationId);
  if (f.from) query = query.where("auditLog.createdAt", ">=", f.from);
  if (f.to) query = query.where("auditLog.createdAt", "<", f.to);
  if (f.area) {
    const prefixes = AREA_PREFIXES[f.area] ?? [];
    query = query.where((eb: ExpressionBuilder<DB, "auditLog">) => eb.or(prefixes.map((p) => eb("auditLog.action", "like", `${p}.%`))));
  }
  if (f.action) query = query.where("auditLog.action", "=", f.action);
  if (f.entityType) query = query.where("auditLog.entityType", "=", f.entityType);
  if (f.entityId) query = query.where("auditLog.entityId", "=", f.entityId);
  if (f.actorUserId) query = query.where("auditLog.actorUserId", "=", f.actorUserId);
  if (f.actorType) query = query.where("auditLog.actorType", "=", f.actorType);
  if (f.outcome === "nao_registrado") query = query.where("auditLog.outcome", "is", null);
  else if (f.outcome) query = query.where("auditLog.outcome", "=", f.outcome);
  // A correlação PERSISTIDA (coluna, M39) e o identificador da operação pontual (metadata.correlacao, M36/M37) são conceitos diferentes; a busca aceita os dois.
  if (f.correlationId) query = query.where(sql<boolean>`(audit_log.correlation_id = ${f.correlationId} OR audit_log.metadata ->> 'correlacao' = ${f.correlationId})`);
  return query;
}

export interface AuditEntryRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorType: "user" | "agent" | "system";
  actorUserId: number | null;
  actorName: string | null;
  createdAt: string;
  /** Resultado EXPLÍCITO. null = resultado não registrado (histórico/operação não instrumentada) — nunca presumido. */
  outcome: AuditOutcome | null;
  /** Correlação persistida (M39), gerada no servidor na origem da operação. null = registro sem correlação (anterior à M39 ou operação isolada). */
  correlationId: string | null;
  /** Identificador da OPERAÇÃO pontual (metadata.correlacao, M36/M37) — diferente da correlação da jornada e do id do recurso. */
  operationId: string | null;
  /** Versão do formato do registro: 1 = histórico (hash não cobre resultado/correlação), 2 = hash cobre ambos. */
  recordVersion: number;
  /** true quando o evento tem hash na cadeia. O valor do hash é interno e nunca é exposto. */
  chained: boolean;
}

function toRow(r: { id: string | number | bigint; action: string; entityType: string; entityId: string | null; actorType: "user" | "agent" | "system"; actorUserId: number | null; userName: string | null; agentName: string | null; createdAt: Date; correlacao: unknown; eventHash: string | null; outcome: AuditOutcome | null; correlationId: string | null; recordVersion: number }): AuditEntryRow {
  return {
    id: String(r.id), action: r.action, entityType: r.entityType, entityId: r.entityId, actorType: r.actorType, actorUserId: r.actorUserId,
    actorName: r.actorType === "agent" ? r.agentName : r.actorType === "system" ? "Sistema" : r.userName,
    createdAt: r.createdAt.toISOString(),
    outcome: r.outcome,
    correlationId: r.correlationId,
    operationId: typeof r.correlacao === "string" ? r.correlacao : null,
    recordVersion: r.recordVersion,
    chained: r.eventHash !== null,
  };
}

function baseSelect(organizationId: number, f: AuditFilters) {
  const q = db
    .selectFrom("auditLog")
    .leftJoin("users as u", "u.id", "auditLog.actorUserId")
    .leftJoin("agentPrincipals as ap", "ap.id", "auditLog.actorAgentPrincipalId")
    .select(["auditLog.id", "auditLog.action", "auditLog.entityType", "auditLog.entityId", "auditLog.actorType", "auditLog.actorUserId", "u.displayName as userName", "ap.name as agentName", "auditLog.createdAt", "auditLog.eventHash", "auditLog.outcome", "auditLog.correlationId", "auditLog.recordVersion", sql<unknown>`audit_log.metadata -> 'correlacao'`.as("correlacao")]);
  return applyFilters(q, organizationId, f);
}

export async function listAuditEntries(organizationId: number, f: AuditFilters, page: { limit: number; beforeId?: string }): Promise<{ entries: AuditEntryRow[]; nextCursor: string | null }> {
  let q = baseSelect(organizationId, f);
  if (page.beforeId) q = q.where("auditLog.id", "<", page.beforeId);
  // Ordenação ESTÁVEL e total: id é único. (created_at sozinho empata e não é cursor seguro.)
  const rows = await q.orderBy("auditLog.id", "desc").limit(page.limit + 1).execute();
  const hasMore = rows.length > page.limit;
  const slice = rows.slice(0, page.limit).map(toRow);
  return { entries: slice, nextCursor: hasMore && slice.length ? slice[slice.length - 1].id : null };
}

/** Quantos registros que passam nos MESMOS filtros chegaram depois do topo já exibido. */
export async function countNewer(organizationId: number, f: AuditFilters, sinceId: string): Promise<number> {
  const row = await applyFilters(db.selectFrom("auditLog").select((eb) => eb.fn.countAll<string>().as("n")), organizationId, f).where("auditLog.id", ">", sinceId).executeTakeFirstOrThrow();
  return Number(row.n);
}

const COUNT_CAP = 10000;
/** Total filtrado, limitado a COUNT_CAP: acima disso devolve `capped: true` ("10.000 ou mais") em vez de varrer o histórico inteiro. */
export async function countFiltered(organizationId: number, f: AuditFilters): Promise<{ count: number; capped: boolean }> {
  const inner = applyFilters(db.selectFrom("auditLog").select("auditLog.id"), organizationId, f).limit(COUNT_CAP + 1);
  const row = await db.selectFrom(inner.as("t")).select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow();
  const n = Number(row.n);
  return n > COUNT_CAP ? { count: COUNT_CAP, capped: true } : { count: n, capped: false };
}

export interface AuditEntryDetail extends AuditEntryRow {
  metadata: unknown;
  /** Outros registros da MESMA organização com o mesmo identificador de correlação (máx. 50). */
  correlated: AuditEntryRow[];
  /** Registros da mesma entidade (máx. 50), do mais recente ao mais antigo. */
  sameEntity: AuditEntryRow[];
}

export async function getAuditEntry(organizationId: number, id: string): Promise<AuditEntryDetail | null> {
  const row = await db
    .selectFrom("auditLog")
    .leftJoin("users as u", "u.id", "auditLog.actorUserId")
    .leftJoin("agentPrincipals as ap", "ap.id", "auditLog.actorAgentPrincipalId")
    .select(["auditLog.id", "auditLog.action", "auditLog.entityType", "auditLog.entityId", "auditLog.actorType", "auditLog.actorUserId", "u.displayName as userName", "ap.name as agentName", "auditLog.createdAt", "auditLog.eventHash", "auditLog.outcome", "auditLog.correlationId", "auditLog.recordVersion", "auditLog.metadata", sql<unknown>`audit_log.metadata -> 'correlacao'`.as("correlacao")])
    .where("auditLog.id", "=", id)
    .where("auditLog.organizationId", "=", organizationId)
    .executeTakeFirst();
  if (!row) return null;
  const base = toRow(row);
  const key = base.correlationId ?? base.operationId;
  const correlated = key ? (await listAuditEntries(organizationId, { correlationId: key }, { limit: 50 })).entries.filter((e) => e.id !== base.id) : [];
  const sameEntity = row.entityId ? (await listAuditEntries(organizationId, { entityType: row.entityType, entityId: row.entityId }, { limit: 50 })).entries.filter((e) => e.id !== base.id) : [];
  return { ...base, metadata: row.metadata, correlated, sameEntity };
}

export type Counted = { count: number; capped: boolean };
export interface AutomationSummary {
  agentDecisions: { total: number; byStatus: Record<string, number> };
  exceptionsCreated: number;
  exceptionsResolved: number;
  reevaluations: { total: number; byOutcome: Record<string, number> };
}
export interface AuditSummary {
  period: { from: string | null; to: string | null };
  /** Totais do PERÍODO filtrado — nunca confundir com `history` (todas as datas). Limitados a 10.000 (`capped`). */
  operations: Counted;
  /** Contagem por resultado EXPLÍCITO no período. `naoRegistrado` = sem resultado gravado (histórico e operações não instrumentadas) — não é sucesso. */
  byOutcome: { concluida: Counted; recusada: Counted; falhou: Counted; pendente: Counted; naoRegistrado: Counted };
  history: Counted;
  /** null = o perfil de quem consulta não lê a automação (desconhecido ≠ zero). */
  automation: AutomationSummary | null;
}

export async function summarize(organizationId: number, from: Date | null, to: Date | null, canSeeAutomation: boolean): Promise<AuditSummary> {
  const filters: AuditFilters = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const operations = await countFiltered(organizationId, filters);
  const byOutcome = {
    concluida: await countFiltered(organizationId, { ...filters, outcome: "concluida" }),
    recusada: await countFiltered(organizationId, { ...filters, outcome: "recusada" }),
    falhou: await countFiltered(organizationId, { ...filters, outcome: "falhou" }),
    pendente: await countFiltered(organizationId, { ...filters, outcome: "pendente" }),
    naoRegistrado: await countFiltered(organizationId, { ...filters, outcome: "nao_registrado" }),
  };
  const history = await countFiltered(organizationId, {});
  let automation: AutomationSummary | null = null;
  if (canSeeAutomation) {
    const lo = from ?? new Date(0);
    const hi = to ?? new Date("9999-01-01T00:00:00Z");
    const runs = await sql<{ status: string; n: string }>`SELECT status, count(*)::text AS n FROM agent_event_runs WHERE organization_id = ${organizationId} AND created_at >= ${lo} AND created_at < ${hi} GROUP BY status`.execute(db);
    const byStatus: Record<string, number> = {};
    let totalRuns = 0;
    for (const r of runs.rows) { byStatus[r.status] = Number(r.n); totalRuns += Number(r.n); }
    const created = await sql<{ n: string }>`SELECT count(*)::text AS n FROM exception_queue WHERE organization_id = ${organizationId} AND created_at >= ${lo} AND created_at < ${hi}`.execute(db);
    // "Resolvida no período" = a exceção já não está pendente e a ÚLTIMA decisão registrada caiu no período.
    const resolved = await sql<{ n: string }>`SELECT count(*)::text AS n FROM (
        SELECT q.id, (SELECT max(d.decided_at) FROM exception_decisions d WHERE d.exception_id = q.id) AS last_decided FROM exception_queue q WHERE q.organization_id = ${organizationId} AND q.status <> 'pendente') x
      WHERE x.last_decided >= ${lo} AND x.last_decided < ${hi}`.execute(db);
    const re = await sql<{ outcome: string; n: string }>`SELECT outcome, count(*)::text AS n FROM agent_event_reevaluations WHERE organization_id = ${organizationId} AND created_at >= ${lo} AND created_at < ${hi} GROUP BY outcome`.execute(db);
    const byOutcome: Record<string, number> = {};
    let totalRe = 0;
    for (const r of re.rows) { byOutcome[r.outcome] = Number(r.n); totalRe += Number(r.n); }
    automation = { agentDecisions: { total: totalRuns, byStatus }, exceptionsCreated: Number(created.rows[0]?.n ?? 0), exceptionsResolved: Number(resolved.rows[0]?.n ?? 0), reevaluations: { total: totalRe, byOutcome } };
  }
  return { period: { from: from ? from.toISOString() : null, to: to ? to.toISOString() : null }, operations, byOutcome, history, automation };
}
