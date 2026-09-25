import { db } from "./db";
import { recordAuditLogEntry } from "./auditLog";
import { flootAi, FlootAiOutOfCreditsError } from "./aiClient";
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { DB, Json, NeedPriority } from "./schema";

/**
 * Motor de correspondência — determinístico + IA como apoio, nunca como
 * decisão. Ver docs/plano-implementacao.md, fase 5, para as regras de
 * negócio e as limitações assumidas (proximidade é aproximação por
 * cidade/estado; capacidade/raio/horários ainda não são coletados e
 * entram como "não aplicável", nunca como número inventado).
 */

export const ALGORITHM_VERSION = "1.0";
export const HIGH_CONFIDENCE_THRESHOLD = 90;
export const MEDIUM_CONFIDENCE_THRESHOLD = 70;
export const RESERVATION_MINUTES = 30;

const URGENCY_SCORE: Record<NeedPriority, number> = { baixa: 40, media: 65, alta: 85, critica: 100 };

interface CriterionResult {
  score: number | null;
  weight: number;
  detail: string;
}

interface CandidateEvaluation {
  organizationId: number;
  organizationName: string;
  needId: number;
  needTitle: string;
  needQuantity: number;
  criteria: Record<string, CriterionResult>;
  finalScore: number;
  aiModelUsed: string | null;
}

// Exportadas para teste unit\u00e1rio (test/opportunityMatching.test.ts) \u2014 a
// l\u00f3gica de pontua\u00e7\u00e3o por palavra-chave \u00e9 pura e n\u00e3o deveria exigir banco
// de dados para ser validada.
export function normalize(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function keywordScore(a: string, b: string): number {
  const wordsA = normalize(a).split(/\s+/).filter((w) => w.length > 3);
  const wordsB = normalize(b).split(/\s+/).filter((w) => w.length > 3);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;
  const hit = wordsA.some((w) => wordsB.some((w2) => w2.includes(w) || w.includes(w2)));
  return hit ? 100 : 0;
}

async function aiCategoryScores(
  opportunityText: string,
  candidates: { needId: number; text: string }[]
): Promise<{ scores: Map<number, { score: number; reason: string }>; modelUsed: string | null }> {
  if (candidates.length === 0) return { scores: new Map(), modelUsed: null };
  try {
    const r = await flootAi.chat({
      model: "gpt-5.6-luna",
      input: [
        "Você avalia equivalência semântica entre uma oportunidade de doação e necessidades cadastradas por organizações.",
        `Oportunidade: "${opportunityText}"`,
        "Necessidades candidatas (responda APENAS com JSON, um array de objetos {needId, score, reason}, score de 0 a 100 indicando o quanto a necessidade é equivalente/compatível com a oportunidade, mesmo com palavras diferentes; se não houver relação nenhuma, score 0):",
        JSON.stringify(candidates),
      ].join("\n"),
    } as never);
    const text: string = (r as never as { output_text?: string }).output_text
      ?? (r as never as { output?: Array<{ content?: Array<{ text?: string }> }> }).output
        ?.flatMap((o) => o.content ?? [])
        .find((c) => c.text)?.text
      ?? "";
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned) as Array<{ needId: number; score: number; reason: string }>;
    const scores = new Map<number, { score: number; reason: string }>();
    for (const p of parsed) scores.set(p.needId, { score: Math.max(0, Math.min(100, p.score)), reason: p.reason });
    return { scores, modelUsed: "gpt-5.6-luna" };
  } catch (err) {
    // IA nunca bloqueia o matching — se falhar (crédito, rede, formato),
    // o motor segue só com o escore por palavra-chave.
    console.error("Falha ao consultar IA para matching (seguindo sem IA):", err);
    return { scores: new Map(), modelUsed: null };
  }
}

export interface MatchRunResult {
  skipped: boolean;
  reason?: string;
  allocationsCreated: Array<{ organizationId: number; quantity: number; status: string; score: number }>;
  discarded: Array<{ organizationId: number; needId: number; score: number }>;
}

