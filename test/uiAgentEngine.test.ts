// @vitest-environment jsdom
/**
 * M34 — painéis do motor de eventos (componentes REAIS, react-query real, fetch simulado no formato do servidor): processamento (estados, filtros, paginação, histórico, "processar agora" com confirmação),
 * retenção (somente leitura), limites globais (somente leitura), ligar/desligar agente, histórico de limites e a lógica pura de rótulos. Nada aqui afirma execução real: tudo é simulação.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import superjson from "superjson";
import { AgentEventsPanel } from "../src/components/AgentEventsPanel";
import { RetentionPanel } from "../src/components/RetentionPanel";
import { PlatformLimitsPanel } from "../src/components/PlatformLimitsPanel";
import { AgentOverviewPanel } from "../src/components/AgentOverviewPanel";
import { PolicyLimitsPanel } from "../src/components/PolicyLimitsPanel";
import { engineHeadline, reasonText, runStatusLabel, eventTypeLabel, RUN_STATUS_LABEL } from "../src/components/agentOpsView";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
let host: HTMLDivElement | null = null; let root: Root | null = null;
type Call = { url: string; method: string; body: unknown };
let calls: Call[] = []; let routes: Array<[RegExp, (c: Call) => Response | Promise<Response>]> = [];
const ok = (o: unknown) => new Response(superjson.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
const err = (status: number, message: string) => new Response(superjson.stringify({ message }), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => { calls = []; routes = []; vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { const c: Call = { url: String(url), method: init?.method ?? "GET", body: init?.body ? superjson.parse(String(init.body)) : undefined }; calls.push(c); const hit = routes.find(([re]) => re.test(c.url)); return hit ? hit[1](c) : err(404, "rota não simulada"); })); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); document.body.innerHTML = ""; host = null; root = null; vi.unstubAllGlobals(); });
async function mount(el: React.ReactElement) { const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); await act(async () => { root!.render(React.createElement(QueryClientProvider, { client: qc }, el)); }); await act(async () => { await tick(100); }); }
const text = () => document.body.textContent ?? "";
const btn = (re: RegExp) => [...document.body.querySelectorAll("button")].find((b) => re.test((b.textContent ?? "").trim()) || re.test(b.getAttribute("aria-label") ?? "")) as HTMLButtonElement | undefined;
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); await tick(20); });
}
async function click(re: RegExp) { const b = btn(re); expect(b, `botão ${re}`).toBeTruthy(); await act(async () => { b!.click(); await tick(80); }); }

const run = (o: Record<string, unknown> = {}) => ({ id: "11", eventId: "5", eventType: "opportunity.created", entityType: "donation_opportunity", entityId: "9", agentName: "risk-engine", status: "simulacao_concluida", reasonCode: "simulacao_concluida", reason: "Simulação concluída: nada foi executado fora do sistema.", ruleCode: null, exceptionId: null, attempts: 0, simulated: true, createdAt: "2026-11-09T12:00:00.000Z", updatedAt: "2026-11-09T12:00:01.000Z", ...o });
const page = (runs: unknown[], over: Record<string, unknown> = {}, summary: Record<string, unknown> = {}) => ({ summary: { total: runs.length, byStatus: { simulacao_concluida: runs.length }, unprocessedEvents: 0, enabledEngineAgents: 1, ...summary }, runs, nextBeforeId: null, detail: null, ...over });

describe("lógica pura do motor", () => {
  it("todo estado tem rótulo em texto e explicação; nenhum diz 'executado'", () => {
    for (const k of ["recebido", "validado", "ignorado", "bloqueado_politica", "aguardando_aprovacao", "rejeitado", "autorizado_simulacao", "simulacao_concluida", "falha"]) { expect(RUN_STATUS_LABEL[k].label.length).toBeGreaterThan(2); expect(RUN_STATUS_LABEL[k].help.length).toBeGreaterThan(10); expect(RUN_STATUS_LABEL[k].label).not.toMatch(/executad/i); }
    expect(runStatusLabel("simulacao_concluida").label).toBe("Simulação concluída"); expect(runStatusLabel("novo").label).toBe("novo");
    expect(eventTypeLabel("opportunity.created")).toMatch(/Oportunidade/); expect(reasonText("automation_paused")).toMatch(/pausada/); expect(reasonText(null)).toBe("—");
  });
  it("engineHeadline: nada ligado ≠ tudo em ordem; falha > aprovação > bloqueio > fila", () => {
    const base = { total: 0, byStatus: {}, unprocessedEvents: 0, enabledEngineAgents: 0 };
    expect(engineHeadline(base).tone).toBe("info"); expect(engineHeadline(base).text).toMatch(/Nenhum agente está ligado/);
    expect(engineHeadline({ ...base, enabledEngineAgents: 1 }).tone).toBe("ok");
    expect(engineHeadline({ ...base, enabledEngineAgents: 1, total: 3, byStatus: { falha: 1, aguardando_aprovacao: 2 } }).text).toMatch(/falha/);
    expect(engineHeadline({ ...base, enabledEngineAgents: 1, total: 2, byStatus: { aguardando_aprovacao: 2 } }).text).toMatch(/2 eventos aguardam/);
    expect(engineHeadline({ ...base, enabledEngineAgents: 1, total: 1, byStatus: { bloqueado_politica: 1 } }).text).toMatch(/bloqueado/);
    expect(engineHeadline({ ...base, enabledEngineAgents: 1, unprocessedEvents: 4 }).text).toMatch(/4 eventos aguardam o próximo/);
  });
});

describe("AgentEventsPanel", () => {
  it("lista com estado em texto, selo 'Simulado', números reais e sem prometer ação real", async () => {
    routes = [[/agent-events/, () => ok(page([run(), run({ id: "12", status: "aguardando_aprovacao", ruleCode: "R-CATEGORIA-ALTO-RISCO", reason: "Uma regra de proteção interrompeu o evento." })], {}, { byStatus: { simulacao_concluida: 1, aguardando_aprovacao: 1 } }))]];
    await mount(React.createElement(AgentEventsPanel, { organizationId: 1, canManage: true, onOpenExceptions: () => undefined }));
    expect(text()).toMatch(/Processamento de eventos/); expect(text()).toMatch(/Tudo é simulado/); expect(text()).toMatch(/Simulação concluída/); expect(text()).toMatch(/Aguardando aprovação/);
    expect((text().match(/Simulado/g) ?? []).length).toBeGreaterThanOrEqual(2); expect(text()).toMatch(/1 evento aguarda a decisão/); expect(btn(/^Ver exceção/)).toBeTruthy();
  });
  it("antes de qualquer evento: estado vazio orientador, sem zeros apresentados como saúde", async () => {
    routes = [[/agent-events/, () => ok(page([], {}, { total: 0, byStatus: {}, enabledEngineAgents: 0 }))]];
    await mount(React.createElement(AgentEventsPanel, { organizationId: 1, canManage: true }));
    expect(text()).toMatch(/Nenhum agente está ligado/); expect(text()).toMatch(/ligue um agente/); expect(text()).not.toMatch(/Nenhum evento pendente de processamento/);
  });
  it("filtro por situação consulta o servidor com o estado; paginação 'Carregar mais' usa o cursor", async () => {
    let n = 0;
    routes = [[/agent-events/, (c) => { n++; return ok(page([run({ id: String(100 - n) })], { nextBeforeId: n === 1 ? "99" : null })); }]];
    await mount(React.createElement(AgentEventsPanel, { organizationId: 1, canManage: false }));
    expect(btn(/Processar eventos agora/)).toBeUndefined();
    await click(/Carregar mais/); expect(calls.at(-1)!.url).toMatch(/beforeId=99/);
    await click(/^Bloqueado/); expect(calls.at(-1)!.url).toMatch(/status=bloqueado_politica/);
  });
  it("'Processar agora' exige confirmação que explica ser simulação; só então chama o servidor", async () => {
    routes = [[/agent-engine-run/, () => ok({ registered: 2, advanced: 2, byStatus: { simulacao_concluida: 2 }, conflicts: 0, simulated: true })], [/agent-events/, () => ok(page([run()]))]];
    await mount(React.createElement(AgentEventsPanel, { organizationId: 1, canManage: true }));
    await click(/Processar eventos agora/);
    expect(document.body.querySelector('[role="dialog"]')!.textContent).toMatch(/simulação: nada é executado fora do sistema/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await click(/Processar \(simulação\)/);
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ organizationId: 1 });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
  it("histórico de uma execução mostra cada transição com ator (agente/pessoa); erro mostra alerta", async () => {
    routes = [[/runId=11/, () => ok({ ...page([]), detail: { run: run(), history: [{ fromStatus: null, toStatus: "recebido", reasonCode: "evento_recebido", actorType: "agent", actorName: "risk-engine", createdAt: "2026-11-09T12:00:00.000Z" }, { fromStatus: "aguardando_aprovacao", toStatus: "rejeitado", reasonCode: "excecao_rejeitada", actorType: "user", actorName: "Maria Revisora", createdAt: "2026-11-09T12:05:00.000Z" }] } })], [/agent-events/, () => ok(page([run()]))]];
    await mount(React.createElement(AgentEventsPanel, { organizationId: 1, canManage: true }));
    await click(/Por que esta decisão\? Execução 11/); await act(async () => { await tick(100); });
    const dlg = document.body.querySelector('[role="dialog"]')!.textContent!;
    expect(dlg).toMatch(/Recebido/); expect(dlg).toMatch(/Rejeitado/); expect(dlg).toMatch(/Pessoa \(Maria Revisora\)/); expect(dlg).toMatch(/Agente \(risk-engine\)/);
  });
  const explanation = (over: Record<string, unknown> = {}) => ({
    contractVersion: 2, facts: { categoria: "medicamento", quantidadeOferecida: 1, unidade: "kg", atorId: 7, versaoContrato: 2 }, missingRequired: [], missingOptional: ["estimatedValue", "distanceKm", "logisticsCost"], completeness: "completa",
    rules: [{ code: "R-CATEGORIA-ALTO-RISCO", title: "Categoria de alto risco", result: "violada", effect: "require_review", reason: "A categoria “medicamento” é de alto risco.", limit: "medicamento, dinheiro" }, { code: "R-VALOR-ALTO-DUPLA", title: "Valor", result: "nao_avaliada", optional: true, reason: "Valor estimado não disponível." }],
    limits: { highRiskCategories: ["medicamento", "dinheiro"] }, pendingRules: [{ code: "R-RISK-VOLUME-SUBITO", title: "Volume súbito de oportunidades", why: "Limite e janela de tempo não foram definidos." }],
    decision: "revisao", evaluatedAt: "2026-11-09T12:00:00.000Z", evaluationCount: 2, previous: [{ decision: "permitido", at: "2026-11-09T11:00:00.000Z" }], simulated: true, ...over,
  });
  it("detalhe da decisão: evento, agente, decisão, informações consideradas, ausentes, regras (com limite), regras pendentes e avaliações anteriores — tudo em texto e como simulação", async () => {
    routes = [[/runId=12/, () => ok({ ...page([]), detail: { run: run({ id: "12", status: "aguardando_aprovacao", ruleCode: "R-CATEGORIA-ALTO-RISCO", completeness: "completa", decision: "revisao" }), explanation: explanation(), history: [{ fromStatus: null, toStatus: "recebido", reasonCode: "evento_recebido", actorType: "agent", actorName: "risk-engine", createdAt: "2026-11-09T12:00:00.000Z" }] } })], [/agent-events/, () => ok(page([run({ id: "12", status: "aguardando_aprovacao", completeness: "completa", decision: "revisao" })]))]];
    await mount(React.createElement(AgentEventsPanel, { organizationId: 1, canManage: true }));
    await click(/Por que esta decisão\? Execução 12/); await act(async () => { await tick(120); });
    const t = document.body.querySelector('[role="dialog"]')!.textContent!;
    expect(t).toMatch(/Exige revisão de uma pessoa/); expect(t).toMatch(/risk-engine/); expect(t).toMatch(/Categoria da oferta/); expect(t).toMatch(/medicamento/);
    expect(t).toMatch(/Obrigatória|Opcional: valor estimado/); expect(t).toMatch(/ausência não é tratada como zero/); expect(t).toMatch(/Violada/); expect(t).toMatch(/Limite em vigor: medicamento, dinheiro/);
    expect(t).toMatch(/Não avaliada/); expect(t).toMatch(/Regras previstas, ainda não implementadas/); expect(t).toMatch(/Volume súbito/); expect(t).toMatch(/Avaliações anteriores/); expect(t).toMatch(/Permitido pela política/);
    expect(t).toMatch(/avaliação nº 2/); expect(t).toMatch(/Simulado/); expect(t).toMatch(/Sim — veja a aba Exceções/);
  });
  it("dados insuficientes: selo, explicação do que faltou e nenhuma sugestão de aprovação", async () => {
    const x = explanation({ completeness: "insuficiente", decision: "dados_insuficientes", missingRequired: ["category"], missingOptional: [], facts: { categoria: null, versaoContrato: 2 }, previous: [], evaluationCount: 1, rules: [{ code: "R-CATEGORIA-ALTO-RISCO", title: "Categoria de alto risco", result: "nao_avaliada", reason: "A oferta não informa a categoria." }] });
    routes = [[/runId=13/, () => ok({ ...page([]), detail: { run: run({ id: "13", status: "dados_insuficientes", completeness: "insuficiente", decision: "dados_insuficientes" }), explanation: x, history: [] } })], [/agent-events/, () => ok(page([run({ id: "13", status: "dados_insuficientes", reason: "Análise incompleta: falta category. Nada foi aprovado.", completeness: "insuficiente", decision: "dados_insuficientes" })], {}, { byStatus: { dados_insuficientes: 1 } }))]];
    await mount(React.createElement(AgentEventsPanel, { organizationId: 1, canManage: true }));
    expect(text()).toMatch(/Dados insuficientes/); expect(text()).toMatch(/Análise insuficiente/); expect(text()).toMatch(/1 evento com dados insuficientes: a análise ficou incompleta e nada foi aprovado/);
    await click(/Por que esta decisão\? Execução 13/); await act(async () => { await tick(120); });
    const t = document.body.querySelector('[role="dialog"]')!.textContent!;
    expect(t).toMatch(/Dados insuficientes: nada foi aprovado/); expect(t).toMatch(/Obrigatória: categoria da oferta/); expect(t).toMatch(/Não há o que aprovar/); expect(t).not.toMatch(/Permitido pela política/);
  });
  const reevalInfo = (state: string, over: Record<string, unknown> = {}) => ({ eligibility: { state, blockCode: null, message: state === "elegivel" ? "Há dados novos verificáveis nos registros de origem: é possível solicitar uma nova análise." : "Os dados obrigatórios continuam ausentes nos registros de origem: uma nova análise ainda seria insuficiente.", availableData: state === "elegivel" ? [{ field: "category", label: "Categoria da oferta", table: "donation_opportunities", recordId: "9", recordedAt: "2026-11-09T12:00:00.000Z", value: "roupa" }] : [], stillMissing: state === "elegivel" ? [] : ["category"], ...over }, history: [] as unknown[] });
  const insuffExplanation = () => explanation({ completeness: "insuficiente", decision: "dados_insuficientes", missingRequired: ["category"], missingOptional: [], facts: { categoria: null, versaoContrato: 2 }, previous: [], evaluationCount: 1, rules: [] });
  it("M36 — dados insuficientes COM dado novo: mostra a origem, o impacto da categoria, e só então oferece 'Solicitar nova análise'; confirmação explica que não cria evento nem apaga a decisão; envia só o necessário", async () => {
    routes = [
      [/agent-event-reevaluate/, () => ok({ correlationId: "c-1", newStatus: "simulacao_concluida", newDecision: "permitido", simulated: true })],
      [/runId=21/, () => ok({ ...page([]), detail: { run: run({ id: "21", status: "dados_insuficientes", completeness: "insuficiente", decision: "dados_insuficientes", reevaluated: false }), explanation: insuffExplanation(), reevaluation: reevalInfo("elegivel"), history: [] } })],
      [/agent-events/, () => ok(page([run({ id: "21", status: "dados_insuficientes", completeness: "insuficiente", decision: "dados_insuficientes", reevaluated: false })], {}, { byStatus: { dados_insuficientes: 1 }, reevaluationsAllowed: 1, reevaluationsDone: 0 }))],
    ];
    await mount(React.createElement(AgentEventsPanel, { organizationId: 1, canManage: true }));
    expect(text()).toMatch(/Reavaliações permitidas/); expect(text()).toMatch(/Reavaliações concluídas/);
    await click(/Nova análise da execução 21/); await act(async () => { await tick(150); });
    let t = document.body.querySelector('[role="dialog"]')!.textContent!;
    expect(t).toMatch(/Hoje não existe tela para corrigir a categoria/); expect(t).toMatch(/Disponível agora: Categoria da oferta = roupa/); expect(t).toMatch(/donation_opportunities, registro 9/);
    await click(/Solicitar nova análise…/);
    const dlgs = [...document.body.querySelectorAll('[role="dialog"]')]; t = dlgs.map((d) => d.textContent).join(" ");
    expect(t).toMatch(/NÃO cria um evento novo/); expect(t).toMatch(/NÃO apaga a decisão anterior/); expect(t).toMatch(/só simulação/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await type(document.getElementById("reavaliacao-motivo") as HTMLInputElement, "Categoria informada"); await click(/Solicitar nova análise \(simulação\)/);
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ organizationId: 1, runId: "21", reason: "Categoria informada" }); // nenhum dado é enviado pelo cliente: só o pedido
  });
  it("M36 — sem dado novo: explica que ainda é insuficiente e NÃO oferece o botão; sem permissão: nenhum botão em lugar nenhum", async () => {
    routes = [
      [/runId=22/, () => ok({ ...page([]), detail: { run: run({ id: "22", status: "dados_insuficientes", completeness: "insuficiente", decision: "dados_insuficientes" }), explanation: insuffExplanation(), reevaluation: reevalInfo("ainda_insuficiente"), history: [] } })],
      [/agent-events/, () => ok(page([run({ id: "22", status: "dados_insuficientes", completeness: "insuficiente", decision: "dados_insuficientes" })], {}, { byStatus: { dados_insuficientes: 1 } }))],
    ];
    await mount(React.createElement(AgentEventsPanel, { organizationId: 1, canManage: false }));
    expect(btn(/Nova análise da execução/)).toBeUndefined(); // somente leitura: sem ação na lista
    await click(/Por que esta decisão\? Execução 22/); await act(async () => { await tick(150); });
    const t = document.body.querySelector('[role="dialog"]')!.textContent!;
    expect(t).toMatch(/continuam ausentes nos registros de origem/); expect(t).toMatch(/Ainda ausente nos registros: categoria da oferta/); expect(btn(/Solicitar nova análise/)).toBeUndefined();
  });
  it("M36 — bloqueios (pausa/agente desligado) são explicados em texto; conflito do servidor aparece no diálogo sem fechar", async () => {
    routes = [
      [/agent-event-reevaluate/, () => err(409, "Esta execução já foi reavaliada ou não está em dados insuficientes")],
      [/runId=23/, () => ok({ ...page([]), detail: { run: run({ id: "23", status: "dados_insuficientes", completeness: "insuficiente", decision: "dados_insuficientes" }), explanation: insuffExplanation(), reevaluation: reevalInfo("elegivel"), history: [] } })],
      [/agent-events/, () => ok(page([run({ id: "23", status: "dados_insuficientes", completeness: "insuficiente", decision: "dados_insuficientes" })], {}, { byStatus: { dados_insuficientes: 1 } }))],
    ];
    await mount(React.createElement(AgentEventsPanel, { organizationId: 1, canManage: true }));
    await click(/Nova análise da execução 23/); await act(async () => { await tick(150); });
    await click(/Solicitar nova análise…/); await click(/Solicitar nova análise \(simulação\)/); await act(async () => { await tick(100); });
    expect([...document.body.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(" ")).toMatch(/já foi reavaliada/);
    expect([...document.body.querySelectorAll('[role="dialog"]')].length).toBeGreaterThanOrEqual(1);
  });
  it("M36 — bloqueio por pausa: mensagem própria e nenhum botão", async () => {
    routes = [
      [/runId=24/, () => ok({ ...page([]), detail: { run: run({ id: "24", status: "dados_insuficientes", completeness: "insuficiente", decision: "dados_insuficientes" }), explanation: insuffExplanation(), reevaluation: reevalInfo("indisponivel", { blockCode: "automacao_pausada", message: "x" }), history: [] } })],
      [/agent-events/, () => ok(page([run({ id: "24", status: "dados_insuficientes", completeness: "insuficiente", decision: "dados_insuficientes" })]))],
    ];
    await mount(React.createElement(AgentEventsPanel, { organizationId: 1, canManage: true }));
    await click(/Nova análise da execução 24/); await act(async () => { await tick(150); });
    expect(document.body.querySelector('[role="dialog"]')!.textContent).toMatch(/A automação está pausada: a nova análise só pode ser pedida depois de retomada/); expect(btn(/Solicitar nova análise…/)).toBeUndefined();
  });
  it("M36 — execução reavaliada: selo 'Reavaliada', decisão anterior, dados complementares com origem e histórico de reavaliações ligado por correlação", async () => {
    const x = explanation({ decision: "permitido", completeness: "completa", missingRequired: [], previous: [{ decision: "dados_insuficientes", at: "2026-11-09T11:00:00.000Z" }], supplement: { fields: { category: "roupa" }, sources: [{ field: "category", label: "Categoria da oferta", table: "donation_opportunities", recordId: "9", recordedAt: "2026-11-09T11:59:00.000Z", value: "roupa" }], requestedAt: "2026-11-09T12:00:00.000Z", correlationId: "c-77" } });
    const info = { eligibility: { state: "nao_aplicavel", blockCode: null, message: "Esta execução já foi reavaliada ou não está em dados insuficientes.", availableData: [], stillMissing: [] }, history: [{ id: "1", requestedAt: "2026-11-09T12:00:00.000Z", requestedByName: "Maria Revisora", outcome: "concluida", previousStatus: "dados_insuficientes", previousDecision: "dados_insuficientes", newStatus: "simulacao_concluida", newDecision: "permitido", correlationId: "c-77", reason: null }] };
    routes = [
      [/runId=25/, () => ok({ ...page([]), detail: { run: run({ id: "25", reevaluated: true, decision: "permitido" }), explanation: x, reevaluation: info, history: [{ fromStatus: "dados_insuficientes", toStatus: "validado", reasonCode: "reavaliacao_solicitada", actorType: "user", actorName: "Maria Revisora", createdAt: "2026-11-09T12:00:00.000Z" }] } })],
      [/agent-events/, () => ok(page([run({ id: "25", reevaluated: true, decision: "permitido" })]))],
    ];
    await mount(React.createElement(AgentEventsPanel, { organizationId: 1, canManage: true }));
    expect(text()).toMatch(/Reavaliada/);
    await click(/Por que esta decisão\? Execução 25/); await act(async () => { await tick(150); });
    const t = document.body.querySelector('[role="dialog"]')!.textContent!;
    expect(t).toMatch(/Dados complementares desta reavaliação/); expect(t).toMatch(/lido de donation_opportunities \(registro 9\)/); expect(t).toMatch(/Identificador de correlação: c-77/);
    expect(t).toMatch(/Avaliações anteriores/); expect(t).toMatch(/Dados insuficientes: nada foi aprovado/); expect(t).toMatch(/Concluída · pedida por Maria Revisora/); expect(t).toMatch(/correlação c-77/); expect(t).toMatch(/Pessoa \(Maria Revisora\)/);
    expect(btn(/Solicitar nova análise…/)).toBeUndefined();
  });
  it("execução anterior à M35 (sem explicação): diz que só há histórico", async () => {
    routes = [[/runId=14/, () => ok({ ...page([]), detail: { run: run({ id: "14" }), explanation: null, history: [] } })], [/agent-events/, () => ok(page([run({ id: "14" })]))]];
    await mount(React.createElement(AgentEventsPanel, { organizationId: 1, canManage: true }));
    await click(/Por que esta decisão\? Execução 14/); await act(async () => { await tick(120); });
    expect(document.body.querySelector('[role="dialog"]')!.textContent).toMatch(/anterior à explicação estruturada/);
  });
  it("erro do servidor: alerta e nova tentativa", async () => {
    let n = 0; routes = [[/agent-events/, () => (n++ === 0 ? err(500, "falha simulada") : ok(page([run()])))]];
    await mount(React.createElement(AgentEventsPanel, { organizationId: 1, canManage: true }));
    expect(document.body.querySelector('[role="alert"]')!.textContent).toMatch(/falha simulada/);
    await click(/Tentar de novo/); expect(text()).toMatch(/Simulação concluída/);
  });
});

describe("RetentionPanel e PlatformLimitsPanel (somente leitura)", () => {
  it("retenção: mostra categorias, 'Nunca expira' para auditoria, simulação e decisões pendentes; nenhum botão de apagar", async () => {
    const rows = [{ key: "eventos", label: "Eventos internos", group: "operacional", total: 7, oldestAt: "2026-10-01T00:00:00.000Z", olderThanSimulated: null, note: "n" }, { key: "auditoria", label: "Trilha de auditoria", group: "auditoria", total: 40, oldestAt: null, olderThanSimulated: null, note: "n" }];
    routes = [[/retention-preview/, (c) => ok({ rows: rows.map((r) => ({ ...r, olderThanSimulated: /olderThanDays=90/.test(c.url) ? 3 : null })), retentionDefined: false, deletionEnabled: false, olderThanDays: /olderThanDays=90/.test(c.url) ? 90 : null, decisionsPending: ["Definir prazo X"] })]];
    await mount(React.createElement(RetentionPanel, { organizationId: 1 }));
    expect(text()).toMatch(/nenhum registro é apagado/); expect(text()).toMatch(/Nunca expira/); expect(text()).toMatch(/Prazo não definido/); expect(text()).toMatch(/Definir prazo X/);
    expect(btn(/apagar|excluir|remover/i)).toBeUndefined();
    await click(/Mais de 90 dias/); await act(async () => { await tick(150); }); expect(calls.at(-1)!.url).toMatch(/olderThanDays=90/); expect(text()).toMatch(/não seriam tocados/); expect(text()).toMatch(/nada é apagado/);
  });
  it("limites globais: leitura, sem controle de edição, com decisões pendentes; 403 mostra erro", async () => {
    routes = [[/platform-policy-limits/, () => ok({ limits: [{ key: "AUTO_ACCEPT_MAX_VALUE", kind: "number", defaultValue: 500, globalValue: 500, organizationsRestricting: 2 }], globalWriteEnabled: false, pendingDecisions: ["Quem altera?"] })]];
    await mount(React.createElement(PlatformLimitsPanel));
    expect(text()).toMatch(/não está habilitada/); expect(text()).toMatch(/Quem altera\?/); expect(text()).toMatch(/Organizações que restringem/);
    expect(btn(/Editar|Salvar/)).toBeUndefined();
  });
  it("limites globais: erro 403", async () => {
    routes = [[/platform-policy-limits/, () => err(403, "Acesso restrito à administração da plataforma")]];
    await mount(React.createElement(PlatformLimitsPanel));
    expect(document.body.querySelector('[role="alert"]')!.textContent).toMatch(/restrito/);
  });
});

describe("ligar/desligar agente e histórico de limites", () => {
  const agent = (o: Record<string, unknown> = {}) => ({ name: "risk-engine", label: "Risk Engine", purpose: "x", version: "0.1.0", scope: "nao_registrado", registered: false, enabled: null, tools: [{ name: "assess_event", klass: "simulate" }], eventTypes: ["opportunity.created"], openAlerts: 0, pendingExceptions: 0, lastActionAt: null, ...o });
  const overview = (agents: unknown[]) => ({ agents, summary: { total: agents.length, registered: 0, enabled: 0, disabled: 0, withOpenAlerts: 0, withPendingExceptions: 0 }, automation: { paused: true, emergency: false, global: { paused: true, emergency: false, reason: "manutenção" }, organization: { paused: false, emergency: false, reason: null } }, eventConsumers: [] });
  it("ligar exige confirmação (só esta organização, só simulação) e envia a decisão; sem permissão não há botão", async () => {
    routes = [[/agents-enable/, () => ok({ agent: "risk-engine", enabled: true, scope: "organizacao" })], [/agents\?/, () => ok(overview([agent(), agent({ name: "agente-estoque", label: "Agente de Estoque", eventTypes: [] })]))]];
    await mount(React.createElement(AgentOverviewPanel, { organizationId: 1, canManage: true }));
    expect(text()).toMatch(/Plataforma pausada: “manutenção”/); expect(text()).toMatch(/Avalia: Oportunidade de doação criada/); expect(text()).toMatch(/Ainda sem eventos ligados ao motor/);
    expect([...document.body.querySelectorAll("button")].filter((b) => /^Ligar/.test(b.textContent ?? "")).length).toBe(1);
    await click(/^Ligar…/); expect(document.body.querySelector('[role="dialog"]')!.textContent).toMatch(/SOMENTE para esta organização e SOMENTE em simulação/);
    await click(/Ligar \(simulação\)/); expect(calls.find((c) => c.method === "POST")!.body).toEqual({ organizationId: 1, agent: "risk-engine", enabled: true });
  });
  it("sem permissão de gerenciar: nenhum botão de ligar/desligar", async () => {
    routes = [[/agents\?/, () => ok(overview([agent({ registered: true, enabled: true })]))]];
    await mount(React.createElement(AgentOverviewPanel, { organizationId: 1, canManage: false }));
    expect(btn(/^Ligar|^Desligar/)).toBeUndefined();
  });
  it("histórico de limites com quem alterou e quando (sem valores); vazio explica que valem os padrões", async () => {
    const limits = { limits: [{ key: "AUTO_ACCEPT_MAX_VALUE", kind: "number", defaultValue: 500, globalValue: 500, organizationValue: 300, effectiveValue: 300 }], history: [{ key: "AUTO_ACCEPT_MAX_VALUE", scope: "organizacao", byName: "Ana Admin", at: "2026-11-09T12:00:00.000Z" }] };
    routes = [[/policy-limits/, () => ok(limits)]];
    await mount(React.createElement(PolicyLimitsPanel, { organizationId: 1, canManage: true }));
    expect(text()).toMatch(/Histórico de alterações/); expect(text()).toMatch(/Valor máximo de aceite automático alterado/); expect(text()).toMatch(/por Ana Admin/); expect(text()).toMatch(/Permissão necessária para alterar/);
  });
  it("sem histórico: mensagem de estado vazio", async () => {
    routes = [[/policy-limits/, () => ok({ limits: [{ key: "AUTO_ACCEPT_MAX_VALUE", kind: "number", defaultValue: 500, globalValue: 500, organizationValue: null, effectiveValue: 500 }], history: [] })]];
    await mount(React.createElement(PolicyLimitsPanel, { organizationId: 1, canManage: false }));
    expect(text()).toMatch(/Nenhuma alteração de limite registrada/); expect(text()).toMatch(/Somente leitura para o seu papel/);
  });
});
