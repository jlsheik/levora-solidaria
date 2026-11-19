/** M35 — avaliação explicável (função PURA): regras da Sentinela e do Risk Engine, ausência ≠ zero, contratos v1/v2, completude, nenhum número inventado. Sem banco. */
import { describe, it, expect } from "vitest";
import { assessEvent, summarizeDecision, PENDING_RULES, type Assessment } from "../src/helpers/agentAssessment";
import { POLICY_LIMIT_DEFS } from "../src/helpers/policyLimits";
import { evaluatePolicy } from "../src/helpers/policyRules";

const L = {
  AUTO_ACCEPT_MAX_VALUE: POLICY_LIMIT_DEFS.AUTO_ACCEPT_MAX_VALUE.default, AUTO_PICKUP_MAX_DISTANCE_KM: POLICY_LIMIT_DEFS.AUTO_PICKUP_MAX_DISTANCE_KM.default,
  AUTO_LOGISTICS_MAX_COST: POLICY_LIMIT_DEFS.AUTO_LOGISTICS_MAX_COST.default, FINANCIAL_APPROVAL_THRESHOLD: POLICY_LIMIT_DEFS.FINANCIAL_APPROVAL_THRESHOLD.default,
  HIGH_RISK_CATEGORIES: [...POLICY_LIMIT_DEFS.HIGH_RISK_CATEGORIES.default], MANUAL_REVIEW_REQUIRED_CATEGORIES: [...POLICY_LIMIT_DEFS.MANUAL_REVIEW_REQUIRED_CATEGORIES.default],
};
const ok = (type: "stock_transaction.created" | "allocation.received" | "opportunity.created", payload: unknown, limits = L): Assessment => {
  const r = assessEvent(type, payload, limits); if (!r.ok) throw new Error(`avaliação inválida: ${r.code}`); return r.assessment;
};
const rule = (a: Assessment, code: string) => a.rules.find((r) => r.code === code)!;

describe("Sentinela — stock_transaction.created", () => {
  const base = { v: 2, itemId: 1, type: "entrada", delta: 5, newStock: 12, previousStock: 7, source: "lancamento_manual", itemHasPriorDistribution: false, actorUserId: 9 };
  it("entrada com saldo normal: análise completa, nenhuma regra violada", () => {
    const a = ok("stock_transaction.created", base);
    expect(a.completeness).toBe("completa"); expect(summarizeDecision(a)).toBe("permitido"); expect(a.contractVersion).toBe(2);
    expect(rule(a, "R-SENTINELA-SALDO-NEGATIVO").result).toBe("ok"); expect(rule(a, "R-SENTINELA-AJUSTE-ITEM-DISTRIBUIDO").result).toBe("nao_se_aplica");
    expect(a.facts).toMatchObject({ tipo: "entrada", variacao: 5, saldoApos: 12, atorId: 9 });
  });
  it("saldo negativo viola a regra de integridade → revisão", () => {
    const a = ok("stock_transaction.created", { ...base, type: "ajuste", delta: -20, newStock: -3, previousStock: 17 });
    expect(rule(a, "R-SENTINELA-SALDO-NEGATIVO").result).toBe("violada"); expect(summarizeDecision(a)).toBe("revisao");
  });
  it("ajuste de item JÁ distribuído → revisão; ajuste de item nunca distribuído → permitido", () => {
    expect(summarizeDecision(ok("stock_transaction.created", { ...base, type: "ajuste", delta: -2, itemHasPriorDistribution: true }))).toBe("revisao");
    expect(summarizeDecision(ok("stock_transaction.created", { ...base, type: "ajuste", delta: -2, itemHasPriorDistribution: false }))).toBe("permitido");
  });
  it("contrato v1 (sem `v`): ajuste NÃO pode ser avaliado → análise INSUFICIENTE (nunca aprovada); entrada v1 continua avaliável", () => {
    const adj = ok("stock_transaction.created", { itemId: 1, type: "ajuste", delta: -2, newStock: 8 });
    expect(adj.contractVersion).toBe(1); expect(adj.completeness).toBe("insuficiente"); expect(adj.missingRequired).toEqual(["itemHasPriorDistribution"]); expect(summarizeDecision(adj)).toBe("dados_insuficientes");
    expect(rule(adj, "R-SENTINELA-AJUSTE-ITEM-DISTRIBUIDO").result).toBe("nao_avaliada");
    const ent = ok("stock_transaction.created", { itemId: 1, type: "entrada", delta: 2, newStock: 8 });
    expect(ent.completeness).toBe("completa"); expect(summarizeDecision(ent)).toBe("permitido");
  });
  it("valor/distância/custo ausentes: regras 'não avaliadas' e OPCIONAIS — não rebaixam a completude e jamais viram zero", () => {
    const a = ok("stock_transaction.created", base);
    for (const code of ["R-VALOR-ALTO-DUPLA", "R-DISTANCIA-COLETA", "R-CUSTO-LOGISTICO"]) { const r = rule(a, code); expect(r.result).toBe("nao_avaliada"); expect(r.optional).toBe(true); }
    expect(a.missingOptional).toEqual(expect.arrayContaining(["estimatedValue", "distanceKm", "logisticsCost"])); expect(a.policy.estimatedValue).toBeUndefined();
  });
  it("valor ZERO informado é diferente de valor ausente (é avaliado)", () => {
    const a = ok("stock_transaction.created", { ...base, estimatedValue: 0 });
    expect(rule(a, "R-VALOR-ALTO-DUPLA").result).toBe("ok"); expect(a.policy.estimatedValue).toBe(0);
    expect(summarizeDecision(ok("stock_transaction.created", { ...base, estimatedValue: L.AUTO_ACCEPT_MAX_VALUE + 1 }))).toBe("dupla_autorizacao");
  });
  it("estrutura inválida / não finita / negativa onde não pode → recusada (ignorado pelo motor)", () => {
    for (const bad of [{ ...base, delta: "abc" }, { ...base, newStock: Infinity }, { ...base, itemId: -1 }, { ...base, type: "" }, "texto", null]) expect(assessEvent("stock_transaction.created", bad, L).ok).toBe(false);
    // valor estimado negativo não é aceito como fato: vira ausente (não 0)
    expect(ok("stock_transaction.created", { ...base, estimatedValue: -5 }).policy.estimatedValue).toBeUndefined();
  });
});

