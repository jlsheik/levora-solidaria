import { sql } from "kysely";
import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { countUnprocessedEvents, ENGINE_AGENT_NAMES } from "../helpers/agentEventEngine.js";
import { evaluateEligibility } from "../helpers/agentReevaluation.js";
import { schema, type Explanation, type OutputType, type ReevaluationInfo, type RelatedOpportunity, type RunView } from "./agent-events_GET.schema.js";
import superjson from "superjson";

/**
 * M34 — processamento de eventos dos agentes de UMA organização (somente leitura, `automacao.leia`). Tudo é filtrado pela organização do pedido: não existe parâmetro que troque de organização
 * depois da checagem de permissão. O conteúdo do evento (payload) NUNCA é devolvido — só tipo, entidade, estado, motivo e regra.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
      status: url.searchParams.get("status") ?? undefined,
      eventType: url.searchParams.get("eventType") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      beforeId: url.searchParams.get("beforeId") ?? undefined,
      runId: url.searchParams.get("runId") ?? undefined,
    });
    await requirePermissionToRead(user.id, input.organizationId, "automacao.leia");

    const base = () =>
      db
        .selectFrom("agentEventRuns as r")
        .innerJoin("domainEvents as e", "e.id", "r.eventId")
        .innerJoin("agentPrincipals as p", "p.id", "r.agentPrincipalId")
        .where("r.organizationId", "=", input.organizationId);

    let q = base()
      .select(["r.id", "r.eventId", "r.eventType", "e.entityType", "e.entityId", "p.name as agentName", "r.status", "r.reasonCode", "r.reason", "r.ruleCode", "r.exceptionId", "r.attempts", "r.createdAt", "r.updatedAt", "r.detail"])
      .orderBy("r.id", "desc")
      .limit(input.limit + 1);
    if (input.status) q = q.where("r.status", "=", input.status);
    if (input.eventType) q = q.where("r.eventType", "=", input.eventType);
    if (input.beforeId) q = q.where("r.id", "<", input.beforeId);
    const rows = await q.execute();
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const view = (r: (typeof rows)[number]): RunView => ({
      id: String(r.id), eventId: String(r.eventId), eventType: r.eventType, entityType: r.entityType, entityId: r.entityId, agentName: r.agentName, status: r.status, reasonCode: r.reasonCode, reason: r.reason, ruleCode: r.ruleCode,
      exceptionId: r.exceptionId === null ? null : String(r.exceptionId), attempts: r.attempts, reevaluated: Boolean((r.detail as { supplement?: unknown } | null)?.supplement), completeness: ((r.detail as { completeness?: RunView["completeness"] } | null)?.completeness ?? null), decision: ((r.detail as { decision?: string } | null)?.decision ?? null), simulated: true, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    });

    const counts = await db.selectFrom("agentEventRuns").select(["status", (eb) => eb.fn.countAll<string>().as("n")]).where("organizationId", "=", input.organizationId).groupBy("status").execute();
    const byStatus: OutputType["summary"]["byStatus"] = {};
    for (const c of counts) byStatus[c.status] = Number(c.n);
    const enabled = await db
      .selectFrom("agentPrincipals")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("enabled", "=", true)
      .where("name", "in", ENGINE_AGENT_NAMES)
      .where((eb) => eb.or([eb("organizationId", "is", null), eb("organizationId", "=", input.organizationId)]))
      .executeTakeFirstOrThrow();

    let detail: OutputType["detail"] = null;
    if (input.runId) {
      const one = await base()
        .select(["r.id", "r.eventId", "r.eventType", "e.entityType", "e.entityId", "p.name as agentName", "r.status", "r.reasonCode", "r.reason", "r.ruleCode", "r.exceptionId", "r.attempts", "r.createdAt", "r.updatedAt", "r.detail"])
        .where("r.id", "=", input.runId)
        .executeTakeFirst();
      if (!one) {
        return new Response(superjson.stringify({ message: "Execução não encontrada nesta organização" }), { status: 404, headers: { "Content-Type": "application/json" } });
      }
      const hist = await sql<{ fromStatus: string | null; toStatus: string; reasonCode: string | null; actorType: "agent" | "system" | "user"; actorName: string | null; createdAt: Date }>`
        SELECT h.from_status, h.to_status, h.reason_code, h.actor_type, COALESCE(u.display_name, p.name) AS actor_name, h.created_at
          FROM agent_event_run_history h
          LEFT JOIN users u ON u.id = h.actor_user_id
          LEFT JOIN agent_event_runs r ON r.id = h.run_id
          LEFT JOIN agent_principals p ON p.id = r.agent_principal_id AND h.actor_type = 'agent'
         WHERE h.run_id = ${input.runId} ORDER BY h.id ASC`.execute(db);
      const reeval = await reevaluationInfo(input.organizationId, input.runId, one.status);
      const related = await relatedOpportunity(input.organizationId, one.eventType, one.entityId, explanationOf((one as { detail: unknown }).detail));
      detail = { run: view(one), explanation: explanationOf((one as { detail: unknown }).detail), reevaluation: reeval, related, history: hist.rows.map((h) => ({ fromStatus: h.fromStatus, toStatus: h.toStatus, reasonCode: h.reasonCode, actorType: h.actorType, actorName: h.actorName, createdAt: new Date(h.createdAt).toISOString() })) };
    }

    const output: OutputType = {
      summary: { total: Object.values(byStatus).reduce((a, b) => a + (b ?? 0), 0), byStatus, unprocessedEvents: await countUnprocessedEvents(input.organizationId), enabledEngineAgents: Number(enabled.n), ...(await reevaluationCounts(input.organizationId, byStatus.dados_insuficientes ?? 0)) },
      runs: page.map(view),
      nextBeforeId: hasMore ? String(page[page.length - 1].id) : null,
      detail,
    };
    return new Response(superjson.stringify(output), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao listar o processamento de eventos:", error);
    return buildErrorResponse(error, "Não foi possível carregar o processamento de eventos");
  }
}

/** O detalhe gravado pelo motor já é saneado (só fatos/regras/limites); aqui só se garante a forma antes de devolver. */
function explanationOf(detail: unknown): Explanation | null {
  const d = detail as Partial<Explanation> | null;
  if (!d || typeof d !== "object" || !Array.isArray(d.rules) || !d.completeness) return null;
  return d as Explanation;
}

