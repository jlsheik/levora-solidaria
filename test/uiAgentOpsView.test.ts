/** M33 — lógica pura da área de agentes (rótulos, validação de limites, resumo). Sem DOM. */
import { describe, it, expect } from "vitest";
import { agentStateLabel, agentsHeadline, approvalsMissing, fmtLimit, parseCategoryList, sameLimit, summarizeRequest, validateLimitDraft, ruleLabel } from "../src/components/agentOpsView";

const S = { total: 3, registered: 2, enabled: 2, disabled: 0, withOpenAlerts: 0, withPendingExceptions: 0 };

describe("validateLimitDraft — espelha o servidor (só mais restritivo)", () => {
  it("número acima do global é recusado; igual/menor passa; vírgula decimal aceita", () => {
    expect(validateLimitDraft("number", "600", 500).value).toBeNull();
    expect(validateLimitDraft("number", "600", 500).error).toMatch(/mais restritivo/);
    expect(validateLimitDraft("number", "500", 500)).toEqual({ error: null, value: 500 });
    expect(validateLimitDraft("number", "12,5", 20)).toEqual({ error: null, value: 12.5 });
  });
  it("vazio, negativo e não numérico são recusados", () => {
    for (const raw of ["", "  ", "-1", "abc", "NaN", "Infinity"]) expect(validateLimitDraft("number", raw, 10).value).toBeNull();
  });
  it("lista: só pode acrescentar; remover categoria global é recusado", () => {
    expect(validateLimitDraft("list", "a, b, c", ["a", "b"])).toEqual({ error: null, value: ["a", "b", "c"] });
    const r = validateLimitDraft("list", "a", ["a", "b"]);
    expect(r.value).toBeNull(); expect(r.error).toMatch(/ACRESCENTAR/); expect(r.error).toMatch(/b/);
  });
  it("lista: normaliza caixa/duplicatas e limita tamanho", () => {
    expect(parseCategoryList(" B,a;A\nb ,, ")).toEqual(["a", "b"]);
    expect(validateLimitDraft("list", "x".repeat(61), []).error).toMatch(/60/);
    expect(validateLimitDraft("list", Array.from({ length: 101 }, (_, i) => `c${i}`).join(","), []).error).toMatch(/100/);
  });
  it("sameLimit compara por valor", () => { expect(sameLimit(["a"], ["a"])).toBe(true); expect(sameLimit(1, 2)).toBe(false); });
});

describe("formatação e resumo", () => {
  it("fmtLimit", () => {
    expect(fmtLimit(1000, "R$")).toMatch(/R\$\s?1\.000,00/); expect(fmtLimit(50, "km")).toBe("50 km"); expect(fmtLimit([], null)).toBe("nenhuma"); expect(fmtLimit(["a", "b"], null)).toBe("a, b");
  });
  it("agentsHeadline: emergência > pausa > exceções > alertas > nada registrado > ok", () => {
    expect(agentsHeadline(S, { paused: true, emergency: true }).text).toMatch(/emergência/);
    expect(agentsHeadline(S, { paused: true, emergency: false }).text).toMatch(/pausada/);
    expect(agentsHeadline({ ...S, withPendingExceptions: 2, withOpenAlerts: 1 }, { paused: false, emergency: false }).text).toMatch(/2 agentes com exceções/);
    expect(agentsHeadline({ ...S, withOpenAlerts: 1 }, { paused: false, emergency: false }).text).toBe("1 agente com alerta em aberto");
    expect(agentsHeadline({ ...S, registered: 0 }, { paused: false, emergency: false }).tone).toBe("info");
    expect(agentsHeadline(S, { paused: false, emergency: false }).tone).toBe("ok");
  });
  it("agentStateLabel", () => {
    expect(agentStateLabel({ registered: false, enabled: null }).label).toBe("Não registrado");
    expect(agentStateLabel({ registered: true, enabled: true }).label).toBe("Ligado");
    expect(agentStateLabel({ registered: true, enabled: false })).toEqual({ label: "Desligado", tone: "attention" });
  });
  it("approvalsMissing só conta pendentes e nunca é negativo", () => {
    expect(approvalsMissing({ status: "pendente", approvals: 1, approvalsRequired: 2 })).toBe(1);
    expect(approvalsMissing({ status: "aprovada", approvals: 2, approvalsRequired: 2 })).toBe(0);
    expect(approvalsMissing({ status: "pendente", approvals: 3, approvalsRequired: 2 })).toBe(0);
  });
  it("summarizeRequest: escalares truncados, objetos resumidos, nunca despeja JSON", () => {
    const r = summarizeRequest({ a: 1, b: "x".repeat(200), c: { deep: 1 }, d: [1, 2], e: null });
    expect(r.find((x) => x.key === "b")!.value.length).toBeLessThanOrEqual(80);
    expect(r.find((x) => x.key === "c")!.value).toBe("objeto"); expect(r.find((x) => x.key === "d")!.value).toBe("2 item(ns)"); expect(r.find((x) => x.key === "e")).toBeUndefined();
    expect(summarizeRequest("texto")).toEqual([]); expect(summarizeRequest([1])).toEqual([]); expect(summarizeRequest(null)).toEqual([]);
    expect(summarizeRequest(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]))).length).toBe(8);
  });
  it("ruleLabel tem fallback para código desconhecido", () => { expect(ruleLabel("XYZ").title).toBe("XYZ"); });
});
