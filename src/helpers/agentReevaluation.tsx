import { sql, type Kysely, type Transaction } from "kysely";
import type { DB, Json } from "./schema.js";
import { getAutomationState } from "./automationControls.js";
import { getEffectivePolicyLimits } from "./policyLimits.js";
import { assessEvent, type ContractedEventType } from "./agentAssessment.js";

/**
 * Reavaliação CONTROLADA de execuções `dados_insuficientes` (M36).
 *
 * O que NUNCA muda: o evento (imutável por gatilho), a execução original e a decisão anterior (cópia em `agent_event_reevaluations.previous_explanation` + `detail.previous`). Uma nova análise é um
 * REGISTRO SEPARADO, vinculado à execução por `run_id` e por um `correlation_id` que também vai para a auditoria.
 *
 * Os dados novos NÃO vêm do navegador nem de quem pede: são lidos, no servidor, de REGISTROS persistidos do domínio, com a origem registrada (tabela, id, campo, instante do registro):
 *   - `opportunity.created` sem categoria  → categoria atual da própria oferta (`donation_opportunities`), se hoje existir;
 *   - `stock_transaction.created` v1 (ajuste) → se o item já tinha saída ANTES do lançamento, recalculado do ledger imutável (`stock_transactions` com id menor);
 *   - `allocation.received` v1 → quantidade atribuída e comparabilidade de unidade, lidas da atribuição/oferta/item.
 * Nenhuma regra de ativação é contornada: a execução só existe para eventos POSTERIORES à ativação do agente; aqui isso é conferido DE NOVO (evento ≥ criação do principal).
 */

export interface SupplementSource { field: string; label: string; table: string; recordId: string; recordedAt: string | null; value: string | number | boolean | null; /** M37: versão do registro de onde o dado foi lido (conferida de novo, sob trava, na conclusão). */ recordVersion?: number }
export interface Supplement { fields: Record<string, string | number | boolean>; sources: SupplementSource[]; /** M37: oportunidade e versão lidas — a conclusão só vale se a versão ainda for esta. */ opportunity?: { id: number; version: number } }

type Exec = Kysely<DB> | Transaction<DB>;
const normUnit = (u: string | null | undefined) => (u ?? "").trim().toLowerCase();
const idOf = (v: string | null): number | null => (v !== null && /^[0-9]{1,15}$/.test(v) ? Number(v) : null);

export async function computeSupplement(executor: Exec, run: { eventType: string; organizationId: number; entityId: string | null; payload: unknown }): Promise<Supplement> {
  const out: Supplement = { fields: {}, sources: [] };
  const p = (run.payload ?? {}) as Record<string, unknown>;
  const entityId = idOf(run.entityId);
  if (entityId === null) return out;

  if (run.eventType === "opportunity.created") {
    const has = typeof p.category === "string" && p.category.trim() !== "";
    if (!has) {
      const row = await executor.selectFrom("donationOpportunities").select(["id", "category", "updatedAt", "version"]).where("id", "=", entityId).where("organizationId", "=", run.organizationId).executeTakeFirst();
      const category = row?.category?.trim();
      if (row && category) { out.fields.category = category; out.opportunity = { id: row.id, version: row.version }; out.sources.push({ field: "category", label: "Categoria da oferta", table: "donation_opportunities", recordId: String(row.id), recordedAt: row.updatedAt.toISOString(), value: category, recordVersion: row.version }); }
    }
  }

  if (run.eventType === "stock_transaction.created" && p.itemHasPriorDistribution === undefined && typeof p.itemId === "number") {
    const tx = await executor.selectFrom("stockTransactions").select(["id", "createdAt"]).where("id", "=", String(entityId)).where("organizationId", "=", run.organizationId).where("itemId", "=", p.itemId).executeTakeFirst();
    if (tx) {
      const prior = await sql<{ n: string }>`SELECT count(*)::text AS n FROM stock_transactions WHERE item_id = ${p.itemId} AND organization_id = ${run.organizationId} AND type = 'saida' AND id < ${String(tx.id)}`.execute(executor);
      const dist = Number(prior.rows[0]?.n ?? 0) > 0;
      out.fields.itemHasPriorDistribution = dist;
      out.sources.push({ field: "itemHasPriorDistribution", label: "Item já teve saída antes do lançamento", table: "stock_transactions", recordId: String(tx.id), recordedAt: tx.createdAt.toISOString(), value: dist });
    }
  }

  if (run.eventType === "allocation.received" && (p.quantityAllocated === undefined || p.quantityAllocated === null) && typeof p.itemId === "number") {
    const alloc = await executor.selectFrom("opportunityAllocations").select(["id", "quantityAllocated", "opportunityRegistryId", "updatedAt"]).where("id", "=", entityId).where("organizationId", "=", run.organizationId).executeTakeFirst();
    if (alloc) {
      const quantity = Number(alloc.quantityAllocated);
      out.fields.quantityAllocated = quantity;
      out.sources.push({ field: "quantityAllocated", label: "Quantidade atribuída", table: "opportunity_allocations", recordId: String(alloc.id), recordedAt: alloc.updatedAt.toISOString(), value: quantity });
      const registry = await executor.selectFrom("opportunityRegistry").select("unit").where("id", "=", alloc.opportunityRegistryId).executeTakeFirst();
      const item = await executor.selectFrom("inventoryItems").select("unit").where("id", "=", p.itemId).where("organizationId", "=", run.organizationId).executeTakeFirst();
      if (item) {
        const same = normUnit(registry?.unit) !== "" && normUnit(registry?.unit) === normUnit(item.unit);
        out.fields.sameUnit = same;
        out.sources.push({ field: "sameUnit", label: "Mesma unidade (oferta × item)", table: "opportunity_registry", recordId: String(alloc.opportunityRegistryId), recordedAt: null, value: same });
      }
    }
  }
  return out;
}

