import { z } from "zod";
import type { EffectivePolicyLimits } from "./policyLimits.js";
import { evaluatePolicy, type PolicyContext } from "./policyRules.js";

/**
 * Avaliação EXPLICÁVEL de um evento interno (M35) — função pura, sem banco, sem relógio, sem efeito colateral. Dado o tipo, o payload e os limites efetivos, devolve:
 *   - os FATOS considerados (só ids, números e booleanos — nunca texto livre nem dado pessoal);
 *   - o que estava AUSENTE (obrigatório × opcional);
 *   - o resultado de CADA regra aplicável (ok / violada / não avaliada, com motivo);
 *   - a COMPLETUDE da análise: `completa`, `parcial` (alguma regra não pôde ser avaliada por falta de dado, mas nenhuma regra obrigatória ficou sem dado) ou `insuficiente`.
 *
 * Princípios (docs/AGENTES_PLATAFORMA.md, "Decisão com dados ausentes"):
 *   1. Ausência NUNCA vira zero nem "falso": fato desconhecido é `undefined` e a regra correspondente fica "não avaliada".
 *   2. Análise `insuficiente` NÃO é aprovação: o motor não conclui a simulação; registra `dados_insuficientes`.
 *   3. Nenhum número é inventado aqui: os limites vêm de `policyLimits` (padrão em código ou ajuste humano); as regras sem especificação ficam em `PENDING_RULES`, visíveis, e NÃO decidem nada.
 *   4. Contrato versionado: payload sem `v` é a versão 1 (eventos anteriores à M35) e continua aceito; os campos novos faltam e a análise diz isso.
 */

export type ContractedEventType = "stock_transaction.created" | "allocation.received" | "opportunity.created";
export type RuleResult = "ok" | "violada" | "nao_avaliada" | "nao_se_aplica";
export type Completeness = "completa" | "parcial" | "insuficiente";
export type Fact = string | number | boolean | null;

export interface RuleOutcome {
  code: string;
  title: string;
  result: RuleResult;
  /** Efeito quando violada: revisão de uma pessoa ou dupla autorização. */
  effect?: "require_review" | "dual_approval";
  /** Frase em português; nunca dado pessoal. */
  reason: string;
  /** Limite efetivo aplicado (texto), quando a regra depende de um. */
  limit?: string;
  /** true = o dado desta regra é OPCIONAL (hoje nenhum fluxo o registra): regra não avaliada NÃO rebaixa a completude da análise. */
  optional?: boolean;
}

export interface Assessment {
  contractVersion: 1 | 2;
  facts: Record<string, Fact>;
  missingRequired: string[];
  missingOptional: string[];
  completeness: Completeness;
  rules: RuleOutcome[];
  /** Fatos de política para a ferramenta (`assess_event`), já saneados. */
  policy: PolicyContext;
  /** Limites efetivos relevantes para ESTE evento (instantâneo no momento da avaliação). Chaves em camelCase de propósito: a camada do banco converte nomes de chave de colunas JSON. */
  limits: Record<string, number | string[]>;
}

/** Regras previstas na especificação que NÃO foram implementadas por falta de regra de negócio definida (limiar, janela, valor). Aparecem na tela; nunca decidem. */
export const PENDING_RULES: Record<ContractedEventType, Array<{ code: string; title: string; why: string }>> = {
  "stock_transaction.created": [
    { code: "R-SENTINELA-RAJADA-AJUSTES", title: "Rajada de ajustes", why: "A especificação só dá um exemplo (“40 em 10 min”); limite e janela não foram definidos pelo proprietário." },
    { code: "R-SENTINELA-ENTRADA-SAIDA-ALTO-VALOR", title: "Mesma pessoa em entrada e saída de alto valor", why: "O estoque não registra valor monetário e “alto valor” não foi definido." },
    { code: "R-SENTINELA-MESMA-ENTREGA-VARIOS-DESTINOS", title: "Mesma entrega em vários destinos", why: "Não há definição de “mesma entrega” nem de limite de destinos." },
  ],
  "allocation.received": [
    { code: "R-SENTINELA-TOLERANCIA-RECEBIMENTO", title: "Tolerância de divergência no recebimento", why: "Hoje QUALQUER diferença de quantidade (na mesma unidade) vai para revisão; a tolerância aceitável não foi definida." },
  ],
  "opportunity.created": [
    { code: "R-RISK-VOLUME-SUBITO", title: "Volume súbito de oportunidades", why: "Limite e janela de tempo não foram definidos." },
    { code: "R-RISK-CONTA-NOVA-ALTO-VALOR", title: "Conta nova com alto valor", why: "A oferta não registra valor monetário e “conta nova” e “alto valor” não foram definidos." },
  ],
};