describe("Sentinela — allocation.received", () => {
  const base = { v: 2, allocationId: 3, itemId: 1, quantityReceived: 5, quantityAllocated: 5, sameUnit: true, stockTransactionId: "10", opportunityConcluded: true, actorUserId: 9 };
  it("recebido = atribuído (mesma unidade) → permitido, completa", () => { const a = ok("allocation.received", base); expect(a.completeness).toBe("completa"); expect(summarizeDecision(a)).toBe("permitido"); });
  it("diferença de quantidade na mesma unidade → divergência → revisão (tolerância não definida, e isso é dito)", () => {
    const a = ok("allocation.received", { ...base, quantityReceived: 4 });
    expect(rule(a, "R-SENTINELA-DIVERGENCIA-RECEBIMENTO")).toMatchObject({ result: "violada", effect: "require_review" }); expect(rule(a, "R-SENTINELA-DIVERGENCIA-RECEBIMENTO").reason).toMatch(/tolerância não definida/);
    expect(PENDING_RULES["allocation.received"].map((r) => r.code)).toContain("R-SENTINELA-TOLERANCIA-RECEBIMENTO");
  });
  it("precisão NUMERIC(12,3): 0.1+0.2 vs 0.3 NÃO é divergência; 0.001 de diferença é", () => {
    expect(summarizeDecision(ok("allocation.received", { ...base, quantityReceived: 0.1 + 0.2, quantityAllocated: "0.300" }))).toBe("permitido");
    expect(summarizeDecision(ok("allocation.received", { ...base, quantityReceived: "0.301", quantityAllocated: 0.3 }))).toBe("revisao");
  });
  it("unidades diferentes → quantidades não comparáveis: regra NÃO avaliada, análise PARCIAL (não completa)", () => {
    const a = ok("allocation.received", { ...base, quantityReceived: 4, sameUnit: false });
    expect(rule(a, "R-SENTINELA-DIVERGENCIA-RECEBIMENTO").result).toBe("nao_avaliada"); expect(a.completeness).toBe("parcial"); expect(summarizeDecision(a)).toBe("permitido");
  });
  it("contrato v1 (sem quantidade atribuída) → INSUFICIENTE, nunca aprovado", () => {
    const a = ok("allocation.received", { itemId: 1, quantityReceived: 5, stockTransactionId: "10", opportunityConcluded: false });
    expect(a.completeness).toBe("insuficiente"); expect(a.missingRequired).toEqual(["quantityAllocated"]); expect(summarizeDecision(a)).toBe("dados_insuficientes");
  });
});

