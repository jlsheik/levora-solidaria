import type { EffectivePolicyLimits } from "./policyLimits.js";

/**
 * Motor de regras (master prompt, seção 60). Função pura: dado o contexto de
 * uma ação e os limites efetivos, devolve se segue automática, exige revisão
 * humana ou dupla autorização. Sem IA, sem banco, sem efeito colateral — o
 * mesmo resultado para a mesma entrada, e por isso testável sem custo.
 *
 * As regras ficam em código versionado (não numa tabela com linguagem de
 * regras): só os LIMITES são configuráveis. Uma DSL de regras seria
 * superfície nova para erro sem necessidade hoje.
 */

export interface PolicyContext {
  /** Valor estimado do bem/doação, em reais. */
  estimatedValue?: number;
  /** Categoria do bem (minúscula, ex.: "medicamento"). */
  category?: string;
  distanceKm?: number;
  logisticsCost?: number;
  /** Valor financeiro movimentado, em reais (dinheiro, pagamento). */
  financialAmount?: number;
  /** M35 (Sentinela): o saldo do item ficou negativo depois do lançamento (violação de invariante). `undefined` = desconhecido (NÃO é "falso"). */
  negativeBalance?: boolean;
  /** M35 (Sentinela): ajuste sobre item que já teve saída/distribuição ("alteração de item já distribuído"). `undefined` = desconhecido. */
  itemAdjustedAfterDistribution?: boolean;
  /** M35 (Sentinela): a quantidade recebida difere da atribuída, na MESMA unidade. `undefined` = não comparável/desconhecido. */
  receiptQuantityMismatch?: boolean;
}

export type PolicyEffect = "require_review" | "dual_approval";

export interface PolicyViolation {
  ruleCode: string;
  effect: PolicyEffect;
  message: string;
}

export type PolicyDecision =
  | { effect: "allow"; violations: [] }
  | { effect: PolicyEffect; ruleCode: string; message: string; approvalsRequired: 1 | 2; violations: PolicyViolation[] };

const SEVERITY: Record<PolicyEffect, number> = { require_review: 1, dual_approval: 2 };

export function evaluatePolicy(context: PolicyContext, limits: EffectivePolicyLimits): PolicyDecision {
  const violations: PolicyViolation[] = [];
  const category = context.category?.trim().toLowerCase();

  if (context.financialAmount !== undefined && context.financialAmount > limits.FINANCIAL_APPROVAL_THRESHOLD) {
    violations.push({
      ruleCode: "R-FINANCEIRO-DUPLA",
      effect: "dual_approval",
      message: "Valor financeiro acima do limite exige dupla autorização",
    });
  }
  if (context.estimatedValue !== undefined && context.estimatedValue > limits.AUTO_ACCEPT_MAX_VALUE) {
    violations.push({
      ruleCode: "R-VALOR-ALTO-DUPLA",
      effect: "dual_approval",
      message: "Valor estimado acima do limite de aceite automático exige dupla autorização",
    });
  }
  if (category && limits.HIGH_RISK_CATEGORIES.includes(category)) {
    violations.push({
      ruleCode: "R-CATEGORIA-ALTO-RISCO",
      effect: "require_review",
      message: "Categoria de alto risco exige revisão humana",
    });
  }
  if (category && limits.MANUAL_REVIEW_REQUIRED_CATEGORIES.includes(category)) {
    violations.push({
      ruleCode: "R-CATEGORIA-REVISAO-MANUAL",
      effect: "require_review",
      message: "Categoria com revisão manual obrigatória",
    });
  }
  if (context.distanceKm !== undefined && context.distanceKm > limits.AUTO_PICKUP_MAX_DISTANCE_KM) {
    violations.push({
      ruleCode: "R-DISTANCIA-COLETA",
      effect: "require_review",
      message: "Distância de coleta acima do limite automático exige revisão humana",
    });
  }
  if (context.logisticsCost !== undefined && context.logisticsCost > limits.AUTO_LOGISTICS_MAX_COST) {
    violations.push({
      ruleCode: "R-CUSTO-LOGISTICO",
      effect: "require_review",
      message: "Custo logístico acima do limite automático exige revisão humana",
    });
  }

  // M35 — regras próprias da Sentinela de Integridade (docs/AGENTES_ESPECIFICACAO.md §4). Nenhuma usa número inventado: são fatos verificáveis; fato desconhecido (`undefined`) NUNCA dispara nem
  // "passa" a regra aqui — quem chama (agentAssessment.tsx) decide se a ausência torna a análise incompleta.
  if (context.negativeBalance === true) {
    violations.push({ ruleCode: "R-SENTINELA-SALDO-NEGATIVO", effect: "require_review", message: "O saldo do item ficou negativo depois do lançamento: violação de integridade que exige revisão humana" });
  }
  if (context.itemAdjustedAfterDistribution === true) {
    violations.push({ ruleCode: "R-SENTINELA-AJUSTE-ITEM-DISTRIBUIDO", effect: "require_review", message: "Ajuste de um item que já teve saída/distribuição exige revisão humana" });
  }
  if (context.receiptQuantityMismatch === true) {
    violations.push({ ruleCode: "R-SENTINELA-DIVERGENCIA-RECEBIMENTO", effect: "require_review", message: "A quantidade recebida difere da quantidade atribuída: divergência físico×sistema exige revisão humana" });
  }

  if (violations.length === 0) return { effect: "allow", violations: [] };

  const worst = [...violations].sort((a, b) => SEVERITY[b.effect] - SEVERITY[a.effect])[0];
  return {
    effect: worst.effect,
    ruleCode: worst.ruleCode,
    message: worst.message,
    approvalsRequired: worst.effect === "dual_approval" ? 2 : 1,
    violations,
  };
}
