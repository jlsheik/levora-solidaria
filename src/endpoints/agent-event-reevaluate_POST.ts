import { randomUUID } from "node:crypto";
import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { fenceForDecision } from "../helpers/policyFence.js";
import { evaluateEligibility } from "../helpers/agentReevaluation.js";
import { advanceRun } from "../helpers/agentEventEngine.js";
import { transitionRun } from "../helpers/agentEventRuns.js";
import type { Json } from "../helpers/schema.js";
import { schema } from "./agent-event-reevaluate_POST.schema.js";
import superjson from "superjson";

const json = (status: number, body: unknown) => new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * M36 — “Solicitar nova análise” de uma execução em `dados_insuficientes` (`automacao.gerencie`, organização ativa). NÃO cria evento e NÃO executa nada: registra um pedido VINCULADO à execução
 * original (que continua imutável), lê os dados novos dos REGISTROS de origem no servidor (nunca do pedido), revalida agente, pausa, política e limites (a conclusão ainda passa pela cerca de política) e
 * deixa a decisão anterior intacta. Idempotente sob concorrência: a execução é travada e só estando em `dados_insuficientes` o pedido avança; o segundo pedido recebe conflito.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));
    await requirePermission(user.id, input.organizationId, "automacao.gerencie");
    const correlationId = randomUUID();

    const started = await db.transaction().execute(async (trx) => {
      await fenceForDecision(trx, input.organizationId); // lê pausa/agente sob a cerca: nenhuma alteração concorrente passa entre a checagem e o commit do pedido
      const locked = await trx.selectFrom("agentEventRuns").select(["id", "status", "correlationId"]).where("id", "=", input.runId).where("organizationId", "=", input.organizationId).forUpdate().executeTakeFirst();
      if (!locked) return { kind: "not_found" as const };
      const el = await evaluateEligibility(trx, input.organizationId, input.runId);
      if (!el) return { kind: "not_found" as const };
      const previousDecision = ((el.run.detail ?? {}) as { decision?: string }).decision ?? null;
      const refuse = async (outcome: "ainda_insuficiente" | "bloqueada", code: string, message: string) => {
        await trx.insertInto("agentEventReevaluations").values({ runId: input.runId, organizationId: input.organizationId, requestedByUserId: user.id, reason: input.reason || null, supplement: (el.supplement.sources.length ? { sources: el.supplement.sources } : {}) as unknown as Json, previousStatus: el.run.status, previousDecision, previousExplanation: el.run.detail, outcome, newStatus: el.run.status, newDecision: previousDecision, correlationId, finishedAt: new Date() }).execute();
        await recordAuditLogEntry({ organizationId: input.organizationId, actorUserId: user.id, action: "agente.reavaliacao_recusada", outcome: "recusada", correlationId: locked.correlationId, entityType: "agent_event_run", entityId: input.runId, metadata: { correlacao: correlationId, motivo: code, simulado: true } }, trx);
        return { kind: "refused" as const, code, message };
      };
      if (el.state === "nao_aplicavel") return { kind: "conflict" as const, code: "estado_invalido", message: el.message };
      if (el.state === "indisponivel") return refuse("bloqueada", el.blockCode ?? "indisponivel", el.message);
      if (el.state === "ainda_insuficiente") return refuse("ainda_insuficiente", "dados_ainda_insuficientes", el.message);

      const row = await trx.insertInto("agentEventReevaluations").values({ runId: input.runId, organizationId: input.organizationId, requestedByUserId: user.id, reason: input.reason || null, supplement: { fields: el.supplement.fields, sources: el.supplement.sources } as unknown as Json, previousStatus: el.run.status, previousDecision, previousExplanation: el.run.detail, outcome: "iniciada", correlationId }).returning("id").executeTakeFirstOrThrow();
      const detail = { ...((el.run.detail ?? {}) as object), supplement: { fields: el.supplement.fields, sources: el.supplement.sources, requestedAt: new Date().toISOString(), requestedByUserId: user.id, correlationId } } as unknown as Json;
      await transitionRun(trx, { runId: input.runId, from: "dados_insuficientes", to: "validado", reasonCode: "reavaliacao_solicitada", reason: "Nova análise solicitada por uma pessoa com dados novos dos registros de origem.", actor: { type: "user", userId: user.id }, detail });
      await recordAuditLogEntry({ organizationId: input.organizationId, actorUserId: user.id, action: "agente.reavaliacao_solicitada", outcome: "pendente", correlationId: locked.correlationId, entityType: "agent_event_run", entityId: input.runId, metadata: { correlacao: correlationId, decisaoAnterior: previousDecision, campos: Object.keys(el.supplement.fields), simulado: true } }, trx);
      return { kind: "started" as const, reevaluationId: String(row.id) };
    });

    if (started.kind === "not_found") return json(404, { message: "Execução não encontrada nesta organização" });
    if (started.kind === "conflict") return json(409, { message: started.message, code: started.code });
    if (started.kind === "refused") return json(409, { message: started.message, code: started.code });

    // Fora da transação do pedido: a avaliação usa o caminho normal do motor (validação, política, limites, pausa e cerca na conclusão).
    await advanceRun(input.runId);
    const after = await db.selectFrom("agentEventRuns").select(["status", "detail"]).where("id", "=", input.runId).executeTakeFirstOrThrow();
    const newDecision = ((after.detail ?? {}) as { decision?: string }).decision ?? null;
    await db.updateTable("agentEventReevaluations").set({ outcome: "concluida", newStatus: after.status, newDecision, finishedAt: new Date() }).where("id", "=", started.reevaluationId).where("outcome", "=", "iniciada").execute();
    return json(200, { correlationId, newStatus: after.status, newDecision, simulated: true });
  } catch (error: unknown) {
    console.error("Erro ao solicitar nova análise:", error);
    return buildErrorResponse(error, "Não foi possível solicitar a nova análise");
  }
}
