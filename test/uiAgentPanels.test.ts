// @vitest-environment jsdom
/**
 * M33 — painéis da plataforma de agentes com os componentes REAIS, react-query real e `fetch` simulado (superjson, formato do servidor).
 * Cobre: carregamento/vazio/erro, aprovar e rejeitar exceção (diálogo, justificativa, corpo enviado), conflito, alerta (reconhecer/resolver), pausa com confirmação,
 * limite só-mais-restritivo, somente leitura e detalhe do agente.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import superjson from "superjson";
import { AgentOverviewPanel } from "../src/components/AgentOverviewPanel";
import { AgentExceptionsPanel } from "../src/components/AgentExceptionsPanel";
import { AgentAlertsPanel } from "../src/components/AgentAlertsPanel";
import { AutomationControlsPanel } from "../src/components/AutomationControlsPanel";
import { PolicyLimitsPanel } from "../src/components/PolicyLimitsPanel";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
let host: HTMLDivElement | null = null; let root: Root | null = null;
type Call = { url: string; method: string; body: unknown };
let calls: Call[] = []; let routes: Array<[RegExp, (c: Call) => Response | Promise<Response>]> = [];
const ok = (o: unknown) => new Response(superjson.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
const err = (status: number, message: string) => new Response(superjson.stringify({ message }), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls = []; routes = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const c: Call = { url: String(url), method: init?.method ?? "GET", body: init?.body ? superjson.parse(String(init.body)) : undefined };
    calls.push(c);
    const hit = routes.find(([re]) => re.test(c.url));
    return hit ? hit[1](c) : err(404, "rota não simulada");
  }));
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); document.body.innerHTML = ""; host = null; root = null; vi.unstubAllGlobals(); });

async function mount(el: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(React.createElement(QueryClientProvider, { client: qc }, el)); });
  await act(async () => { await tick(80); });
}
const text = () => document.body.textContent ?? "";
const btn = (re: RegExp) => [...document.body.querySelectorAll("button")].find((b) => re.test(b.textContent ?? b.getAttribute("aria-label") ?? "") || re.test(b.getAttribute("aria-label") ?? "")) as HTMLButtonElement | undefined;
async function click(re: RegExp) { const b = btn(re); expect(b, `botão ${re}`).toBeTruthy(); await act(async () => { b!.click(); await tick(60); }); }
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); await tick(20); });
}

const exc = (over: Record<string, unknown> = {}) => ({ id: "7", toolName: "create_integrity_alert", ruleCode: "R1", approvalsRequired: 1, approvals: 0, status: "pendente", request: { valor: 900, categoria: "x" }, agentName: "agente_teste", createdAt: "2026-11-01T12:00:00.000Z", consumedAt: null, myDecision: null, decisions: [], ...over });

describe("AgentExceptionsPanel", () => {
  it("vazio: mensagem orientadora", async () => {
    routes = [[/exception-queue/, () => ok({ exceptions: [] })]];
    await mount(React.createElement(AgentExceptionsPanel, { organizationId: 1, canDecide: true }));
    expect(text()).toMatch(/Nenhuma exceção aguardando decisão/);
  });
  it("erro: alerta com nova tentativa que recarrega", async () => {
    let n = 0; routes = [[/exception-queue/, () => (n++ === 0 ? err(500, "falha simulada") : ok({ exceptions: [] }))]];
    await mount(React.createElement(AgentExceptionsPanel, { organizationId: 1, canDecide: true }));
    expect(document.body.querySelector('[role="alert"]')!.textContent).toMatch(/falha simulada/);
    await click(/Tentar de novo/); expect(text()).toMatch(/Nenhuma exceção aguardando/);
  });
  it("aprovar: abre diálogo, envia justificativa e NÃO afirma execução", async () => {
    let state = [exc()];
    routes = [
      [/exception-queue-decide/, () => { state = []; return ok({ exception: { id: "7", status: "aprovada", approvals: 1, approvalsRequired: 1 } }); }],
      [/exception-queue/, () => ok({ exceptions: state })],
    ];
    await mount(React.createElement(AgentExceptionsPanel, { organizationId: 1, canDecide: true }));
    expect(text()).toMatch(/Revisão de uma pessoa/); expect(text()).toMatch(/valor/);
    await click(/^Aprovar/);
    expect(document.body.querySelector('[role="dialog"]')).toBeTruthy(); expect(text()).toMatch(/nada é executado agora/);
    await type(document.getElementById("excecao-justificativa") as HTMLTextAreaElement, "conferido");
    await click(/Confirmar aprovação/);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ organizationId: 1, exceptionId: "7", decision: "aprovar", notes: "conferido" });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull(); expect(text()).toMatch(/Nenhuma exceção aguardando/);
  });
  it("rejeitar usa a decisão 'rejeitar' e botão destrutivo; cancelar não envia nada", async () => {
    routes = [[/exception-queue/, () => ok({ exceptions: [exc()] })]];
    await mount(React.createElement(AgentExceptionsPanel, { organizationId: 1, canDecide: true }));
    await click(/^Rejeitar/); expect(text()).toMatch(/Rejeitar esta exceção/); await click(/Cancelar/);
    expect(calls.some((c) => c.method === "POST")).toBe(false); expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
  it("conflito do servidor fica no diálogo e recarrega a lista", async () => {
    routes = [[/exception-queue-decide/, () => err(409, "Exceção já decidida")], [/exception-queue/, () => ok({ exceptions: [exc()] })]];
    await mount(React.createElement(AgentExceptionsPanel, { organizationId: 1, canDecide: true }));
    await click(/^Aprovar/); const before = calls.length; await click(/Confirmar aprovação/);
    expect(text()).toMatch(/Exceção já decidida/); expect(document.body.querySelector('[role="dialog"]')).toBeTruthy(); expect(calls.length).toBeGreaterThan(before + 1);
  });
  it("dupla autorização: mostra progresso; quem já decidiu não vê botões; histórico aparece", async () => {
    routes = [[/exception-queue/, () => ok({ exceptions: [exc({ approvalsRequired: 2, approvals: 1, myDecision: "aprovar", decisions: [{ decision: "aprovar", decidedAt: "2026-11-01T13:00:00.000Z", notes: "ok", byYou: true, userDisplayName: "Eu" }] })] })]];
    await mount(React.createElement(AgentExceptionsPanel, { organizationId: 1, canDecide: true }));
    expect(text()).toMatch(/Dupla autorização/); expect(text()).toMatch(/Aprovações: 1 de 2/); expect(text()).toMatch(/Você já aprovou/); expect(btn(/^Aprovar/)).toBeUndefined(); expect(text()).toMatch(/Você aprovou em/);
  });
  it("somente leitura: sem botões de decisão", async () => {
    routes = [[/exception-queue/, () => ok({ exceptions: [exc()] })]];
    await mount(React.createElement(AgentExceptionsPanel, { organizationId: 1, canDecide: false }));
    expect(btn(/^Aprovar/)).toBeUndefined(); expect(text()).toMatch(/Somente leitura/);
  });
});

describe("AgentAlertsPanel", () => {
  const alert = (o: Record<string, unknown> = {}) => ({ id: "3", agentName: "agente_teste", level: "alerta", category: "estoque", title: "Saldo divergente", status: "aberto", entityType: null, entityId: null, createdAt: "2026-11-01T12:00:00.000Z", acknowledgedAt: null, resolvedAt: null, resolutionNote: null, ...o });
  it("lista, reconhece e resolve com nota", async () => {
    routes = [[/integrity-alerts-update/, () => ok({ alert: alert({ status: "reconhecido" }) })], [/integrity-alerts/, () => ok({ alerts: [alert()] })]];
    await mount(React.createElement(AgentAlertsPanel, { organizationId: 1, canManage: true }));
    expect(text()).toMatch(/Saldo divergente/); expect(text()).toMatch(/não é uma acusação/);
    await click(/Reconhecer/); await click(/^Reconhecer$/);
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ organizationId: 1, alertId: "3", action: "reconhecer", note: undefined });
    await click(/^Resolver/); await type(document.getElementById("alerta-nota") as HTMLTextAreaElement, "tratado"); await click(/Marcar como resolvido/);
    expect((calls.filter((c) => c.method === "POST")[1].body as { action: string; note: string })).toMatchObject({ action: "resolver", note: "tratado" });
  });
  it("vazio e filtro de resolvidos", async () => {
    routes = [[/integrity-alerts/, () => ok({ alerts: [] })]];
    await mount(React.createElement(AgentAlertsPanel, { organizationId: 1, canManage: true }));
    expect(text()).toMatch(/Nenhum alerta em aberto/); await click(/Resolvidos/); await act(async () => { await tick(120); }); expect(calls.at(-1)!.url).toMatch(/status=resolvido/); expect(text()).toMatch(/Nenhum alerta resolvido/);
  });
  it("somente leitura não mostra ações", async () => {
    routes = [[/integrity-alerts/, () => ok({ alerts: [alert()] })]];
    await mount(React.createElement(AgentAlertsPanel, { organizationId: 1, canManage: false }));
    expect(btn(/Resolver/)).toBeUndefined();
  });
});

describe("AutomationControlsPanel", () => {
  const ctl = (o: Record<string, unknown> = {}) => ({ global: { paused: false, emergency: false, reason: null }, organization: { paused: false, emergency: false, reason: null }, paused: false, emergency: false, ...o });
  it("pausar exige diálogo e envia paused=true sem emergency", async () => {
    routes = [[/automation-controls/, (c) => (c.method === "POST" ? ok({ ok: true }) : ok(ctl()))]];
    await mount(React.createElement(AutomationControlsPanel, { scope: "organizacao", organizationId: 1, canManage: true }));
    expect(text()).toMatch(/Funcionando normalmente/); await click(/^Pausar…/); expect(text()).toMatch(/Pausar a automação\?/);
    await click(/Confirmar pausa`?/);
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ organizationId: 1, paused: true, emergency: false });
  });
  it("emergência exige marcar ciência antes de habilitar o botão", async () => {
    routes = [[/automation-controls/, () => ok(ctl())]];
    await mount(React.createElement(AutomationControlsPanel, { scope: "organizacao", organizationId: 1, canManage: true }));
    await click(/Modo emergência…/); expect(btn(/Ligar emergência/)!.disabled).toBe(true);
    await act(async () => { (document.body.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); await tick(20); });
    expect(btn(/Ligar emergência/)!.disabled).toBe(false);
  });
  it("pausa global avisa que vale independentemente da organização", async () => {
    routes = [[/automation-controls/, () => ok(ctl({ global: { paused: true, emergency: false, reason: "manutenção" }, paused: true }))]];
    await mount(React.createElement(AutomationControlsPanel, { scope: "organizacao", organizationId: 1, canManage: true }));
    expect(text()).toMatch(/A plataforma está pausada/); expect(text()).toMatch(/manutenção/);
  });
  it("escopo plataforma chama a rota da plataforma; 403 mostra erro", async () => {
    routes = [[/platform-automation-controls/, () => err(403, "Acesso restrito à administração da plataforma")]];
    await mount(React.createElement(AutomationControlsPanel, { scope: "plataforma", canManage: true }));
    expect(calls[0].url).toMatch(/platform-automation-controls/); expect(document.body.querySelector('[role="alert"]')!.textContent).toMatch(/restrito/);
  });
  it("somente leitura", async () => {
    routes = [[/automation-controls/, () => ok(ctl())]];
    await mount(React.createElement(AutomationControlsPanel, { scope: "organizacao", organizationId: 1, canManage: false }));
    expect(btn(/Pausar/)).toBeUndefined(); expect(text()).toMatch(/Somente leitura/);
  });
});

describe("PolicyLimitsPanel", () => {
  const limits = { limits: [
    { key: "AUTO_ACCEPT_MAX_VALUE", kind: "number", defaultValue: 500, globalValue: 500, organizationValue: null, effectiveValue: 500 },
    { key: "HIGH_RISK_CATEGORIES", kind: "list", defaultValue: ["a"], globalValue: ["a"], organizationValue: null, effectiveValue: ["a"] },
  ] };
  it("recusa valor mais frouxo no cliente (sem chamar o servidor) e aceita mais restritivo", async () => {
    routes = [[/policy-limits/, (c) => (c.method === "POST" ? ok({ ok: true }) : ok(limits))]];
    await mount(React.createElement(PolicyLimitsPanel, { organizationId: 1, canManage: true }));
    expect(text()).toMatch(/Valor máximo de aceite automático/);
    await click(/Editar o limite: Valor máximo/);
    const input = document.getElementById("limite-valor") as HTMLInputElement;
    await type(input, "900"); expect(text()).toMatch(/mais restritivo/); expect(btn(/Salvar limite/)!.disabled).toBe(true);
    await type(input, "300"); expect(btn(/Salvar limite/)!.disabled).toBe(false);
    await click(/Salvar limite/);
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ organizationId: 1, key: "AUTO_ACCEPT_MAX_VALUE", value: 300 });
  });
  it("lista: não permite remover categoria global", async () => {
    routes = [[/policy-limits/, () => ok(limits)]];
    await mount(React.createElement(PolicyLimitsPanel, { organizationId: 1, canManage: true }));
    await click(/Editar o limite: Categorias de alto risco/); await type(document.getElementById("limite-valor") as HTMLTextAreaElement, "b");
    expect(text()).toMatch(/ACRESCENTAR/); expect(btn(/Salvar limite/)!.disabled).toBe(true);
  });
  it("somente leitura não mostra Editar", async () => {
    routes = [[/policy-limits/, () => ok(limits)]];
    await mount(React.createElement(PolicyLimitsPanel, { organizationId: 1, canManage: false }));
    expect(btn(/Editar o limite/)).toBeUndefined();
  });
});

describe("AgentOverviewPanel", () => {
  const agent = (o: Record<string, unknown> = {}) => ({ name: "agente_teste", label: "Agente de teste", purpose: "Finalidade de teste", version: "1", scope: "global", registered: true, enabled: true, tools: [{ name: "create_integrity_alert", klass: "alerta" }], openAlerts: 0, pendingExceptions: 0, lastActionAt: null, ...o });
  const data = (agents: unknown[], over: Record<string, unknown> = {}) => ({ agents, summary: { total: agents.length, registered: agents.length, enabled: agents.length, disabled: 0, withOpenAlerts: 0, withPendingExceptions: 0 }, automation: { paused: false, emergency: false }, eventConsumers: [], ...over });
  it("carregando mostra esqueleto ocupado; depois lista e detalhe sem prometer poderes a mais", async () => {
    let release!: (r: Response) => void; routes = [[/agents/, () => new Promise<Response>((r) => { release = r; })]];
    const qc = new QueryClient(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(React.createElement(QueryClientProvider, { client: qc }, React.createElement(AgentOverviewPanel, { organizationId: 1 }))); await tick(20); });
    expect(host.querySelector("section")!.getAttribute("aria-busy")).toBe("true");
    await act(async () => { release(ok(data([agent()]))); await tick(80); });
    expect(text()).toMatch(/Agente de teste/); expect(text()).toMatch(/Nenhuma pendência dos agentes/); expect(text()).toMatch(/Nenhum deles executa ação real/);
    await click(/Detalhes do agente/); expect(text()).toMatch(/O que este agente pode fazer/); expect(text()).toMatch(/Nenhuma ferramenta altera estoque/);
  });
  it("atenção e filtro/busca; navegação para exceções", async () => {
    const onOpen = vi.fn();
    routes = [[/agents/, () => ok(data([agent({ pendingExceptions: 2 }), agent({ name: "outro", label: "Outro agente", purpose: "x" })], { summary: { total: 2, registered: 2, enabled: 2, disabled: 0, withOpenAlerts: 0, withPendingExceptions: 1 } }))]];
    await mount(React.createElement(AgentOverviewPanel, { organizationId: 1, onOpenTab: onOpen }));
    expect(text()).toMatch(/1 agente com exceção aguardando decisão/); expect(text()).toMatch(/Precisa de atenção/);
    await click(/Precisam de atenção/); expect(text()).not.toMatch(/Outro agente/);
    await click(/Ver exceções/); expect(onOpen).toHaveBeenCalledWith("excecoes");
  });
  it("busca sem resultado e erro com nova tentativa", async () => {
    routes = [[/agents/, () => ok(data([agent()]))]];
    await mount(React.createElement(AgentOverviewPanel, { organizationId: 1 }));
    await type(document.getElementById("agentes-busca") as HTMLInputElement, "zzz"); expect(text()).toMatch(/Nenhum agente corresponde/);
  });
  it("erro 403", async () => {
    routes = [[/agents/, () => err(403, "Sem permissão")]];
    await mount(React.createElement(AgentOverviewPanel, { organizationId: 1 }));
    expect(document.body.querySelector('[role="alert"]')!.textContent).toMatch(/Sem permissão/); expect(btn(/Tentar de novo/)).toBeTruthy();
  });
});
