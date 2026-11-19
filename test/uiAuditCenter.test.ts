// @vitest-environment jsdom
/**
 * M38 — componentes REAIS da Central de Auditoria (react-query real, fetch simulado no formato do servidor): vocabulário de estados da verificação (nunca "garantido"), lista/filtros/paginação,
 * resumo com "indisponível" no lugar de zero, rastreabilidade com decisão histórica × dados atuais e o painel de integridade em todos os estados. A autoridade continua no servidor.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import superjson from "superjson";
import { AuditCenterPanel, EMPTY_FILTERS } from "../src/components/AuditCenterPanel";
import { AuditTracePanel } from "../src/components/AuditTracePanel";
import { AuditIntegrityPanel } from "../src/components/AuditIntegrityPanel";
import { AuditReceiptsPanel } from "../src/components/AuditReceiptsPanel";
import { actionLabel, COVERAGE_LIMITS, dayEndExclusiveIso, dayStartIso, entityLink, formatCount, traceLink, verificationState } from "../src/components/auditCenterView";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
let host: HTMLDivElement | null = null; let root: Root | null = null;
type Call = { url: string; method: string; body: unknown };
let calls: Call[] = []; let routes: Array<[RegExp, (c: Call) => Response | Promise<Response>]> = [];
const ok = (o: unknown, status = 200) => new Response(superjson.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const fail = (status: number, body: Record<string, unknown>) => new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => { calls = []; routes = []; vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { const c: Call = { url: String(url), method: init?.method ?? "GET", body: init?.body ? superjson.parse(String(init.body)) : undefined }; calls.push(c); const r = routes.find(([re]) => re.test(c.url)); if (!r) { if (/audit-chain-receipts/.test(c.url)) return ok({ canManage: false, receipts: [], independentAnchorConfigured: false }); throw new Error(`rota não simulada: ${c.url}`); } return r[1](c); })); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); document.body.innerHTML = ""; host = null; root = null; vi.unstubAllGlobals(); });
async function mount(el: React.ReactElement) { const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); await act(async () => { root!.render(React.createElement(QueryClientProvider, { client: qc }, el)); await tick(20); }); await act(async () => { await tick(450); }); }
const text = () => document.body.textContent ?? "";
const btn = (re: RegExp) => [...document.body.querySelectorAll("button")].find((b) => re.test((b.textContent ?? "").trim()) || re.test(b.getAttribute("aria-label") ?? "")) as HTMLButtonElement | undefined;
async function click(re: RegExp) { const b = btn(re); expect(b, `botão ${re}`).toBeTruthy(); await act(async () => { b!.click(); await tick(20); }); await act(async () => { await tick(300); }); }

const entry = (id: number, extra: Record<string, unknown> = {}) => ({ id: String(id), action: "oportunidade.categoria_alterada", entityType: "donation_opportunity", entityId: "7", actorType: "user", actorUserId: 1, actorName: "Ana Admin", createdAt: "2026-11-09T12:00:00.000Z", outcome: "concluida", correlationId: "11111111-1111-4111-8111-111111111111", operationId: null, recordVersion: 2, chained: true, ...extra });
const summary = (automation: unknown) => ({ period: { from: null, to: null }, operations: { count: 12, capped: false }, byOutcome: { concluida: { count: 8, capped: false }, recusada: { count: 1, capped: false }, falhou: { count: 1, capped: false }, pendente: { count: 1, capped: false }, naoRegistrado: { count: 1, capped: false } }, history: { count: 12, capped: false }, automation });
const auto = { agentDecisions: { total: 4, byStatus: { simulacao_concluida: 3 } }, exceptionsCreated: 2, exceptionsResolved: 1, reevaluations: { total: 1, byOutcome: { concluida: 1 } } };

describe("vocabulário e regras de apresentação", () => {
  it("estados da verificação em palavras; ausência de verificação nunca vira aprovação; 'íntegra' traz seus limites", () => {
    expect(verificationState(null)).toMatchObject({ label: "Ainda não verificado", tone: "muted" });
    expect(verificationState(null).message).toMatch(/não significa que a trilha esteja íntegra/);
    const base = { unhashedEvents: 0, divergenceCount: 0, verifiedEvents: 10, totalEvents: 10, coveredUpToEventId: "10" };
    const ok1 = verificationState({ ...base, status: "integra" }); expect(ok1.label).toBe("Consistência interna confirmada no escopo"); expect(ok1.message).toMatch(/NÃO prova/); expect(ok1.message).toMatch(/garantia A/); expect(ok1.message).not.toMatch(/garantid/i);
    expect(verificationState({ ...base, status: "integra", unhashedEvents: 3 }).message).toMatch(/3 evento\(s\) anteriores ao encadeamento/);
    expect(verificationState({ ...base, status: "inconsistencia", divergenceCount: 2 })).toMatchObject({ label: "Inconsistência encontrada", tone: "attention", requiresInvestigation: true });
    expect(verificationState({ ...base, status: "incompleta" }).label).toBe("Verificação incompleta");
    expect(verificationState({ ...base, status: "falha_tecnica" }).message).toMatch(/NÃO é um resultado de integridade/);
    expect(verificationState({ ...base, status: "em_andamento" }).label).toBe("Verificação em andamento");
    expect(COVERAGE_LIMITS.join(" ")).toMatch(/âncora independente/);
  });
  it("links só para entidades que têm página; nenhum link inventado; datas e contagens", () => {
    expect(entityLink(3, "donation_opportunity", "7")).toEqual({ href: "/organizacoes/3/oportunidades?destaque=7", label: "Abrir a oportunidade" });
    expect(entityLink(3, "agent_event_run", "9")!.href).toBe("/organizacoes/3/automacao?run=9"); expect(entityLink(3, "usuario", "1")).toBeNull(); expect(entityLink(3, "exception", null)).toBeNull();
    expect(traceLink(3, "exception", "4")).toBe("/organizacoes/3/auditoria?aba=rastreabilidade&excecao=4"); expect(traceLink(3, "stock_transaction", "1")).toBeNull();
    expect(actionLabel("oportunidade.categoria_alterada")).toBe("Categoria da oportunidade alterada"); expect(actionLabel("x.desconhecida")).toBe("x.desconhecida"); expect(actionLabel("agente.evento_simulacao_concluida")).toMatch(/simulacao concluida/);
    expect(dayStartIso("2026-11-09")).toBeDefined(); expect(dayStartIso("09/11/2026")).toBeUndefined();
    expect(new Date(dayEndExclusiveIso("2026-11-09")!).getTime() - new Date(dayStartIso("2026-11-09")!).getTime()).toBeGreaterThanOrEqual(23 * 3600_000); // o dia final entra por inteiro
    expect(formatCount({ count: 10000, capped: true })).toMatch(/ou mais/); expect(formatCount({ count: 3, capped: false })).toBe("3");
  });
});

describe("AuditCenterPanel", () => {
  const props = (over: Record<string, unknown> = {}) => ({ organizationId: 1, filters: { ...EMPTY_FILTERS }, onFiltersChange: vi.fn(), onOpenTrace: vi.fn(), canSeeAutomation: true, onEntryChange: vi.fn(), ...over });

  it("resumo: período separado do histórico e 'indisponível' (traço) no lugar de zero quando o papel não lê a automação; lista com natureza em texto e correlação", async () => {
    routes = [[/audit-center-summary/, () => ok(summary(null))], [/audit-center\?/, () => ok({ entries: [entry(5), entry(3, { action: "legado.operacao", outcome: null, recordVersion: 1, correlationId: null, entityType: "teste", entityId: "3" }), entry(4, { action: "usuario.login_falhou", outcome: "falhou", correlationId: null, entityType: "usuario", entityId: "9" })], nextCursor: null, total: { count: 3, capped: false }, newerCount: null })]];
    await mount(React.createElement(AuditCenterPanel, props()));
        expect(text()).toMatch(/Operações registradas/); expect(text()).toMatch(/Histórico total/); expect(text()).toMatch(/Sem permissão de automação/);
    expect(document.querySelectorAll('[aria-label="indisponível para o seu papel"]').length).toBeGreaterThanOrEqual(4); // traço ≠ zero
    expect(text()).toMatch(/Categoria da oportunidade alterada/); expect(text()).toMatch(/Falhou/); expect(text()).toMatch(/Resultado não registrado/); expect(text()).toMatch(/correlação 11111111…/); expect(text()).toMatch(/3 registros correspondem/); expect(text()).toMatch(/Fim dos registros/);
    expect(text()).toMatch(/nunca é deduzido do nome da ação/); expect(text()).toMatch(/Concluídas/); expect(text()).toMatch(/Pendentes/); // resultado explícito; "não registrado" não é sucesso
    expect(text()).not.toMatch(/pelo nome da ação/i);
  });

  it("paginação por cursor: 'Carregar mais antigos' envia o cursor do servidor; vazio e erro recuperável são distintos", async () => {
    let page = 0;
    routes = [[/audit-center-summary/, () => ok(summary(auto))], [/audit-center\?/, (c) => { if (c.url.includes("sinceId")) return ok({ entries: [], nextCursor: null, total: { count: 0, capped: false }, newerCount: 2 }); page += 1; return page === 1 ? ok({ entries: [entry(9)], nextCursor: "9", total: { count: 12000, capped: true }, newerCount: null }) : ok({ entries: [entry(8)], nextCursor: null, total: { count: 12000, capped: true }, newerCount: null }); }]];
    await mount(React.createElement(AuditCenterPanel, props()));
    await act(async () => { await tick(500); }); // a contagem de novos é uma segunda consulta, feita depois que o topo da lista é conhecido
    expect(text()).toMatch(/12\.000 ou mais registros correspondem/); expect(text()).toMatch(/2 registros novos/); expect(text()).toMatch(/não muda de lugar/);
    await click(/Carregar mais antigos/);
    expect(calls.some((c) => c.url.includes("beforeId=9"))).toBe(true); expect(text()).toMatch(/registro #8/); expect(text()).toMatch(/registro #9/);
  });

  it("estado vazio com e sem filtros; erro do servidor mostra 'Tentar de novo' sem fingir lista vazia", async () => {
    routes = [[/audit-center-summary/, () => ok(summary(auto))], [/audit-center\?/, () => ok({ entries: [], nextCursor: null, total: { count: 0, capped: false }, newerCount: null })]];
    await mount(React.createElement(AuditCenterPanel, props()));
    expect(text()).toMatch(/Ainda não há registros de auditoria nesta organização/);
    act(() => root?.unmount()); host?.remove(); document.body.innerHTML = "";
    routes = [[/audit-center-summary/, () => ok(summary(auto))], [/audit-center\?/, () => fail(500, { message: "Falha ao carregar" })]];
    await mount(React.createElement(AuditCenterPanel, props({ filters: { ...EMPTY_FILTERS, resultado: "falhou", area: "agentes" } })));
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/Falha ao carregar/); expect(text()).not.toMatch(/Nenhum registro corresponde/); expect(btn(/Tentar de novo/)).toBeTruthy();
  });

  it("filtros: período invertido bloqueia o envio; o formulário envia os valores ao pai e os chips mostram o que está ativo", async () => {
    routes = [[/audit-center-summary/, () => ok(summary(auto))], [/audit-center\?/, (c) => ok({ entries: [], nextCursor: null, total: { count: 0, capped: false }, newerCount: null })]];
    const onFiltersChange = vi.fn();
    await mount(React.createElement(AuditCenterPanel, props({ onFiltersChange, filters: { ...EMPTY_FILTERS, area: "oportunidades", resultado: "falhou", from: "2026-11-01" } })));
    expect(text()).toMatch(/resultado: Falhou/); expect(text()).toMatch(/área: Oportunidades/); expect(text()).toMatch(/desde 2026-11-01/);
    expect(calls.filter((c) => /audit-center\?/.test(c.url)).some((c) => c.url.includes("area=oportunidades") && c.url.includes("resultado=falhou"))).toBe(true); // filtrado NO servidor
    await click(/Aplicar filtros/); expect(onFiltersChange).toHaveBeenCalledTimes(1);
    await click(/Limpar/); expect(onFiltersChange).toHaveBeenLastCalledWith(EMPTY_FILTERS);
  });
});

describe("AuditIntegrityPanel — todos os estados", () => {
  const v = (over: Record<string, unknown> = {}) => ({ id: "1", status: "integra", startedAt: "2026-11-09T12:00:00.000Z", finishedAt: "2026-11-09T12:00:01.000Z", requestedByName: null, coveredUpToEventId: "120", totalEvents: 120, verifiedEvents: 118, unhashedEvents: 2, divergenceCount: 0, divergences: null, divergencesInYourOrganization: 0, durationMs: 41, errorKind: null, ...over });
  const verifs = (list: unknown[], canRun = false) => ({ canRun, isPlatformAdmin: canRun, scope: "global_chain", verifications: list });

  it("nunca verificado: não aprova; organização sem permissão vê 'Escopo não autorizado' e nenhum botão de executar", async () => {
    routes = [[/audit-chain-verifications/, () => ok(verifs([]))]];
    await mount(React.createElement(AuditIntegrityPanel, { organizationId: 1 }));
    expect(text()).toMatch(/Ainda não verificado/); expect(text()).not.toMatch(/Consistência interna confirmada/); expect(text()).toMatch(/Escopo não autorizado para executar/); expect(btn(/Verificar a integridade agora/)).toBeUndefined();
    expect(text()).toMatch(/Nenhuma verificação foi registrada ainda/);
  });

  it("íntegra: mostra escopo, abrangência e a RESSALVA de eventos sem hash, sem prometer proteção absoluta", async () => {
    routes = [[/audit-chain-verifications/, () => ok(verifs([v()]))]];
    await mount(React.createElement(AuditIntegrityPanel, { organizationId: 1 }));
    expect(text()).toMatch(/Consistência interna confirmada no escopo/); expect(text()).toMatch(/Cadeia global/); expect(text()).toMatch(/todos até o registro #120/); expect(text()).toMatch(/2 evento\(s\) anteriores ao encadeamento/);
    expect(text()).toMatch(/O que esta verificação prova — e o que não prova/); expect(text()).not.toMatch(/Integridade garantida/i);
  });

  it("inconsistência: exige investigação, não oferece reparo; organização vê quantas divergências tocam a sua organização e nenhum id alheio; plataforma vê ids e motivos (sem hash)", async () => {
    routes = [[/audit-chain-verifications/, () => ok(verifs([v({ status: "inconsistencia", divergenceCount: 3, divergencesInYourOrganization: 1 })]))]];
    await mount(React.createElement(AuditIntegrityPanel, { organizationId: 1 }));
    expect(text()).toMatch(/Inconsistência encontrada/); expect(text()).toMatch(/Exige investigação/); expect(text()).toMatch(/Esta tela não oferece reparo automático/); expect(text()).toMatch(/1 em eventos da sua organização/);
    expect(text()).toMatch(/não são listados para as organizações/); expect(btn(/repar|corrigir|recalcul/i)).toBeUndefined();
    act(() => root?.unmount()); host?.remove(); document.body.innerHTML = "";
    routes = [[/audit-chain-verifications/, () => ok(verifs([v({ status: "inconsistencia", divergenceCount: 1, divergences: [{ id: "57", reason: "hash_nao_bate" }] })], true))]];
    await mount(React.createElement(AuditIntegrityPanel, { organizationId: 1, onOpenEntry: vi.fn() }));
    expect(text()).toMatch(/Registro #57/); expect(text()).toMatch(/não corresponde ao hash gravado/); expect(text()).not.toMatch(/[0-9a-f]{64}/);
  });

  it("falha técnica e incompleta não são resultado de integridade; erro ao consultar também não", async () => {
    routes = [[/audit-chain-verifications/, () => ok(verifs([v({ status: "falha_tecnica", totalEvents: null, verifiedEvents: null, unhashedEvents: null, divergenceCount: null, coveredUpToEventId: null })]))]];
    await mount(React.createElement(AuditIntegrityPanel, { organizationId: 1 }));
    expect(text()).toMatch(/Falha técnica na verificação/); expect(text()).toMatch(/NÃO é um resultado de integridade/); expect(text()).not.toMatch(/Consistência interna confirmada/);
    act(() => root?.unmount()); host?.remove(); document.body.innerHTML = "";
    routes = [[/audit-chain-verifications/, () => fail(500, { message: "indisponível" })]];
    await mount(React.createElement(AuditIntegrityPanel, { organizationId: 1 }));
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/Isto não é um resultado de integridade/); expect(btn(/Tentar de novo/)).toBeTruthy();
  });

  it("plataforma: confirma antes de executar (diz que só lê), dispara o POST, e trata 'já em andamento'", async () => {
    let posts = 0;
    routes = [[/audit-chain-verify/, (c) => { posts += 1; return posts === 1 ? ok({ id: "9", startedAt: "2026-11-09T12:00:00.000Z", status: "em_andamento" }, 202) : fail(409, { message: "Já existe", code: "verificacao_em_andamento" }); }], [/audit-chain-verifications/, () => ok(verifs([v()], true))]];
    await mount(React.createElement(AuditIntegrityPanel, { organizationId: 1 }));
    await click(/Verificar a integridade agora/);
    expect(text()).toMatch(/não altera, repara nem apaga registros/); expect(text()).toMatch(/só uma pode rodar por vez/);
    await click(/Iniciar verificação/);
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ scope: "global_chain" });
    await click(/Verificar a integridade agora/); await click(/Iniciar verificação/);
    expect(text()).toMatch(/Já existe uma verificação em andamento/);
  });

  it("em andamento: estado visível em palavras e botão bloqueado", async () => {
    routes = [[/audit-chain-verifications/, () => ok(verifs([v({ status: "em_andamento", finishedAt: null, totalEvents: null, verifiedEvents: null, unhashedEvents: null, divergenceCount: null, coveredUpToEventId: null })], true))]];
    await mount(React.createElement(AuditIntegrityPanel, { organizationId: 1 }));
    expect(text()).toMatch(/Verificação em andamento/); expect(btn(/Verificação em andamento…/)!.disabled).toBe(true);
  });
});

describe("AuditTracePanel", () => {
  const trace = (over: Record<string, unknown> = {}) => ({
    subject: { kind: "oportunidade", id: "7" }, opportunity: { id: 7, title: "Oferta sintética", status: "registrada", currentCategory: "Calçado", version: 2 },
    steps: [
      { key: "oportunidade", at: "2026-11-09T10:00:00.000Z", title: "Oportunidade registrada: Oferta sintética", detail: null, actor: null, ref: null, correlationId: null, auditEntryId: null, linkKind: null },
      { key: "alteracao_categoria", at: "2026-11-09T11:00:00.000Z", title: "Categoria alterada por Ana: Roupa → Calçado (versão 2)", detail: null, actor: "Ana", ref: null, correlationId: "22222222-2222-4222-8222-222222222222", auditEntryId: "31", linkKind: "direta" },
    ],
    decisions: [{ runId: "5", agentName: "risk-engine", status: "simulacao_concluida", decision: "permitido", reason: null, ruleCode: null, evaluatedAt: "2026-11-09T10:30:00.000Z", evaluationCount: 1, policy: { rules: [{ code: "R-X", title: "Regra X", result: "violada", reason: "motivo X" }], limits: { autoAcceptValue: 1000 } }, categoryConsidered: "Roupa", categoryOrigin: "evento original", versionConsidered: null, currentCategory: "Calçado", currentVersion: 2, categoryDiffers: true, laterChanges: [{ id: "1", at: "2026-11-09T11:00:00.000Z", byName: "Ana", previousValue: "Roupa", newValue: "Calçado", versionAfter: 2, correlationId: "22222222-2222-4222-8222-222222222222", auditEntryId: "31" }], recalculated: false }],
    journey: { correlationId: null }, auditEntries: [{ ...entry(31), link: "direta" }], limits: ["A decisão histórica não é recalculada nem anulada por esta tela."], ...over,
  });

  it("decisão histórica × categoria atual lado a lado, com o aviso de que NÃO foi recalculada, a alteração posterior e o link para a auditoria", async () => {
    routes = [[/audit-trace/, () => ok(trace())]];
    const onOpenEntry = vi.fn(); const onNavigate = vi.fn();
    await mount(React.createElement(AuditTracePanel, { organizationId: 1, start: { kind: "oportunidade", id: "7" }, onStartChange: vi.fn(), onOpenEntry, onNavigate }));
    expect(text()).toMatch(/Decisões históricas × dados atuais/); expect(text()).toMatch(/Categoria considerada na avaliação/); expect(text()).toMatch(/Roupa/); expect(text()).toMatch(/Categoria atual da oportunidade/); expect(text()).toMatch(/Calçado/);
    expect(text()).toMatch(/A categoria mudou depois desta avaliação/); expect(text()).toMatch(/não foi recalculada/); expect(text()).toMatch(/Simulação/); expect(text()).toMatch(/versão do registro: não registrada nesta avaliação/);
    expect(text()).toMatch(/Sem vínculo verificável com um registro de auditoria/); // o passo da oportunidade não tem vínculo e isso é dito
    await click(/Ver o registro de auditoria #31/); expect(onOpenEntry).toHaveBeenCalledWith("31");
    await click(/Ver auditoria #31/); expect(onOpenEntry).toHaveBeenCalledTimes(2);
    await click(/Abrir a justificativa completa/); expect(onNavigate).toHaveBeenCalledWith("/organizacoes/1/automacao?run=5");
  });

  it("sem ponto de partida orienta; entrada inválida bloqueia; 404 do servidor vira mensagem sem vazar nada", async () => {
    routes = [[/audit-trace/, () => fail(404, { message: "Nada encontrado nesta organização para o ponto de partida informado" })]];
    await mount(React.createElement(AuditTracePanel, { organizationId: 1, start: null, onStartChange: vi.fn(), onOpenEntry: vi.fn(), onNavigate: vi.fn() }));
    expect(text()).toMatch(/Escolha um ponto de partida/); expect(btn(/Rastrear/)!.disabled).toBe(true);
    act(() => root?.unmount()); host?.remove(); document.body.innerHTML = "";
    await mount(React.createElement(AuditTracePanel, { organizationId: 1, start: { kind: "execucao", id: "999" }, onStartChange: vi.fn(), onOpenEntry: vi.fn(), onNavigate: vi.fn() }));
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/Nada encontrado nesta organização/);
  });
});

describe("M39 — comprovantes, resultado explícito e vínculos", () => {
  const receipt = (over: Record<string, unknown> = {}) => ({ id: "3", capturedAt: "2026-11-09T12:00:00.000Z", lastEventId: "120", eventCount: "118", verificationId: "4", createdByName: null, headHash: null, receiptDigest: null, canonical: null, lastComparison: null, ...over });
  const list = (receipts: unknown[], canManage = false) => ({ canManage, receipts, independentAnchorConfigured: false });
  const okVerif = { canRun: true, isPlatformAdmin: true, scope: "global_chain", verifications: [{ id: "4", status: "integra", startedAt: "2026-11-09T12:00:00.000Z", finishedAt: "2026-11-09T12:00:01.000Z", requestedByName: "Plataforma", coveredUpToEventId: "120", totalEvents: 118, verifiedEvents: 118, unhashedEvents: 0, divergenceCount: 0, divergences: [], divergencesInYourOrganization: null, durationMs: 9, errorKind: null }] };

  it("sem comprovante: diz o que isso significa (a verificação interna não vê a remoção do fim) e SEMPRE informa 'referência independente não configurada' com o modelo de confiança", async () => {
    routes = [[/audit-chain-receipts/, () => ok(list([]))], [/audit-chain-verifications/, () => ok({ ...okVerif, canRun: false, verifications: [] })]];
    await mount(React.createElement(AuditReceiptsPanel, { organizationId: 1 }));
    expect(text()).toMatch(/Referência independente não configurada/); expect(text()).toMatch(/NÃO é uma âncora independente/); expect(text()).toMatch(/forjar um comprovante coerente/);
    expect(text()).toMatch(/Nenhum comprovante foi gerado ainda/); expect(text()).toMatch(/não consegue perceber a remoção dos últimos registros/);
    expect(text()).toMatch(/Escopo não autorizado para gerar ou comparar/); expect(btn(/Gerar comprovante/)).toBeUndefined();
  });

  it("organização vê existência, data e estado — sem digest nem hash; 'confere' vem com a ressalva de independência", async () => {
    routes = [[/audit-chain-receipts/, () => ok(list([receipt({ lastComparison: { status: "conferido", reason: null, comparedAt: "2026-11-09T13:00:00.000Z", eventsSinceReceipt: 7 } })]))], [/audit-chain-verifications/, () => ok({ ...okVerif, canRun: false })]];
    await mount(React.createElement(AuditReceiptsPanel, { organizationId: 1 }));
    expect(text()).toMatch(/Comprovante anterior disponível/); expect(text()).toMatch(/Comprovante comparado: confere/); expect(text()).toMatch(/até o registro #120 \(118 registros\)/); expect(text()).toMatch(/7 registro\(s\) novo\(s\) desde então/);
    expect(text()).toMatch(/vale tanto quanto a independência de quem guardou/); expect(text()).not.toMatch(/Digest do comprovante/); expect(text()).not.toMatch(/[0-9a-f]{64}/);
  });

  it("divergência: mostra o motivo em palavras, exige investigação e não oferece reparo; a equipe da plataforma vê o digest", async () => {
    const digest = "a".repeat(64);
    routes = [[/audit-chain-receipts/, () => ok(list([receipt({ headHash: "b".repeat(64), receiptDigest: digest, lastComparison: { status: "divergencia", reason: "registro_final_ausente", comparedAt: "2026-11-09T13:00:00.000Z", eventsSinceReceipt: null } })], true))], [/audit-chain-verifications/, () => ok(okVerif)]];
    await mount(React.createElement(AuditReceiptsPanel, { organizationId: 1 }));
    expect(text()).toMatch(/Divergência encontrada/); expect(text()).toMatch(/registros finais foram removidos/); expect(text()).toMatch(/Exige investigação/); expect(text()).toMatch(/Nada foi alterado nem reparado/);
    expect(text()).toContain(digest); expect(btn(/repar|corrigir|recalcul/i)).toBeUndefined();
  });

  it("plataforma: só gera depois de verificação ÍNTEGRA; comparar envia o texto, mostra o resultado e trata erro recuperável", async () => {
    let posts = 0;
    routes = [[/audit-chain-receipt-compare/, () => { posts += 1; return posts === 1 ? fail(500, { message: "Falha simulada" }) : ok({ id: "9", status: "malformado", reason: "digest_invalido", receiptId: null, comparedUpToEventId: null, eventsSinceReceipt: null }); }], [/audit-chain-receipts/, () => ok(list([], true))], [/audit-chain-verifications/, () => ok(okVerif)]];
    await mount(React.createElement(AuditReceiptsPanel, { organizationId: 1 }));
    expect(btn(/Gerar comprovante/)!.disabled).toBe(false);
    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, '{"x":1}'); ta.dispatchEvent(new Event("input", { bubbles: true })); await tick(30); });
    await click(/Comparar com o estado atual/);
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/Falha simulada/); // erro recuperável: o texto continua no campo
    expect(ta.value).toBe('{"x":1}');
    await click(/Comparar com o estado atual/);
    expect(calls.filter((c) => c.method === "POST").at(-1)!.body).toEqual({ receipt: '{"x":1}' });
    expect(text()).toMatch(/Comprovante malformado/); expect(text()).toMatch(/foi alterado depois de gerado/); expect(text()).not.toMatch(/Comprovante comparado: confere/);
  });

  it("gerar fica DESABILITADO quando a última verificação não foi íntegra", async () => {
    routes = [[/audit-chain-receipts/, () => ok(list([], true))], [/audit-chain-verifications/, () => ok({ ...okVerif, verifications: [{ ...okVerif.verifications[0], status: "inconsistencia", divergenceCount: 1 }] })]];
    await mount(React.createElement(AuditReceiptsPanel, { organizationId: 1 }));
    expect(btn(/Gerar comprovante/)!.disabled).toBe(true); expect(text()).toMatch(/só é gerado depois de uma verificação interna que confirmou a consistência/);
  });

  it("rastreabilidade: o tipo de vínculo é dito em palavras (direto, por correlação, sem vínculo verificável) e a ordem do tempo não é apresentada como causalidade", async () => {
    const tr = { subject: { kind: "oportunidade", id: "7" }, opportunity: null, decisions: [], limits: [], journey: { correlationId: "22222222-2222-4222-8222-222222222222" },
      steps: [
        { key: "oportunidade", at: "2026-11-09T10:00:00.000Z", title: "Oportunidade registrada", detail: null, actor: null, ref: null, correlationId: null, auditEntryId: null, linkKind: null },
        { key: "excecao", at: "2026-11-09T10:01:00.000Z", title: "Exceção #5 criada", detail: null, actor: null, ref: null, correlationId: null, auditEntryId: "31", linkKind: "direta" },
        { key: "transicao", at: "2026-11-09T10:02:00.000Z", title: "Execução #2", detail: null, actor: "risk-engine", ref: null, correlationId: null, auditEntryId: "32", linkKind: "correlacao" },
      ],
      auditEntries: [{ ...entry(31), link: "direta" }, { ...entry(32, { outcome: null, recordVersion: 1 }), link: "correlacao" }] };
    routes = [[/audit-trace/, () => ok(tr)]];
    await mount(React.createElement(AuditTracePanel, { organizationId: 1, start: { kind: "oportunidade", id: "7" }, onStartChange: vi.fn(), onOpenEntry: vi.fn(), onNavigate: vi.fn() }));
    expect(text()).toMatch(/Correlação persistida da jornada: 22222222-2222-4222-8222-222222222222/); expect(text()).toMatch(/não prova/); expect(text()).toMatch(/causou o seguinte/);
    expect(text()).toMatch(/Registro diretamente associado/); expect(text()).toMatch(/Registro relacionado por correlação persistida/); expect(text()).toMatch(/Sem vínculo verificável com um registro de auditoria/);
    expect(text()).toMatch(/Associado diretamente \(mesma entidade\)/); expect(text()).toMatch(/Resultado não registrado/); expect(text()).toMatch(/Concluída/);
    act(() => root?.unmount()); host?.remove(); document.body.innerHTML = "";
    routes = [[/audit-trace/, () => ok({ ...tr, journey: { correlationId: null }, steps: [tr.steps[0]], auditEntries: [] })]];
    await mount(React.createElement(AuditTracePanel, { organizationId: 1, start: { kind: "oportunidade", id: "7" }, onStartChange: vi.fn(), onOpenEntry: vi.fn(), onNavigate: vi.fn() }));
    expect(text()).toMatch(/não tem correlação persistida/); expect(text()).toMatch(/nenhuma correlação foi fabricada/);
  });

  it("vocabulário: resultado explícito x desconhecido nunca se confundem; as três garantias estão descritas e a C aparece como não configurada", async () => {
    const v = await import("../src/components/auditCenterView");
    expect(v.outcomeLabel(null)).toBe("Resultado não registrado"); expect(v.outcomeLabel("concluida")).toBe("Concluída"); expect(v.outcomeBadge(null)).toBe("outline"); expect(v.outcomeBadge("falhou")).toBe("destructive");
    expect(v.THREE_GUARANTEES.map((g) => g.key)).toEqual(["A", "B", "C"]); expect(v.THREE_GUARANTEES[2].status).toBe("Referência independente não configurada");
    expect(v.OUTCOME_OPTIONS.map((o) => o.value)).toEqual(["concluida", "recusada", "falhou", "pendente", "nao_registrado"]);
    expect(Object.keys(v.RECEIPT_REASON_LABEL)).toEqual(expect.arrayContaining(["registro_final_ausente", "hash_do_registro_diferente", "quantidade_menor", "digest_invalido", "formato_nao_suportado", "algoritmo_nao_suportado", "outro_escopo"]));
    expect(v.DIVERGENCE_REASON_LABEL.hash_ausente_apos_inicio_da_cadeia).toMatch(/sem hash/);
  });
});
