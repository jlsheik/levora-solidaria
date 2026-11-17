// @vitest-environment jsdom
/**
 * M37 — componentes REAIS (react-query real, fetch simulado no formato do servidor): diálogo de categoria (validação, sugestões, versão, conflito, histórico), caixa de avaliação do Risk Engine na lista de
 * oportunidades e o bloco "Oportunidade relacionada" no detalhe da decisão. Tudo é simulação; nada afirma execução real.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import superjson from "superjson";
import { OpportunityCategoryDialog } from "../src/components/OpportunityCategoryDialog";
import { OpportunityAssessmentBox } from "../src/components/OpportunityAssessmentBox";
import { AgentEventsPanel } from "../src/components/AgentEventsPanel";
import { assessmentSummary, validateCategoryDraft, MISSING_CATEGORY_HELP } from "../src/components/opportunityCategoryView";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
let host: HTMLDivElement | null = null; let root: Root | null = null;
type Call = { url: string; method: string; body: unknown };
let calls: Call[] = []; let routes: Array<[RegExp, (c: Call) => Response | Promise<Response>]> = [];
const ok = (o: unknown) => new Response(superjson.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
const err = (status: number, body: Record<string, unknown>) => new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => { calls = []; routes = []; vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { const c: Call = { url: String(url), method: init?.method ?? "GET", body: init?.body ? superjson.parse(String(init.body)) : undefined }; calls.push(c); const hit = routes.find(([re]) => re.test(c.url)); return hit ? hit[1](c) : err(404, { message: "rota não simulada" }); })); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); document.body.innerHTML = ""; host = null; root = null; vi.unstubAllGlobals(); });
async function mount(el: React.ReactElement) { const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); await act(async () => { root!.render(React.createElement(QueryClientProvider, { client: qc }, el)); }); await act(async () => { await tick(100); }); }
const text = () => document.body.textContent ?? "";
const btn = (re: RegExp) => [...document.body.querySelectorAll("button")].find((b) => re.test((b.textContent ?? "").trim()) || re.test(b.getAttribute("aria-label") ?? "")) as HTMLButtonElement | undefined;
async function click(re: RegExp) { const b = btn(re); expect(b, `botão ${re}`).toBeTruthy(); await act(async () => { b!.click(); await tick(80); }); }
async function type(el: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); await tick(20); }); }
const input = (id: string) => document.getElementById(id) as HTMLInputElement;

describe("lógica pura", () => {
  it("validateCategoryDraft e textos", () => {
    expect(validateCategoryDraft("  Roupa  de inverno ")).toEqual({ ok: true, value: "Roupa de inverno" });
    for (const bad of ["", "a", "x".repeat(61), "<b>"]) expect(validateCategoryDraft(bad).ok).toBe(false);
    expect(MISSING_CATEGORY_HELP).toMatch(/continua opcional/);
    expect(assessmentSummary({ status: "dados_insuficientes", completeness: "insuficiente", decision: null }).text).toMatch(/Nada foi aprovado/);
    expect(assessmentSummary({ status: "simulacao_concluida", completeness: "completa", decision: "permitido" }).text).toMatch(/Nada foi executado fora do sistema/);
    expect(assessmentSummary({ status: "aguardando_aprovacao", completeness: "completa", decision: "revisao" }).title).toBe("Aguardando revisão humana");
  });
});

describe("OpportunityCategoryDialog", () => {
  const target = { id: 7, title: "Oferta sintética", category: null as string | null, version: 1 };
  const sugg = [{ value: "medicamento", source: "politica" }, { value: "Roupa", source: "oportunidades" }];
  const history = { changes: [{ id: "1", field: "category", previousValue: null, newValue: "Roupa", versionBefore: 1, versionAfter: 2, changedByName: "Ana Admin", correlationId: "c-1", reason: "Conferido", createdAt: "2026-11-09T12:00:00.000Z" }] };

  it("sem categoria: explica o impacto, oferece sugestões REAIS com a origem, valida a forma e envia a versão vista; nada vem preenchido", async () => {
    routes = [[/opportunities-category/, () => ok({ opportunity: { id: 7, category: "Roupa", version: 2, updatedAt: "2026-11-09T12:00:00.000Z" }, changed: true, correlationId: "c-9", reevaluation: { available: true, runId: "5" } })], [/opportunity-changes/, () => ok({ changes: [] })]];
    const onSaved = vi.fn(); await mount(React.createElement(OpportunityCategoryDialog, { organizationId: 1, target, suggestions: sugg, onClose: () => undefined, onSaved }));
    expect(text()).toMatch(/Definir a categoria/); expect(text()).toMatch(/Sem categoria, o Risk Engine não consegue avaliar/); expect(text()).toMatch(/Salvar não dispara nenhuma análise/);
    expect(input("categoria-oportunidade").value).toBe(""); expect(btn(/Salvar categoria/)!.disabled).toBe(true);
    expect([...document.querySelectorAll("#categoria-sugestoes option")].map((o) => `${(o as HTMLOptionElement).value}|${(o as HTMLOptionElement).textContent}`)).toEqual(["medicamento|tem regra na política de risco", "Roupa|já usada em ofertas desta organização"]);
    await type(input("categoria-oportunidade"), "<b>"); expect(text()).toMatch(/Use apenas letras/); expect(btn(/Salvar categoria/)!.disabled).toBe(true);
    await type(input("categoria-oportunidade"), "Roupa"); await type(input("categoria-motivo"), "Conferido"); expect(btn(/Salvar categoria/)!.disabled).toBe(false);
    await click(/Salvar categoria/);
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ organizationId: 1, opportunityId: 7, category: "Roupa", expectedVersion: 1, reason: "Conferido" });
    expect(onSaved).toHaveBeenCalledTimes(1); expect(onSaved.mock.calls[0][0].reevaluation).toEqual({ available: true, runId: "5" });
  });

  it("conflito de versão: mostra a mensagem e a versão atual; 'Ver a versão atual' atualiza a base e o próximo envio usa a versão nova", async () => {
    let n = 0;
    routes = [[/opportunities-category/, () => (n++ === 0 ? err(409, { message: "A oportunidade foi alterada por outra pessoa depois que você a abriu.", code: "conflito_de_versao", current: { version: 3, category: "Calçados", status: "em_contato" } }) : ok({ opportunity: { id: 7, category: "Roupa", version: 4, updatedAt: "2026-11-09T12:00:00.000Z" }, changed: true, correlationId: "c", reevaluation: null }))], [/opportunity-changes/, () => ok(history)]];
    await mount(React.createElement(OpportunityCategoryDialog, { organizationId: 1, target, suggestions: sugg, onClose: () => undefined }));
    await type(input("categoria-oportunidade"), "Roupa"); await click(/Salvar categoria/);
    const alertText = [...document.body.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(" "); expect(alertText).toMatch(/Conflito de versão/); expect(alertText).toMatch(/outra pessoa/);
    await click(/Ver a versão atual \(categoria: Calçados\)/); expect(text()).toMatch(/Categoria atual: Calçados/);
    await type(input("categoria-oportunidade"), "Roupa"); await click(/Salvar categoria/);
    expect(calls.filter((c) => c.method === "POST").map((c) => (c.body as { expectedVersion: number }).expectedVersion)).toEqual([1, 3]);
  });

  it("estado final: mensagem de edição não permitida; histórico da categoria aparece com autor, versões e motivo", async () => {
    routes = [[/opportunities-category/, () => err(409, { message: "Esta oportunidade está em um estado final.", code: "estado_nao_permite", current: { version: 2, category: "Roupa", status: "recebida" } })], [/opportunity-changes/, () => ok(history)]];
    await mount(React.createElement(OpportunityCategoryDialog, { organizationId: 1, target: { ...target, category: "Roupa", version: 2 }, suggestions: [], onClose: () => undefined }));
    expect(text()).toMatch(/Corrigir a categoria/); expect(text()).toMatch(/Ana Admin/); expect(text()).toMatch(/versão 1 → 2/); expect(text()).toMatch(/“Conferido”/);
    await type(input("categoria-oportunidade"), "Calçados"); await click(/Salvar categoria/);
    expect([...document.body.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(" ")).toMatch(/Edição não permitida/);
  });

  it("erro de comunicação ao carregar o histórico não impede salvar; categoria igual à atual desabilita o botão", async () => {
    routes = [[/opportunity-changes/, () => err(500, { message: "falha" })]];
    await mount(React.createElement(OpportunityCategoryDialog, { organizationId: 1, target: { ...target, category: "Roupa", version: 2 }, suggestions: [], onClose: () => undefined }));
    expect(text()).toMatch(/Não foi possível carregar o histórico/); expect(btn(/Salvar categoria/)!.disabled).toBe(true); // valor inicial = atual
    await type(input("categoria-oportunidade"), "Calçados"); expect(btn(/Salvar categoria/)!.disabled).toBe(false);
  });
});

describe("OpportunityAssessmentBox", () => {
  const base = { runId: "5", status: "dados_insuficientes", completeness: "insuficiente" as const, decision: "dados_insuficientes", reevaluation: "elegivel" as const, blockCode: null, categoryConsidered: null };
  const box = (a: Record<string, unknown>, canRequest = true) => React.createElement(OpportunityAssessmentBox, { organizationId: 1, opportunityId: 7, assessment: { ...base, ...a } as never, canRequest, justificationHref: "/organizacoes/1/automacao?run=5" });

  it("categoria corrigida (elegível): avisa que há informação nova, oferece a nova análise e a confirmação diz que não cria evento nem apaga a avaliação anterior; envia só o pedido", async () => {
    routes = [[/agent-event-reevaluate/, () => ok({ correlationId: "c-1", newStatus: "simulacao_concluida", newDecision: "permitido", simulated: true })]];
    await mount(box({})); expect(text()).toMatch(/Avaliação incompleta/); expect(text()).toMatch(/Simulação/); expect(text()).toMatch(/Há uma informação nova disponível para análise/); expect(document.querySelector('a[href="/organizacoes/1/automacao?run=5"]')).toBeTruthy();
    await click(/Solicitar nova análise…/); const t = document.body.querySelector('[role="dialog"]')!.textContent!;
    expect(t).toMatch(/NÃO cria um evento novo/); expect(t).toMatch(/NÃO apaga a avaliação anterior/); expect(t).toMatch(/só simulação/); expect(calls.some((c) => c.method === "POST")).toBe(false);
    await type(input("reavaliar-motivo-7"), "Categoria corrigida"); await click(/Solicitar nova análise \(simulação\)/);
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ organizationId: 1, runId: "5", reason: "Categoria corrigida" });
  });
  it("ainda sem categoria: orienta a definir antes e não oferece o botão; sem permissão de automação o botão não existe", async () => {
    await mount(box({ reevaluation: "ainda_insuficiente" })); expect(text()).toMatch(/defina-a antes de pedir uma nova análise/); expect(btn(/Solicitar nova análise/)).toBeUndefined();
    act(() => root?.unmount()); host?.remove(); document.body.innerHTML = "";
    await mount(box({}, false)); expect(btn(/Solicitar nova análise/)).toBeUndefined();
  });
  it("bloqueios (pausa) e erro do servidor no pedido: mensagem própria e alerta recuperável", async () => {
    await mount(box({ reevaluation: "indisponivel", blockCode: "automacao_pausada" })); expect(text()).toMatch(/A automação está pausada/); expect(btn(/Solicitar nova análise/)).toBeUndefined();
    act(() => root?.unmount()); host?.remove(); document.body.innerHTML = "";
    routes = [[/agent-event-reevaluate/, () => err(409, { message: "Os dados obrigatórios continuam ausentes nos registros de origem." })]];
    await mount(box({})); await click(/Solicitar nova análise…/); await click(/Solicitar nova análise \(simulação\)/); await act(async () => { await tick(80); });
    expect([...document.body.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(" ")).toMatch(/continuam ausentes/);
  });
  it("avaliação concluída / em revisão: decisão em texto e link para a justificativa; nada de 'executado'", async () => {
    await mount(box({ status: "simulacao_concluida", completeness: "completa", decision: "permitido", reevaluation: null })); expect(text()).toMatch(/Avaliação concluída \(simulação\)/); expect(text()).toMatch(/Decisão: Permitido pela política/); expect(text()).toMatch(/Nada foi executado fora do sistema/);
    act(() => root?.unmount()); host?.remove(); document.body.innerHTML = "";
    await mount(box({ status: "aguardando_aprovacao", completeness: "completa", decision: "revisao", reevaluation: null })); expect(text()).toMatch(/Aguardando revisão humana/); expect(text()).toMatch(/fila de exceções/);
  });
});

describe("AgentEventsPanel: navegação contextual e oportunidade relacionada", () => {
  const run = { id: "31", eventId: "9", eventType: "opportunity.created", entityType: "donation_opportunity", entityId: "7", agentName: "risk-engine", status: "simulacao_concluida", reasonCode: "simulacao_concluida", reason: "ok", ruleCode: null, exceptionId: null, attempts: 0, completeness: "completa", decision: "permitido", reevaluated: true, simulated: true, createdAt: "2026-11-09T12:00:00.000Z", updatedAt: "2026-11-09T12:00:01.000Z" };
  const expl = { contractVersion: 2, facts: { categoria: "roupa", origemCategoria: "registro da oportunidade (versão 2)" }, missingRequired: [], missingOptional: [], completeness: "completa", rules: [], limits: {}, pendingRules: [], decision: "permitido", evaluatedAt: "2026-11-09T12:00:00.000Z", evaluationCount: 2, previous: [{ decision: "dados_insuficientes", at: "2026-11-09T11:00:00.000Z" }], simulated: true };
  const page = (runs: unknown[]) => ({ summary: { total: runs.length, byStatus: {}, unprocessedEvents: 0, enabledEngineAgents: 1 }, runs, nextBeforeId: null, detail: null });

  it("?run= abre a decisão direto; mostra categoria considerada × atual, versão, origem e o aviso de mudança; o link volta à oportunidade (destaque)", async () => {
    const nav = vi.fn();
    routes = [[/runId=31/, () => ok({ ...page([]), detail: { run, explanation: expl, reevaluation: null, related: { id: 7, title: "Oferta sintética", status: "registrada", currentCategory: "medicamento", version: 3, categoryConsidered: "roupa", categoryChangedSinceDecision: true, lastCategoryChange: { at: "2026-11-09T12:30:00.000Z", byName: "Ana Admin" } }, history: [] } })], [/agent-events/, () => ok(page([run]))]];
    await mount(React.createElement(AgentEventsPanel, { organizationId: 1, canManage: true, initialRunId: "31", opportunityHref: (id: number) => `/organizacoes/1/oportunidades?destaque=${id}`, onOpenOpportunity: nav }));
    await act(async () => { await tick(150); });
    const t = document.body.querySelector('[role="dialog"]')!.textContent!;
    expect(t).toMatch(/Oportunidade relacionada/); expect(t).toMatch(/Categoria considerada\s*roupa — origem: registro da oportunidade \(versão 2\)/); expect(t).toMatch(/Categoria atual no registro\s*medicamento · versão 3 · alterada em .* por Ana Admin/);
    expect(t).toMatch(/A categoria do registro é diferente da considerada nesta avaliação/); expect(t).toMatch(/continua baseada na categoria considerada acima, não na atual/);
    const a = document.querySelector('a[href="/organizacoes/1/oportunidades?destaque=7"]') as HTMLAnchorElement; expect(a).toBeTruthy();
    await act(async () => { a.click(); await tick(20); }); expect(nav).toHaveBeenCalledWith(7);
  });
  it("sem oportunidade relacionada (outro tipo de evento) o bloco não aparece", async () => {
    routes = [[/runId=31/, () => ok({ ...page([]), detail: { run: { ...run, eventType: "stock_transaction.created" }, explanation: expl, reevaluation: null, related: null, history: [] } })], [/agent-events/, () => ok(page([run]))]];
    await mount(React.createElement(AgentEventsPanel, { organizationId: 1, canManage: true, initialRunId: "31" })); await act(async () => { await tick(150); });
    expect(document.body.querySelector('[role="dialog"]')!.textContent).not.toMatch(/Oportunidade relacionada/);
  });
});