const num = z.union([z.number().finite(), z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)]);
const optNum = num.nullish();
const id = z.number().int().positive();
const SOURCES = ["lancamento_manual", "ajuste_aprovado", "destinacao_saida", "estoque_inicial", "recebimento_oportunidade", "estorno_destinacao", "correcao_destinacao", "estorno_recebimento", "correcao_recebimento"] as const;

export const PAYLOAD_SCHEMAS = {
  "stock_transaction.created": z.object({ v: z.number().int().optional(), itemId: id, type: z.string().min(1).max(40), delta: num, newStock: num, previousStock: optNum, actorUserId: id.nullish(), source: z.enum(SOURCES).optional(), itemHasPriorDistribution: z.boolean().optional(), reversesStockTransactionId: z.string().min(1).max(40).optional(), reversesAllocationId: id.optional(), estimatedValue: optNum, distanceKm: optNum, logisticsCost: optNum }).passthrough(),
  "allocation.received": z.object({ v: z.number().int().optional(), itemId: id, quantityReceived: num, stockTransactionId: z.string().min(1).max(40), opportunityConcluded: z.boolean(), allocationId: id.optional(), quantityAllocated: optNum, sameUnit: z.boolean().optional(), actorUserId: id.nullish(), estimatedValue: optNum, distanceKm: optNum, logisticsCost: optNum }).passthrough(),
  "opportunity.created": z.object({ v: z.number().int().optional(), category: z.string().max(80).nullable(), quantityOffered: optNum, unit: z.string().max(40).nullable(), actorUserId: id.nullish(), linkedNeed: z.boolean().optional(), estimatedValue: optNum, distanceKm: optNum, logisticsCost: optNum }).passthrough(),
} as const;

const known = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
const fmtLimitText = (v: number | string[]) => (Array.isArray(v) ? (v.length ? v.join(", ") : "nenhuma") : String(v));
/** NUMERIC(12,3): compara em milésimos para não tratar 0.1+0.2 como diferença. */
const sameQuantity = (a: number, b: number) => Math.round(a * 1000) === Math.round(b * 1000);

const COMMON_OPTIONAL = ["estimatedValue", "distanceKm", "logisticsCost"] as const;

function valueRules(p: Record<string, unknown>, limits: EffectivePolicyLimits, violationCodes: Set<string>, out: RuleOutcome[], missingOptional: string[]) {
  const spec: Array<[string, string, string, string, string, number]> = [
    ["estimatedValue", "R-VALOR-ALTO-DUPLA", "Valor acima do aceite automático", "valor estimado", "AUTO_ACCEPT_MAX_VALUE", limits.AUTO_ACCEPT_MAX_VALUE],
    ["distanceKm", "R-DISTANCIA-COLETA", "Distância de coleta", "distância", "AUTO_PICKUP_MAX_DISTANCE_KM", limits.AUTO_PICKUP_MAX_DISTANCE_KM],
    ["logisticsCost", "R-CUSTO-LOGISTICO", "Custo logístico", "custo logístico", "AUTO_LOGISTICS_MAX_COST", limits.AUTO_LOGISTICS_MAX_COST],
  ];
  for (const [field, code, title, label, , limit] of spec) {
    if (known(p[field]) === undefined) {
      missingOptional.push(field);
      out.push({ code, title, result: "nao_avaliada", optional: true, reason: `${label[0].toUpperCase()}${label.slice(1)} não disponível: o sistema não registra essa informação neste fluxo, então a regra não foi avaliada (ausência não é tratada como zero).` });
    } else {
      out.push({ code, title, result: violationCodes.has(code) ? "violada" : "ok", effect: code === "R-VALOR-ALTO-DUPLA" ? "dual_approval" : "require_review", reason: violationCodes.has(code) ? `${label[0].toUpperCase()}${label.slice(1)} acima do limite efetivo.` : `${label[0].toUpperCase()}${label.slice(1)} dentro do limite efetivo.`, limit: fmtLimitText(limit) });
    }
  }
}

