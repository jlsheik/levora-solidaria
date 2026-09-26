import { db } from "./db";
import { recordAuditLogEntry } from "./auditLog";
import { flootAi, FlootAiOutOfCreditsError } from "./aiClient";
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { DB, Json, NeedPriority } from "./schema";

/**
 * Motor de correspondência — determinístico + IA como apoio, nunca como
 * decisão. Ver docs/plano-implementacao.md, fase 5 e fase 22 (esta última
 * liga capacidade/logística/área de atendimento a dado real, quando a
 * organização configurou — ver organization_capacities/
 * organization_matching_settings/organization_service_areas). Proximidade
 * continua sendo aproximação por cidade/estado da SEDE; raio_atendimento é
 * um critério separado, sobre áreas declaradas ADEMAIS da sede.
 * horarios_restricoes continua "não aplicável" — texto livre não vira
 * pontuação sem uma estrutura própria, que ainda não existe.
 *
 * Peso por critério só conta para o score final quando o dado existe para
 * aquele candidato específico (`finalScore` é a média ponderada só dos
 * critérios aplicáveis, não uma soma fixa sobre 1.00) — isto é
 * deliberado: sem isso, uma organização que ainda não configurou
 * capacidade/logística/área de atendimento (hoje, 100% delas) nunca mais
 * atingiria os limiares de confiança média/alta, travando o matching
 * automático até todo mundo preencher a configuração nova.
 */