describe("Risk Engine — opportunity.created", () => {
  it("categoria comum → permitido; categoria de alto risco → revisão (limite efetivo mostrado)", () => {
    const a = ok("opportunity.created", { v: 2, category: "Roupa ", quantityOffered: 3, unit: "kg" }); expect(a.facts.categoria).toBe("roupa"); expect(summarizeDecision(a)).toBe("permitido");
    const r = ok("opportunity.created", { v: 2, category: "MEDICAMENTO", quantityOffered: 3, unit: "kg" });
    expect(summarizeDecision(r)).toBe("revisao"); expect(rule(r, "R-CATEGORIA-ALTO-RISCO")).toMatchObject({ result: "violada" }); expect(rule(r, "R-CATEGORIA-ALTO-RISCO").limit).toContain("medicamento");
  });
  it("restrição da organização (categoria acrescentada) muda a decisão e o limite exibido", () => {
    const strict = { ...L, HIGH_RISK_CATEGORIES: [...L.HIGH_RISK_CATEGORIES, "roupa"] };
    expect(summarizeDecision(ok("opportunity.created", { v: 2, category: "roupa", quantityOffered: 1, unit: "kg" }, strict))).toBe("revisao");
  });
  it("SEM categoria: análise INSUFICIENTE (as regras por categoria não foram avaliadas); não é 'sem risco' nem aprovação", () => {
    for (const category of [null, "", "   "]) {
      const a = ok("opportunity.created", { v: 2, category, quantityOffered: 3, unit: "kg" });
      expect(a.completeness).toBe("insuficiente"); expect(a.missingRequired).toEqual(["category"]); expect(summarizeDecision(a)).toBe("dados_insuficientes");
      expect(rule(a, "R-CATEGORIA-ALTO-RISCO").result).toBe("nao_avaliada");
    }
  });
  it("quantidade desconhecida (null) é OPCIONAL e aparece como ausente — nunca 0", () => {
    const a = ok("opportunity.created", { v: 2, category: "roupa", quantityOffered: null, unit: null });
    expect(a.facts.quantidadeOferecida).toBeNull(); expect(a.missingOptional).toContain("quantityOffered"); expect(a.completeness).toBe("completa");
    expect(ok("opportunity.created", { v: 2, category: "roupa", quantityOffered: 0, unit: "kg" }).facts.quantidadeOferecida).toBe(0);
  });
  it("evento v1 (só categoria/quantidade/unidade) continua aceito; regras sem especificação ficam como PENDENTES e não decidem", () => {
    const a = ok("opportunity.created", { category: "roupa", quantityOffered: 3, unit: "kg" });
    expect(a.contractVersion).toBe(1); expect(a.completeness).toBe("completa");
    expect(PENDING_RULES["opportunity.created"].map((r) => r.code)).toEqual(["R-RISK-VOLUME-SUBITO", "R-RISK-CONTA-NOVA-ALTO-VALOR"]);
    expect(JSON.stringify(a)).not.toMatch(/pontuacao|score|risco_pontos/i); // nenhuma pontuação numérica inventada
  });
});

describe("política de regras (nova): fato desconhecido não dispara nem 'passa'", () => {
  it("evaluatePolicy só aplica as regras da Sentinela com true explícito", () => {
    expect(evaluatePolicy({}, L as never).effect).toBe("allow");
    expect(evaluatePolicy({ negativeBalance: false, itemAdjustedAfterDistribution: false, receiptQuantityMismatch: false }, L as never).effect).toBe("allow");
    for (const [k, code] of [["negativeBalance", "R-SENTINELA-SALDO-NEGATIVO"], ["itemAdjustedAfterDistribution", "R-SENTINELA-AJUSTE-ITEM-DISTRIBUIDO"], ["receiptQuantityMismatch", "R-SENTINELA-DIVERGENCIA-RECEBIMENTO"]] as const) {
      const d = evaluatePolicy({ [k]: true }, L as never); expect(d.effect).toBe("require_review"); expect(d.violations.map((v) => v.ruleCode)).toEqual([code]);
    }
  });
});