export function assessEvent(eventType: ContractedEventType, rawPayload: unknown, limits: EffectivePolicyLimits): { ok: true; assessment: Assessment } | { ok: false; code: string; text: string } {
  const schema = PAYLOAD_SCHEMAS[eventType];
  if (!schema) return { ok: false, code: "tipo_nao_suportado", text: "Tipo de evento sem contrato para este agente." };
  const parsed = schema.safeParse(rawPayload);
  if (!parsed.success) return { ok: false, code: "estrutura_invalida", text: "A estrutura do evento não corresponde ao contrato." };
  const p = parsed.data as Record<string, unknown>;
  const contractVersion = (p.v === 2 ? 2 : 1) as 1 | 2;
  const facts: Record<string, Fact> = {};
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];
  const rules: RuleOutcome[] = [];
  const policy: PolicyContext = { estimatedValue: known(p.estimatedValue), distanceKm: known(p.distanceKm), logisticsCost: known(p.logisticsCost) };
  const L: Record<string, number | string[]> = {};

  if (eventType === "stock_transaction.created") {
    const type = String(p.type); const delta = Number(p.delta); const newStock = Number(p.newStock);
    facts.tipo = type; facts.variacao = delta; facts.saldoApos = newStock; facts.origem = (p.source as string | undefined) ?? null; facts.versaoContrato = contractVersion;
    if (p.actorUserId) facts.atorId = Number(p.actorUserId);
    if (p.reversesStockTransactionId) facts.estornaLancamento = String(p.reversesStockTransactionId);
    if (p.reversesAllocationId) facts.estornaAtribuicao = Number(p.reversesAllocationId);
    // estorno/correção SEM referência ao registro original não pode ser avaliado como estorno: dado obrigatório ausente.
    const isReversal = typeof p.source === "string" && (p.source.startsWith("estorno_") || p.source.startsWith("correcao_"));
    if (isReversal && !p.reversesStockTransactionId && !p.reversesAllocationId) missingRequired.push("reversesReference");
    policy.negativeBalance = newStock < 0;
    const violations = new Set(evaluatePolicy({ negativeBalance: policy.negativeBalance, itemAdjustedAfterDistribution: type === "ajuste" ? (p.itemHasPriorDistribution as boolean | undefined) : undefined }, limits).violations.map((v) => v.ruleCode));
    rules.push({ code: "R-SENTINELA-SALDO-NEGATIVO", title: "Saldo negativo", result: violations.has("R-SENTINELA-SALDO-NEGATIVO") ? "violada" : "ok", effect: "require_review", reason: policy.negativeBalance ? "O saldo do item ficou negativo depois do lançamento." : "O saldo do item continua não negativo." });
    if (type === "ajuste") {
      const dist = p.itemHasPriorDistribution as boolean | undefined;
      if (dist === undefined) {
        missingRequired.push("itemHasPriorDistribution");
        rules.push({ code: "R-SENTINELA-AJUSTE-ITEM-DISTRIBUIDO", title: "Ajuste de item já distribuído", result: "nao_avaliada", reason: "O evento (contrato v1) não informa se o item já teve saída/distribuição; sem esse dado a regra não pode ser avaliada e a análise é insuficiente." });
      } else {
        facts.itemJaDistribuido = dist; policy.itemAdjustedAfterDistribution = dist;
        rules.push({ code: "R-SENTINELA-AJUSTE-ITEM-DISTRIBUIDO", title: "Ajuste de item já distribuído", result: violations.has("R-SENTINELA-AJUSTE-ITEM-DISTRIBUIDO") ? "violada" : "ok", effect: "require_review", reason: dist ? "O item já teve saída/distribuição antes deste ajuste." : "O item ainda não teve saída/distribuição." });
      }
    } else {
      rules.push({ code: "R-SENTINELA-AJUSTE-ITEM-DISTRIBUIDO", title: "Ajuste de item já distribuído", result: "nao_se_aplica", reason: "Só se aplica a ajustes de estoque." });
    }
    const vr = evaluatePolicy(policy, limits); valueRules(p, limits, new Set(vr.violations.map((v) => v.ruleCode)), rules, missingOptional);
  }

  if (eventType === "allocation.received") {
    const received = Number(p.quantityReceived); const allocated = known(p.quantityAllocated);
    facts.quantidadeRecebida = received; facts.quantidadeAtribuida = allocated ?? null; facts.versaoContrato = contractVersion;
    if (p.sameUnit !== undefined) facts.mesmaUnidade = p.sameUnit as boolean;
    if (p.actorUserId) facts.atorId = Number(p.actorUserId);
    if (allocated === undefined) {
      missingRequired.push("quantityAllocated");
      rules.push({ code: "R-SENTINELA-DIVERGENCIA-RECEBIMENTO", title: "Divergência de recebimento", result: "nao_avaliada", reason: "A quantidade atribuída não consta no evento (contrato v1); sem ela a divergência não pode ser avaliada e a análise é insuficiente." });
    } else if (p.sameUnit !== true) {
      // unidade diferente (ou não informada): quantidades não comparáveis sem conversão — a regra não se aplica e a análise fica PARCIAL.
      missingOptional.push("mesma_unidade");
      rules.push({ code: "R-SENTINELA-DIVERGENCIA-RECEBIMENTO", title: "Divergência de recebimento", result: "nao_avaliada", reason: "A unidade da oferta difere da do item (equivalência comprovada, sem conversão numérica aqui): as quantidades não são comparáveis, então a regra não foi avaliada." });
    } else {
      const mismatch = !sameQuantity(received, allocated);
      policy.receiptQuantityMismatch = mismatch;
      const v = new Set(evaluatePolicy({ receiptQuantityMismatch: mismatch }, limits).violations.map((x) => x.ruleCode));
      rules.push({ code: "R-SENTINELA-DIVERGENCIA-RECEBIMENTO", title: "Divergência de recebimento", result: v.has("R-SENTINELA-DIVERGENCIA-RECEBIMENTO") ? "violada" : "ok", effect: "require_review", reason: mismatch ? "A quantidade recebida difere da atribuída (tolerância não definida: qualquer diferença vai para revisão)." : "A quantidade recebida é igual à atribuída." });
    }
    const vr = evaluatePolicy(policy, limits); valueRules(p, limits, new Set(vr.violations.map((v) => v.ruleCode)), rules, missingOptional);
  }

  if (eventType === "opportunity.created") {
    const category = typeof p.category === "string" && p.category.trim() ? p.category.trim().toLowerCase() : null;
    facts.categoria = category; facts.quantidadeOferecida = known(p.quantityOffered) ?? null; facts.unidade = (p.unit as string | null) ?? null; facts.versaoContrato = contractVersion;
    if (p.actorUserId) facts.atorId = Number(p.actorUserId);
    L.highRiskCategories = [...limits.HIGH_RISK_CATEGORIES]; L.manualReviewRequiredCategories = [...limits.MANUAL_REVIEW_REQUIRED_CATEGORIES];
    if (category === null) {
      missingRequired.push("category");
      for (const [code, title] of [["R-CATEGORIA-ALTO-RISCO", "Categoria de alto risco"], ["R-CATEGORIA-REVISAO-MANUAL", "Revisão manual obrigatória"]]) {
        rules.push({ code, title, result: "nao_avaliada", reason: "A oferta não informa a categoria: as regras por categoria não podem ser avaliadas e a análise é insuficiente (não é tratada como “sem risco”)." });
      }
    } else {
      policy.category = category;
      const v = new Set(evaluatePolicy({ category }, limits).violations.map((x) => x.ruleCode));
      rules.push({ code: "R-CATEGORIA-ALTO-RISCO", title: "Categoria de alto risco", result: v.has("R-CATEGORIA-ALTO-RISCO") ? "violada" : "ok", effect: "require_review", reason: v.has("R-CATEGORIA-ALTO-RISCO") ? `A categoria “${category}” é de alto risco.` : `A categoria “${category}” não é de alto risco.`, limit: fmtLimitText(limits.HIGH_RISK_CATEGORIES) });
      rules.push({ code: "R-CATEGORIA-REVISAO-MANUAL", title: "Revisão manual obrigatória", result: v.has("R-CATEGORIA-REVISAO-MANUAL") ? "violada" : "ok", effect: "require_review", reason: v.has("R-CATEGORIA-REVISAO-MANUAL") ? `A categoria “${category}” exige revisão manual.` : `A categoria “${category}” não exige revisão manual.`, limit: fmtLimitText(limits.MANUAL_REVIEW_REQUIRED_CATEGORIES) });
    }
    if (known(p.quantityOffered) === undefined) missingOptional.push("quantityOffered");
    const vr = evaluatePolicy(policy, limits); valueRules(p, limits, new Set(vr.violations.map((x) => x.ruleCode)), rules, missingOptional);
  }

  for (const f of COMMON_OPTIONAL) if (known(p[f]) !== undefined) facts[f] = known(p[f])!;
  if (known(p.estimatedValue) !== undefined) L.autoAcceptMaxValue = limits.AUTO_ACCEPT_MAX_VALUE;
  if (known(p.distanceKm) !== undefined) L.autoPickupMaxDistanceKm = limits.AUTO_PICKUP_MAX_DISTANCE_KM;
  if (known(p.logisticsCost) !== undefined) L.autoLogisticsMaxCost = limits.AUTO_LOGISTICS_MAX_COST;

  const completeness: Completeness = missingRequired.length > 0 ? "insuficiente" : rules.some((r) => r.result === "nao_avaliada" && !r.optional) ? "parcial" : "completa";
  return { ok: true, assessment: { contractVersion, facts, missingRequired, missingOptional, completeness, rules, policy, limits: L } };
}

/** Decisão resumida (para lista e filtros) derivada das regras VIOLADAS; a decisão efetiva (exceção, bloqueio, conclusão) continua sendo do motor/ferramenta. */
export function summarizeDecision(a: Assessment): "dados_insuficientes" | "revisao" | "dupla_autorizacao" | "permitido" {
  if (a.completeness === "insuficiente") return "dados_insuficientes";
  const violated = a.rules.filter((r) => r.result === "violada");
  if (violated.some((r) => r.effect === "dual_approval")) return "dupla_autorizacao";
  if (violated.length > 0) return "revisao";
  return "permitido";
}