export const ALGORITHM_VERSION = "1.1";
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
  return text.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
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

    // Uma única busca em lote por tipo de dado, para todas as organizações
    // candidatas de uma vez — nunca uma query por candidato dentro do loop
    // de pontuação (risco de N+1 real com muitas organizações/oportunidades).
    const candidateOrgIds = [...new Set(candidates.filter((c) => !existingOrgIds.has(c.organizationId)).map((c) => c.organizationId))];

    const [capacityRows, settingsRows, serviceAreaRows, stockUsageRows] = candidateOrgIds.length === 0
      ? [[], [], [], []]
      : await Promise.all([
          trx
            .selectFrom("organizationCapacities")
            .select(["organizationId", "category", "unit", "maxCapacity"])
            .where("organizationId", "in", candidateOrgIds)
            .execute(),
          trx
            .selectFrom("organizationMatchingSettings")
            .select(["organizationId", "realizaColeta"])
            .where("organizationId", "in", candidateOrgIds)
            .execute(),
          trx
            .selectFrom("organizationServiceAreas")
            .select(["organizationId", "city", "state"])
            .where("organizationId", "in", candidateOrgIds)
            .execute(),
          // Uso atual de estoque por (organização, categoria, UNIDADE) —
          // mesma fonte de verdade de sempre (stock_transactions), nunca um
          // contador paralelo. Agrupado por unidade também: somar "5 kg" +
          // "100 unidade" sob a mesma categoria produziria um número sem
          // sentido (achado de auditoria, corrigido aqui).
          trx
            .selectFrom("inventoryItems")
            .leftJoin("stockTransactions", "stockTransactions.itemId", "inventoryItems.id")
            .select([
              "inventoryItems.organizationId",
              "inventoryItems.category",
              "inventoryItems.unit",
              (eb) => eb.fn.coalesce(eb.fn.sum("stockTransactions.delta"), sql<string>`0`).as("total"),
            ])
            .where("inventoryItems.organizationId", "in", candidateOrgIds)
            .where("inventoryItems.category", "is not", null)
            .groupBy(["inventoryItems.organizationId", "inventoryItems.category", "inventoryItems.unit"])
            .execute(),
        ]);

    const capacitiesByOrg = new Map<number, Array<{ category: string; unit: string; maxCapacity: number }>>();
    for (const row of capacityRows) {
      const list = capacitiesByOrg.get(row.organizationId) ?? [];
      list.push({ category: row.category, unit: row.unit, maxCapacity: Number(row.maxCapacity) });
      capacitiesByOrg.set(row.organizationId, list);
    }

    const realizaColetaByOrg = new Map<number, boolean>();
    for (const row of settingsRows) realizaColetaByOrg.set(row.organizationId, row.realizaColeta);

    const serviceAreasByOrg = new Map<number, Array<{ city: string; state: string }>>();
    for (const row of serviceAreaRows) {
      const list = serviceAreasByOrg.get(row.organizationId) ?? [];
      list.push({ city: row.city, state: row.state });
      serviceAreasByOrg.set(row.organizationId, list);
    }

    // Chave inclui a unidade de propósito — ver comentário na query acima.
    // "Alimentos/kg" e "Alimentos/unidade" da mesma organização nunca se
    // misturam num único saldo.
    const stockUsageByOrgCategoryUnit = new Map<string, number>();
    for (const row of stockUsageRows) {
      if (!row.category) continue;
      stockUsageByOrgCategoryUnit.set(`${row.organizationId}::${normalize(row.category)}::${normalize(row.unit)}`, Number(row.total));
    }

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

      // Cidade E estado juntos — mesma correção já aplicada em
      // raio_atendimento (achado de auditoria): cidades homônimas em UFs
      // diferentes (existem de verdade no Brasil, ex. "Bom Jesus/MG" vs
      // "Bom Jesus/PI") nunca contam como a mesma sede.
      const sameCity = Boolean(
        opportunity.locationCity &&
        opportunity.locationState &&
        normalize(opportunity.locationCity) === normalize(c.orgCity) &&
        normalize(opportunity.locationState) === normalize(c.orgState)
      );
      const sameState = Boolean(opportunity.locationState && normalize(opportunity.locationState) === normalize(c.orgState));
      const localizacaoScore = !opportunity.locationCity && !opportunity.locationState
        ? 50
        : sameCity ? 100 : sameState ? 60 : 20;

      // Capacidade de armazenamento: só aplicável se a organização declarou
      // um teto para a MESMA categoria E MESMA UNIDADE da oportunidade
      // (comparação fuzzy de texto, igual ao resto do sistema — não existe
      // taxonomia normalizada de categoria/unidade). Categoria batendo mas
      // unidade diferente NUNCA compara os números (achado de auditoria:
      // "500 kg" não pode ser tratado como comparável a "300 unidade") —
      // sem conversão automática entre unidades, que não existe no
      // projeto. "Disponível" é sempre calculado contra o uso real de
      // estoque já existente NA MESMA categoria+unidade, nunca um número
      // guardado à parte.
      const orgCapacities = capacitiesByOrg.get(c.organizationId) ?? [];
      const matchingCapacity = opportunity.category && opportunity.unit
        ? orgCapacities.find(
            (cap) => normalize(cap.category) === normalize(opportunity.category!) && normalize(cap.unit) === normalize(opportunity.unit!)
          )
        : undefined;
      const capacidadeArmazenamento: CriterionResult =
        !matchingCapacity || opportunity.quantity === null
          ? { score: null, weight: 0.15, detail: "nao_aplicavel: sem capacidade declarada para esta categoria+unidade, ou oportunidade sem quantidade/unidade" }
          : (() => {
              const used = stockUsageByOrgCategoryUnit.get(`${c.organizationId}::${normalize(matchingCapacity.category)}::${normalize(matchingCapacity.unit)}`) ?? 0;
              const available = matchingCapacity.maxCapacity - used;
              const rawScore = available <= 0 ? 0 : Math.min(100, (available / Number(opportunity.quantity)) * 100);
              return {
                score: Math.round(rawScore * 100) / 100,
                weight: 0.15,
                detail: `capacidade declarada ${matchingCapacity.maxCapacity}${matchingCapacity.unit}, uso atual ${used}${matchingCapacity.unit}, disponivel ${available}${matchingCapacity.unit}`,
              };
            })();

      // Capacidade logística: MVP deliberadamente simples — só "realiza
      // coleta ou não" (ver docs/plano-implementacao.md, fase 21). Sem
      // configuração registrada, o critério fica não aplicável (nunca
      // penaliza quem simplesmente ainda não configurou).
      const realizaColeta = realizaColetaByOrg.get(c.organizationId);
      const capacidadeLogistica: CriterionResult =
        realizaColeta === undefined
          ? { score: null, weight: 0.05, detail: "nao_aplicavel: configuracao de logistica nao definida" }
          : { score: realizaColeta ? 100 : 0, weight: 0.05, detail: realizaColeta ? "organizacao realiza coleta" : "organizacao nao realiza coleta" };

      // Raio de atendimento: áreas declaradas ADEMAIS da sede (distinto de
      // `proximidade` acima, que só olha a sede). Sem nenhuma área
      // declarada, fica não aplicável — lista vazia não significa "não
      // atende em lugar nenhum", significa "não configurou ainda".
      const orgServiceAreas = serviceAreasByOrg.get(c.organizationId) ?? [];
      const raioAtendimento: CriterionResult =
        !opportunity.locationCity && !opportunity.locationState
          ? { score: null, weight: 0.15, detail: "nao_aplicavel: oportunidade sem localizacao" }
          : orgServiceAreas.length === 0
            ? { score: null, weight: 0.15, detail: "nao_aplicavel: organizacao nao declarou areas de atendimento" }
            : (() => {
                // Cidade E estado juntos — cidades homônimas em UFs
                // diferentes (existem de verdade no Brasil, ex. "Bom
                // Jesus/MG" vs "Bom Jesus/BA") nunca contam como a mesma
                // localidade (achado de auditoria).
                const cityMatch = Boolean(
                  opportunity.locationCity &&
                  opportunity.locationState &&
                  orgServiceAreas.some(
                    (a) => normalize(a.city) === normalize(opportunity.locationCity!) && normalize(a.state) === normalize(opportunity.locationState!)
                  )
                );
                const stateMatch = Boolean(
                  opportunity.locationState && orgServiceAreas.some((a) => normalize(a.state) === normalize(opportunity.locationState!))
                );
                return {
                  score: cityMatch ? 100 : stateMatch ? 60 : 20,
                  weight: 0.15,
                  detail: "baseado em areas de atendimento declaradas (cidade+UF), nao e distancia em km",
                };
              })();

      // Nota para quem for LER esta coluna de volta via Kysely (ex.:
      // match-evaluations_GET, ou um teste): o FlootCamelCasePlugin
      // (src/helpers/db.tsx) transforma recursivamente as chaves de
      // qualquer objeto simples numa linha, inclusive as de dentro deste
      // JSONB — "capacidade_armazenamento" grava assim, mas volta como
      // "capacidadeArmazenamento" depois de um SELECT. Não é um bug, é um
      // efeito colateral do plugin sobre CADA objeto na linha, não só
      // nomes de coluna.
      const criteria: Record<string, CriterionResult> = {
        categoria: { score: categoriaScore, weight: 0.20, detail: categoriaDetail },
        necessidade_urgencia: { score: URGENCY_SCORE[c.priority], weight: 0.15, detail: `prioridade da necessidade: ${c.priority}` },
        quantidade: { score: Math.round(quantidadeScore * 100) / 100, weight: 0.15, detail: opportunity.quantity !== null ? `oferecido ${opportunity.quantity}${opportunity.unit ?? ""} vs necessário ${needQty}` : "quantidade da oportunidade não informada" },
        proximidade: { score: localizacaoScore, weight: 0.15, detail: "aproximacao por cidade/estado da sede, nao e distancia em km" },
        capacidade_armazenamento: capacidadeArmazenamento,
        capacidade_logistica: capacidadeLogistica,
        raio_atendimento: raioAtendimento,
        horarios_restricoes: { score: null, weight: 0, detail: "nao_aplicavel: dado nao coletado ainda" },
      };

      // Média ponderada só dos critérios APLICÁVEIS a este candidato (score
      // não nulo) — não uma soma fixa assumindo que os pesos sempre somam
      // 1.00. Ver comentário no topo do arquivo: sem isto, organizações que
      // ainda não configuraram capacidade/logística/área de atendimento
      // (hoje, todas) nunca mais atingiriam os limiares de confiança.
      const applicableWeight = Object.values(criteria).reduce((sum, c2) => sum + (c2.score !== null ? c2.weight : 0), 0);
      const rawWeightedSum = Object.values(criteria).reduce((sum, c2) => sum + (c2.score ?? 0) * c2.weight, 0);
      const finalScore = applicableWeight > 0 ? Math.round((rawWeightedSum / applicableWeight) * 100) / 100 : 0;

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

    // Desempate determinístico: a query de candidatos não tem ORDER BY, e o
    // Postgres não garante nenhuma ordem de linhas sem um. Sem uma regra
    // explícita, dois candidatos com finalScore idêntico seriam processados
    // numa ordem incidental do banco — não reproduzível, não auditável.
    // organizationId é o identificador técnico estável escolhido (é a
    // própria FK persistida em match_evaluations/opportunity_allocations,
    // não um critério de prioridade subjetiva); needId desempata o caso
    // teórico de duas necessidades da MESMA organização empatando entre si.
    // Aplicado só depois do finalScore já calculado — nunca influencia o
    // score em si.
    evaluated.sort((a, b) => {
      if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
      if (a.organizationId !== b.organizationId) return a.organizationId - b.organizationId;
      return a.needId - b.needId;
    });

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