export async function runMatchingForOpportunity(
  opportunityRegistryId: number,
  triggeredByUserId: number | null
): Promise<MatchRunResult> {
  return db.transaction().execute(async (trx) => {
    const opportunity = await trx
      .selectFrom("opportunityRegistry")
      .select(["id", "status", "title", "description", "category", "quantity", "unit", "locationCity", "locationState"])
      .where("id", "=", opportunityRegistryId)
      .forUpdate()
      .executeTakeFirst();

    if (!opportunity) return { skipped: true, reason: "nao_encontrada", allocationsCreated: [], discarded: [] };
    if (!["aguardando_destinacao", "reservada"].includes(opportunity.status)) {
      return { skipped: true, reason: `status_nao_elegivel:${opportunity.status}`, allocationsCreated: [], discarded: [] };
    }

    const allocatedRow = await trx
      .selectFrom("opportunityAllocations")
      .select((eb) => eb.fn.coalesce(eb.fn.sum("quantityAllocated"), sql<string>`0`).as("total"))
      .where("opportunityRegistryId", "=", opportunityRegistryId)
      .where("status", "!=", "recusada")
      .where("status", "!=", "cancelada")
      .executeTakeFirst();
    const alreadyAllocated = Number(allocatedRow?.total ?? 0);
    let remaining = opportunity.quantity !== null ? Number(opportunity.quantity) - alreadyAllocated : null;
    if (remaining !== null && remaining <= 0) {
      return { skipped: true, reason: "quantidade_totalmente_atribuida", allocationsCreated: [], discarded: [] };
    }

    // Já atribuído a estas organizações? Não avaliar de novo o mesmo par.
    const existingOrgIds = new Set(
      (
        await trx
          .selectFrom("opportunityAllocations")
          .select("organizationId")
          .where("opportunityRegistryId", "=", opportunityRegistryId)
          .where("status", "!=", "recusada")
          .where("status", "!=", "cancelada")
          .execute()
      ).map((r) => r.organizationId)
    );

    const candidates = await trx
      .selectFrom("needs")
      .innerJoin("organizations", "organizations.id", "needs.organizationId")
      .select([
        "needs.id as needId",
        "needs.title as needTitle",
        "needs.quantityNeeded",
        "needs.priority",
        "organizations.id as organizationId",
        "organizations.name as organizationName",
        "organizations.city as orgCity",
        "organizations.state as orgState",
      ])
      .where("needs.status", "=", "aberta")
      .where("organizations.status", "=", "ativa")
      .execute();

    const opportunityText = [opportunity.title, opportunity.category, opportunity.description].filter(Boolean).join(" — ");

    const evaluated: CandidateEvaluation[] = [];
    const weakKeyword: { needId: number; text: string }[] = [];
    const byNeedId = new Map<number, (typeof candidates)[number]>();

    for (const c of candidates) {
      if (existingOrgIds.has(c.organizationId)) continue;
      byNeedId.set(c.needId, c);
      const kwScore = keywordScore(opportunityText, c.needTitle);
      if (kwScore === 0) weakKeyword.push({ needId: c.needId, text: c.needTitle });
    }

    const aiBatch = weakKeyword.slice(0, 20);
    const hasStrongKeywordMatch = candidates.some((c) => !existingOrgIds.has(c.organizationId) && keywordScore(opportunityText, c.needTitle) > 0);
    const { scores: aiScores, modelUsed } = !hasStrongKeywordMatch && aiBatch.length > 0
      ? await aiCategoryScores(opportunityText, aiBatch)
      : { scores: new Map<number, { score: number; reason: string }>(), modelUsed: null };

    for (const c of candidates) {
      if (existingOrgIds.has(c.organizationId)) continue;
      const kwScore = keywordScore(opportunityText, c.needTitle);
      const ai = aiScores.get(c.needId);
      const categoriaScore = kwScore > 0 ? kwScore : ai?.score ?? 0;
      const categoriaDetail = kwScore > 0
        ? "correspondência por palavra-chave"
        : ai
          ? `avaliado por IA: ${ai.reason}`
          : "sem correspondência por palavra-chave nem IA";

      if (categoriaScore === 0) continue; // sem relação nenhuma, nem candidato

      const needQty = Number(c.quantityNeeded);
      const quantidadeScore = opportunity.quantity !== null
        ? Math.max(0, Math.min(100, (Math.min(Number(opportunity.quantity), needQty) / needQty) * 100))
        : 70;

      const sameCity = opportunity.locationCity && normalize(opportunity.locationCity) === normalize(c.orgCity);
      const sameState = opportunity.locationState && normalize(opportunity.locationState) === normalize(c.orgState);
      const localizacaoScore = !opportunity.locationCity && !opportunity.locationState
        ? 50
        : sameCity ? 100 : sameState ? 60 : 20;

      const criteria: Record<string, CriterionResult> = {
        categoria: { score: categoriaScore, weight: 0.30, detail: categoriaDetail },
        necessidade_urgencia: { score: URGENCY_SCORE[c.priority], weight: 0.20, detail: `prioridade da necessidade: ${c.priority}` },
        quantidade: { score: Math.round(quantidadeScore * 100) / 100, weight: 0.20, detail: opportunity.quantity !== null ? `oferecido ${opportunity.quantity}${opportunity.unit ?? ""} vs necessário ${needQty}` : "quantidade da oportunidade não informada" },
        proximidade: { score: localizacaoScore, weight: 0.30, detail: "aproximacao por cidade/estado, nao e distancia em km" },
        capacidade_armazenamento: { score: null, weight: 0, detail: "nao_aplicavel: dado nao coletado ainda" },
        capacidade_logistica: { score: null, weight: 0, detail: "nao_aplicavel: dado nao coletado ainda" },
        raio_atendimento: { score: null, weight: 0, detail: "nao_aplicavel: dado nao coletado ainda" },
        horarios_restricoes: { score: null, weight: 0, detail: "nao_aplicavel: dado nao coletado ainda" },
      };

      const finalScore = Math.round(
        Object.values(criteria).reduce((sum, c2) => sum + (c2.score ?? 0) * c2.weight, 0) * 100
      ) / 100;

      evaluated.push({
        organizationId: c.organizationId,
        organizationName: c.organizationName,
        needId: c.needId,
        needTitle: c.needTitle,
        needQuantity: needQty,
        criteria,
        finalScore,
        aiModelUsed: kwScore === 0 && ai ? modelUsed : null,
      });
    }

    evaluated.sort((a, b) => b.finalScore - a.finalScore);

    const allocationsCreated: MatchRunResult["allocationsCreated"] = [];
    const discarded: MatchRunResult["discarded"] = [];
    let unboundedProcessed = 0;
    let opportunityBecameReserved = false;
    let opportunityBecameAssigned = false;

    for (const cand of evaluated) {
      if (remaining !== null && remaining <= 0) break;
      if (remaining === null && unboundedProcessed >= 3) break;
      if (cand.finalScore < MEDIUM_CONFIDENCE_THRESHOLD) {
        discarded.push({ organizationId: cand.organizationId, needId: cand.needId, score: cand.finalScore });
        await trx
          .insertInto("matchEvaluations")
          .values({
            opportunityRegistryId,
            organizationId: cand.organizationId,
            needId: cand.needId,
            criteria: cand.criteria as unknown as Json,
            finalScore: cand.finalScore,
            algorithmVersion: ALGORITHM_VERSION,
            aiModelUsed: cand.aiModelUsed,
            decision: "descartado",
          })
          .execute();
        continue;
      }

      const quantityToAllocate = remaining !== null ? Math.min(remaining, cand.needQuantity) : cand.needQuantity;
      const isHighConfidence = cand.finalScore >= HIGH_CONFIDENCE_THRESHOLD;
      const allocationStatus = isHighConfidence ? "aceita" : "proposta";

      const [allocation] = await trx
        .insertInto("opportunityAllocations")
        .values({
          opportunityRegistryId,
          organizationId: cand.organizationId,
          quantityAllocated: quantityToAllocate,
          status: allocationStatus,
          autoMatched: true,
          reservedUntil: isHighConfidence ? null : new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000),
          notes: `Match automático (algoritmo ${ALGORITHM_VERSION}): ${cand.finalScore}%`,
          createdByUserId: triggeredByUserId,
        })
        .returning(["id"])
        .execute();

      await trx
        .insertInto("matchEvaluations")
        .values({
          opportunityRegistryId,
          organizationId: cand.organizationId,
          needId: cand.needId,
          criteria: cand.criteria as unknown as Json,
          finalScore: cand.finalScore,
          algorithmVersion: ALGORITHM_VERSION,
          aiModelUsed: cand.aiModelUsed,
          decision: isHighConfidence ? "atribuido_automatico" : "proposto",
          allocationId: allocation.id,
        })
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: cand.organizationId,
          actorUserId: triggeredByUserId,
          action: isHighConfidence ? "atribuicao.automatica_alta_confianca" : "atribuicao.proposta_automatica",
          entityType: "opportunity_allocation",
          entityId: String(allocation.id),
          metadata: { opportunityRegistryId, score: cand.finalScore, needId: cand.needId, quantityAllocated: quantityToAllocate },
        },
        trx
      );

      allocationsCreated.push({ organizationId: cand.organizationId, quantity: quantityToAllocate, status: allocationStatus, score: cand.finalScore });
      if (remaining !== null) remaining -= quantityToAllocate;
      unboundedProcessed += 1;
      if (isHighConfidence) opportunityBecameAssigned = true;
      else opportunityBecameReserved = true;
    }

    if (opportunityBecameAssigned) {
      await trx.updateTable("opportunityRegistry").set({ status: "atribuida", updatedAt: new Date() }).where("id", "=", opportunityRegistryId).execute();
    } else if (opportunityBecameReserved && opportunity.status === "aguardando_destinacao") {
      await trx.updateTable("opportunityRegistry").set({ status: "reservada", updatedAt: new Date() }).where("id", "=", opportunityRegistryId).execute();
    }

    await recordAuditLogEntry(
      {
        organizationId: null,
        actorUserId: triggeredByUserId,
        action: "matching.executado",
        entityType: "opportunity_registry",
        entityId: String(opportunityRegistryId),
        metadata: { candidatosAvaliados: evaluated.length, atribuicoesCriadas: allocationsCreated.length, descartados: discarded.length, algoritmo: ALGORITHM_VERSION },
      },
      trx
    );

    return { skipped: false, allocationsCreated, discarded };
  });
}