async function reevaluationInfo(organizationId: number, runId: string, status: string): Promise<ReevaluationInfo | null> {
  const history = await sql<{ id: string; createdAt: Date; displayName: string | null; outcome: ReevaluationInfo["history"][number]["outcome"]; previousStatus: string; previousDecision: string | null; newStatus: string | null; newDecision: string | null; correlationId: string; reason: string | null }>`
    SELECT h.id, h.created_at, u.display_name, h.outcome, h.previous_status, h.previous_decision, h.new_status, h.new_decision, h.correlation_id, h.reason
      FROM agent_event_reevaluations h LEFT JOIN users u ON u.id = h.requested_by_user_id
     WHERE h.run_id = ${runId} AND h.organization_id = ${organizationId} ORDER BY h.id ASC`.execute(db);
  const hist = history.rows.map((h) => ({ id: String(h.id), requestedAt: new Date(h.createdAt).toISOString(), requestedByName: h.displayName, outcome: h.outcome, previousStatus: h.previousStatus, previousDecision: h.previousDecision, newStatus: h.newStatus, newDecision: h.newDecision, correlationId: h.correlationId, reason: h.reason }));
  if (status !== "dados_insuficientes") return hist.length ? { eligibility: { state: "nao_aplicavel", blockCode: null, message: "Esta execução já foi reavaliada ou não está em dados insuficientes.", availableData: [], stillMissing: [] }, history: hist } : null;
  const el = await evaluateEligibility(db, organizationId, runId);
  if (!el) return null;
  return { eligibility: { state: el.state, blockCode: el.blockCode, message: el.message, availableData: el.availableData, stillMissing: el.stillMissing }, history: hist };
}

/** Contagens REAIS: concluídas (tabela) e permitidas agora (execuções em dados insuficientes com dados novos verificáveis; no máximo 100 avaliadas). */
async function reevaluationCounts(organizationId: number, insufficient: number): Promise<{ reevaluationsAllowed: number; reevaluationsDone: number }> {
  const done = await db.selectFrom("agentEventReevaluations").select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", organizationId).where("outcome", "=", "concluida").executeTakeFirstOrThrow();
  let allowed = 0;
  if (insufficient > 0) {
    const ids = await db.selectFrom("agentEventRuns").select("id").where("organizationId", "=", organizationId).where("status", "=", "dados_insuficientes").orderBy("id", "desc").limit(100).execute();
    for (const r of ids) if ((await evaluateEligibility(db, organizationId, String(r.id)))?.state === "elegivel") allowed += 1;
  }
  return { reevaluationsAllowed: allowed, reevaluationsDone: Number(done.n) };
}

/** Oportunidade relacionada (sempre filtrada pela organização do pedido; outra organização nunca é consultada nem linkada). */
async function relatedOpportunity(organizationId: number, eventType: string, entityId: string | null, explanation: Explanation | null): Promise<RelatedOpportunity | null> {
  if (eventType !== "opportunity.created" || !entityId || !/^[0-9]{1,12}$/.test(entityId)) return null;
  const opp = await db.selectFrom("donationOpportunities").select(["id", "title", "status", "category", "version"]).where("id", "=", Number(entityId)).where("organizationId", "=", organizationId).executeTakeFirst();
  if (!opp) return null;
  const last = await db.selectFrom("opportunityChanges as c").leftJoin("users as u", "u.id", "c.changedByUserId").select(["c.createdAt", "u.displayName"]).where("c.opportunityId", "=", opp.id).where("c.organizationId", "=", organizationId).orderBy("c.id", "desc").limit(1).executeTakeFirst();
  const considered = (explanation?.facts?.categoria as string | null | undefined) ?? null;
  const norm = (v: string | null) => (v ?? "").trim().toLowerCase();
  return { id: opp.id, title: opp.title, status: opp.status, currentCategory: opp.category, version: opp.version, categoryConsidered: considered, categoryChangedSinceDecision: explanation !== null && norm(considered) !== norm(opp.category), lastCategoryChange: last ? { at: last.createdAt.toISOString(), byName: last.displayName } : null };
}
