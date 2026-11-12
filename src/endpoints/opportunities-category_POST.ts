import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { isCategoryEditable, parseCategory } from "../helpers/opportunityCategory.js";
import { evaluateEligibility } from "../helpers/agentReevaluation.js";
import { schema, type ConflictBody, type OutputType } from "./opportunities-category_POST.schema.js";
import superjson from "superjson";

const json = (status: number, body: unknown) => new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * M37 — corrigir/complementar a CATEGORIA de uma oportunidade (permissão existente `oportunidades.gerencie`, organização ativa). Fluxo: trava a linha da oferta (FOR UPDATE, mesma ordem das demais:
 * oferta primeiro, auditoria por último) → confere organização, estado editável e VERSÃO (controle otimista) → valida a forma da categoria → grava categoria + versão+1 → histórico do recurso
 * (`opportunity_changes`, de/para) → auditoria SEM valores (minimização) com identificador de correlação. NÃO publica evento, NÃO reavalia e NÃO executa nada: editar não é autorizar. A reavaliação do Risk Engine
 * continua sendo um pedido explícito e separado (agent-event-reevaluate_POST), que lê esta versão persistida e a confere de novo na conclusão.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));
    const membership = await requirePermission(user.id, input.organizationId, "oportunidades.gerencie");
    const parsed = parseCategory(input.category);
    if (!parsed.ok) return json(400, { message: parsed.message, code: "categoria_invalida" } satisfies ConflictBody);
    const correlationId = randomUUID();

    const result = await db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom("donationOpportunities").select(["id", "status", "category", "version", "updatedAt", "correlationId"]).where("id", "=", input.opportunityId).where("organizationId", "=", input.organizationId).forUpdate().executeTakeFirst();
      if (!row) return { kind: "not_found" as const };
      const current = { version: row.version, category: row.category, status: row.status };
      if (!isCategoryEditable(row.status)) return { kind: "state" as const, current };
      if (row.version !== input.expectedVersion) return { kind: "version" as const, current };
      if ((row.category ?? "") === parsed.value) return { kind: "same" as const, row };

      const [updated] = await trx.updateTable("donationOpportunities").set({ category: parsed.value, updatedAt: new Date(), version: sql`version + 1` }).where("id", "=", row.id).where("version", "=", input.expectedVersion).returning(["id", "category", "version", "updatedAt"]).execute();
      if (!updated) return { kind: "version" as const, current };
      await trx.insertInto("opportunityChanges").values({ opportunityId: row.id, organizationId: input.organizationId, field: "category", previousValue: row.category, newValue: parsed.value, versionBefore: row.version, versionAfter: updated.version, changedByUserId: user.id, correlationId, reason: input.reason || null }).execute();
      await recordAuditLogEntry({ organizationId: input.organizationId, actorUserId: user.id, action: "oportunidade.categoria_alterada", outcome: "concluida", correlationId: row.correlationId, entityType: "donation_opportunity", entityId: String(row.id), metadata: { campo: "category", versaoAnterior: row.version, versaoNova: updated.version, antesPreenchida: row.category !== null, correlacao: correlationId, motivoInformado: Boolean(input.reason), estado: row.status } }, trx);
      return { kind: "changed" as const, updated };
    });

    if (result.kind === "not_found") return json(404, { message: "Oportunidade não encontrada nesta organização" });
    if (result.kind === "state") return json(409, { message: "Esta oportunidade está em um estado final (recebida ou cancelada) e a categoria não pode mais ser alterada.", code: "estado_nao_permite", current: result.current } satisfies ConflictBody);
    if (result.kind === "version") return json(409, { message: "A oportunidade foi alterada por outra pessoa depois que você a abriu. Recarregue para ver a versão atual antes de salvar.", code: "conflito_de_versao", current: result.current } satisfies ConflictBody);

    const view = result.kind === "same" ? { id: result.row.id, category: result.row.category, version: result.row.version, updatedAt: result.row.updatedAt } : result.updated;
    // Só informa (não dispara): há execução do Risk Engine em dados insuficientes que agora PODE ser reavaliada? (apenas para quem lê a automação)
    let reevaluation: OutputType["reevaluation"] = null;
    if (roleHasPermission(membership.role, "automacao.leia")) {
      const run = await db.selectFrom("agentEventRuns as r").innerJoin("domainEvents as e", "e.id", "r.eventId").select("r.id").where("r.organizationId", "=", input.organizationId).where("r.status", "=", "dados_insuficientes").where("e.eventType", "=", "opportunity.created").where("e.entityId", "=", String(input.opportunityId)).orderBy("r.id", "desc").executeTakeFirst();
      reevaluation = run ? { available: (await evaluateEligibility(db, input.organizationId, String(run.id)))?.state === "elegivel", runId: String(run.id) } : { available: false, runId: null };
    }
    const out: OutputType = { opportunity: { id: view.id, category: view.category, version: view.version, updatedAt: view.updatedAt.toISOString() }, changed: result.kind === "changed", correlationId: result.kind === "changed" ? correlationId : null, reevaluation };
    return json(200, out);
  } catch (error: unknown) {
    console.error("Erro ao corrigir a categoria da oportunidade:", error);
    return buildErrorResponse(error, "Não foi possível salvar a categoria");
  }
}