export type EligibilityState = "elegivel" | "ainda_insuficiente" | "indisponivel" | "nao_aplicavel";
export type BlockCode = "estado_invalido" | "agente_desligado" | "automacao_pausada" | "anterior_a_ativacao";
export interface Eligibility { state: EligibilityState; blockCode: BlockCode | null; message: string; availableData: SupplementSource[]; stillMissing: string[]; supplement: Supplement }

const BLOCK_TEXT: Record<BlockCode, string> = {
  estado_invalido: "Só execuções em “dados insuficientes” podem ser reavaliadas.",
  agente_desligado: "O agente está desligado: ligue-o antes de pedir uma nova análise.",
  automacao_pausada: "A automação está pausada: a nova análise respeita a pausa e só pode ser pedida depois de retomada.",
  anterior_a_ativacao: "O evento é anterior à ativação do agente e não pode ser processado retroativamente.",
};

/** Elegibilidade de UMA execução (somente leitura). `executor` deve ser a transação quando usada para decidir (sob a cerca). */
export async function evaluateEligibility(executor: Exec, organizationId: number, runId: string): Promise<(Eligibility & { run: { id: string; status: string; detail: Json; eventType: string; entityId: string | null; payload: unknown; agentPrincipalId: number } }) | null> {
  const run = await executor
    .selectFrom("agentEventRuns as r")
    .innerJoin("domainEvents as e", "e.id", "r.eventId")
    .innerJoin("agentPrincipals as p", "p.id", "r.agentPrincipalId")
    .select(["r.id", "r.status", "r.detail", "r.eventType", "r.agentPrincipalId", "e.entityId", "e.payload", "e.createdAt as eventCreatedAt", "p.enabled", "p.createdAt as principalCreatedAt"])
    .where("r.id", "=", runId)
    .where("r.organizationId", "=", organizationId)
    .executeTakeFirst();
  if (!run) return null;
  const base = { run: { id: String(run.id), status: run.status, detail: run.detail, eventType: run.eventType, entityId: run.entityId, payload: run.payload, agentPrincipalId: run.agentPrincipalId } };
  const empty: Supplement = { fields: {}, sources: [] };
  const blocked = (code: BlockCode, state: EligibilityState = "indisponivel") => ({ ...base, state, blockCode: code, message: BLOCK_TEXT[code], availableData: [], stillMissing: [], supplement: empty });
  if (run.status !== "dados_insuficientes") return blocked("estado_invalido", "nao_aplicavel");
  if (run.eventCreatedAt < run.principalCreatedAt) return blocked("anterior_a_ativacao");
  if (!run.enabled) return blocked("agente_desligado");
  const state = await getAutomationState(executor as Kysely<DB>, organizationId);
  if (state.paused || state.emergency) return blocked("automacao_pausada");

  const supplement = await computeSupplement(executor, { eventType: run.eventType, organizationId, entityId: run.entityId, payload: run.payload });
  const merged = { ...(run.payload as Record<string, unknown>), ...supplement.fields };
  const limits = await getEffectivePolicyLimits(executor as Kysely<DB>, organizationId);
  const a = assessEvent(run.eventType as ContractedEventType, merged, limits);
  if (!a.ok) return blocked("estado_invalido", "nao_aplicavel");
  if (a.assessment.completeness === "insuficiente") {
    return { ...base, state: "ainda_insuficiente", blockCode: null, message: "Os dados obrigatórios continuam ausentes nos registros de origem: uma nova análise ainda seria insuficiente.", availableData: supplement.sources, stillMissing: a.assessment.missingRequired, supplement };
  }
  return { ...base, state: "elegivel", blockCode: null, message: "Há dados novos verificáveis nos registros de origem: é possível solicitar uma nova análise.", availableData: supplement.sources, stillMissing: [], supplement };
}
