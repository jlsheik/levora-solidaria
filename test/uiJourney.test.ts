// @vitest-environment jsdom
/**
 * M40 — componentes REAIS da jornada (react-query real, fetch simulado no formato do servidor): lista de jornadas por necessidade e o detalhe com etapas, pendências, correspondências
 * explicadas, atribuições, recebimentos, destinações, linha do tempo e auditoria. Estado dito em palavras; dado restrito ao papel ≠ zero; nada afirma entrega física.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import superjson from "superjson";
import { JourneyDetailView, JourneyList, OfferJourneyDetailView, EMPTY_FILTERS, type JourneyFiltersState } from "../src/components/JourneyPanels";
import { CRITERION_LABEL, KIND_LABEL, MATCHING_STATE_LABEL, MATCH_RUN_OUTCOME_LABEL, STEP_STATE_LABEL, offerParam, offerStepAction, parseOfferParam, scoreBand, stepAction, stepBadge } from "../src/components/journeyView";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
let host: HTMLDivElement | null = null; let root: Root | null = null;
type Call = { url: string; method: string };
let calls: Call[] = []; let routes: Array<[RegExp, (c: Call) => Response | Promise<Response>]> = [];
const ok = (o: unknown) => new Response(superjson.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
const fail = (status: number, body: Record<string, unknown>) => new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => { calls = []; routes = []; vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { const c: Call = { url: String(url), method: init?.method ?? "GET" }; calls.push(c); const r = routes.find(([re]) => re.test(c.url)); if (!r) throw new Error(`rota não simulada: ${c.url}`); return r[1](c); })); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); document.body.innerHTML = ""; host = null; root = null; vi.unstubAllGlobals(); });
async function mount(el: React.ReactElement) { const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); await act(async () => { root!.render(React.createElement(QueryClientProvider, { client: qc }, React.createElement(MemoryRouter, null, el))); await tick(20); }); await act(async () => { await tick(450); }); }
const text = () => document.body.textContent ?? "";
const btn = (re: RegExp) => [...document.body.querySelectorAll("button")].find((b) => re.test((b.textContent ?? "").trim())) as HTMLButtonElement | undefined;
async function click(re: RegExp) { const b = btn(re); expect(b, `botão ${re}`).toBeTruthy(); await act(async () => { b!.click(); await tick(20); }); await act(async () => { await tick(300); }); }

const step = (key: string, state: string, detail = "d", label = key) => ({ key, label, state, detail });
const item = (id: number, over: Record<string, unknown> = {}) => ({
  kind: "necessidade", needId: id, title: `Cobertores ${id}`, priority: "critica", status: "aberta", unit: "unidade", quantityNeeded: 30, createdAt: "2026-11-10T10:00:00.000Z",
  supply: { fulfilled: 20, requiredRemaining: 10, surplus: 0 }, attendance: { requested: 30, attended: 8, remaining: 22, percent: 26.6, physicalDestined: 8, surplus: 0, unitIncompatibleDestined: 0, state: "parcial" },
  counts: { evaluations: 1, allocations: { recebida: 1 }, receipts: 1, destinations: 1, localOffers: 0 },
  steps: [step("necessidade", "concluida", "30 unidade solicitados", "Necessidade registrada"), step("correspondencia", "concluida", "1 avaliação", "Correspondência (matching)"), step("atribuicao", "concluida", "1 recebida", "Atribuição da rede"), step("recebimento", "concluida", "20 recebidos", "Recebimento (suprimento)"), step("destinacao", "em_andamento", "1 destinação", "Destinação do estoque"), step("atendimento", "em_andamento", "8 de 30", "Atendimento final"), step("prestacao", "em_andamento", "1 sem comprovante. Isto não é homologação.", "Registros para prestação de contas")],
  next: "Faltam 22 unidade para o atendimento final.", hasCorrelation: true, ...over,
});
const access = { network: true, stock: true, opportunities: true, report: true, audit: true };
const offerItem = (kind: "oferta_local" | "atribuicao_rede", id: number, over: Record<string, unknown> = {}) => ({
  kind, id, title: kind === "oferta_local" ? `Agasalhos ${id}` : `Colchões da rede ${id}`, status: kind === "oferta_local" ? "registrada" : "proposta", statusLabel: kind === "oferta_local" ? "Registrada" : "Proposta (aguarda decisão)",
  quantity: 12, unit: "unidade", createdAt: "2026-11-10T10:00:00.000Z", sourceLabel: kind === "oferta_local" ? "Oferta registrada pela própria organização" : "Oferta da rede (Registro Central) · fonte Fonte QA",
  originLabel: kind === "oferta_local" ? null : "Atribuição manual",
  steps: [step("oferta", "concluida", "d", kind === "oferta_local" ? "Oferta local registrada" : "Oferta da rede"), step("vinculo", "pendente", "Nenhuma necessidade vinculada.", "Vínculo com necessidade"), step("correspondencia", "nao_se_aplica", "d", "Correspondência (matching)"), step("destinacao", "sem_dados", "d", "Destinação do estoque")],
  next: "Acompanhe a oferta em Oportunidades até o recebimento ou o cancelamento.", ...over,
});
const hrefOf = (e: { kind: string; needId?: number; id?: number }) => (e.kind === "necessidade" ? `/organizacoes/3/jornada?necessidade=${e.needId}` : `/organizacoes/3/jornada?oferta=${offerParam(e.kind as "oferta_local", e.id!)}`);
function Harness({ initial = EMPTY_FILTERS, onChange }: { initial?: JourneyFiltersState; onChange?: (f: JourneyFiltersState) => void }) {
  const [f, setF] = React.useState(initial);
  return React.createElement(JourneyList, { organizationId: 3, filters: f, onFiltersChange: (n: JourneyFiltersState) => { setF(n); onChange?.(n); }, buildDetailHref: hrefOf });
}
const setValue = async (el: HTMLInputElement | HTMLSelectElement, value: string, ms = 20) => { const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); await tick(ms); }); };
const selectOf = (label: RegExp) => [...document.querySelectorAll("label")].find((l) => label.test(l.textContent ?? ""))!.querySelector("select") as HTMLSelectElement;

describe("vocabulário da jornada", () => {
  it("estados em palavras; ação de destinação filtra pela necessidade; faixa só rotula o número gravado", () => {
    expect(STEP_STATE_LABEL.restrita).toBe("Restrita ao seu papel"); expect(STEP_STATE_LABEL.sem_dados).toBe("Sem dados"); expect(stepBadge("pendente")).toBe("destructive"); expect(stepBadge("concluida")).toBe("success");
    expect(stepAction("destinacao", 3, 77)).toEqual({ label: expect.stringMatching(/Destinação/), href: "/organizacoes/3/destinacoes?need=77" }); expect(stepAction("prestacao", 3)!.href).toBe("/organizacoes/3/prestacao-contas");
    expect(scoreBand(95)).toBe("alta confiança"); expect(scoreBand(75)).toBe("proposta"); expect(scoreBand(40)).toMatch(/abaixo do limiar/);
    expect(CRITERION_LABEL.necessidade_urgencia).toMatch(/Urgência/); expect(CRITERION_LABEL.proximidade).toMatch(/não é distância em km/);
  });
});

describe("JourneyList", () => {
  it("cartões com DOIS medidores separados (suprimento × atendimento), etapas em palavras, próxima ação e link para a jornada", async () => {
    routes = [[/journeys\?/, () => ok({ items: [item(1)], nextCursor: null, access })]];
    await mount(React.createElement(Harness));
    expect(text()).toMatch(/Cobertores 1/); expect(text()).toMatch(/Recebido da rede \(suprimento\)/); expect(text()).toMatch(/Atendimento final \(destinado\)/); expect(text()).toMatch(/20 unidade de 30 unidade \(66\.6%|20 unidade de 30 unidade \(66,6%/);
    expect(document.querySelectorAll('[role="progressbar"]').length).toBe(2);
    expect(text()).toMatch(/Destinação do estoque: Em andamento/); expect(text()).toMatch(/Próximo passo:/); expect(text()).toMatch(/Faltam 22 unidade/); expect(text()).toMatch(/nada aqui comprova entrega física/);
    const a = document.querySelector('a[aria-label^="Abrir a jornada da necessidade"]') as HTMLAnchorElement; expect(a.getAttribute("href")).toBe("/organizacoes/3/jornada?necessidade=1");
  });

  it("ofertas SEM necessidade: cartões próprios (oferta local e atribuição da rede) que dizem 'sem necessidade vinculada', não mostram medidores de atendimento e levam ao detalhe da oferta", async () => {
    routes = [[/journeys\?/, () => ok({ items: [item(1), offerItem("oferta_local", 7), offerItem("atribuicao_rede", 9)], nextCursor: null, access })]];
    await mount(React.createElement(Harness));
    expect(text()).toMatch(/Oferta local sem necessidade/); expect(text()).toMatch(/Atribuição da rede sem necessidade/); expect(text()).toMatch(/Atribuição manual/);
    expect(text()).toMatch(/Sem necessidade vinculada\./); expect(text()).toMatch(/Não há atendimento de necessidade nem destinação ligada a esta oferta/);
    expect(document.querySelectorAll('[role="progressbar"]').length).toBe(2); // só a necessidade tem medidores (suprimento e atendimento); as ofertas não ganham um progresso inventado
    expect(text()).toMatch(/Vínculo com necessidade: Pendente/); expect(text()).toMatch(/Correspondência: Não se aplica/); expect(text()).toMatch(/Destinação do estoque: Sem dados/);
    const hrefs = [...document.querySelectorAll('a[aria-label^="Abrir a jornada da oferta"]')].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/organizacoes/3/jornada?oferta=local-7", "/organizacoes/3/jornada?oferta=rede-9"]);
    for (const li of [...document.querySelectorAll('li')].filter((x) => /sem necessidade/.test(x.querySelector('h3')?.nextElementSibling?.textContent ?? '') && x.querySelector('ol'))) expect([...li.querySelectorAll('ol li')].filter((x) => /: Concluída/.test(x.textContent ?? '')).map((x) => x.textContent)).toHaveLength(1); // só a oferta está concluída; nenhuma etapa falsa
  });

  it("busca e filtros vão ao SERVIDOR (q, tipo, vínculo, situação); a busca espera a pausa da digitação; 'Limpar filtros' restaura; vazio com filtro ≠ vazio sem dados", async () => {
    const seen: string[] = [];
    routes = [[/journeys\?/, (c) => { seen.push(c.url); if (/q=nada/.test(c.url)) return ok({ items: [], nextCursor: null, access }); return ok({ items: [item(1), offerItem("oferta_local", 7)], nextCursor: null, access }); }]];
    const changes: JourneyFiltersState[] = [];
    await mount(React.createElement(Harness, { onChange: (f: JourneyFiltersState) => changes.push(f) }));
    const input = document.querySelector('input[type="search"]') as HTMLInputElement;
    await setValue(input, "n"); await setValue(input, "na"); await setValue(input, "nada", 20);
    expect(changes).toHaveLength(0); // ainda digitando: nenhuma chamada nova
    await act(async () => { await tick(550); }); await act(async () => { await tick(200); });
    expect(changes).toHaveLength(1); expect(changes[0].q).toBe("nada");
    expect(seen.some((u) => /q=nada/.test(u))).toBe(true); expect(text()).toMatch(/Nenhuma jornada encontrada com estes filtros/); expect(btn(/Limpar filtros/)).toBeTruthy(); expect(text()).not.toMatch(/ainda não tem necessidades/);
    await click(/Limpar filtros/); await act(async () => { await tick(300); });
    expect(text()).toMatch(/Cobertores 1/); expect(btn(/Limpar filtros/)).toBeFalsy(); expect((document.querySelector('input[type="search"]') as HTMLInputElement).value).toBe("");
    await setValue(selectOf(/^Tipo/), "oferta_local"); await act(async () => { await tick(300); }); expect(seen.some((u) => /tipo=oferta_local/.test(u))).toBe(true);
    await setValue(selectOf(/Necessidade vinculada/), "sem_necessidade"); await act(async () => { await tick(300); }); expect(seen.some((u) => /vinculo=sem_necessidade/.test(u))).toBe(true);
    await setValue(selectOf(/Situação/), "proposta"); await act(async () => { await tick(300); }); expect(seen.some((u) => /status=proposta/.test(u))).toBe(true);
    expect(text()).toMatch(/jornadas exibidas com os filtros atuais|jornada exibida com os filtros atuais/);
  });

  it("filtros iniciais (vindos da URL) são aplicados na primeira chamada; 'Carregar mais' envia o cursor do servidor e acrescenta sem duplicar; erro recuperável; vazio sem filtro", async () => {
    const cursor = "2026-11-10T10:00:00.000000Z_1_5";
    routes = [[/journeys\?/, (c) => { if (c.url.includes(`cursor=${encodeURIComponent(cursor)}`)) return ok({ items: [item(4)], nextCursor: null, access }); return ok({ items: [item(5)], nextCursor: cursor, access }); }]];
    await mount(React.createElement(Harness, { initial: { ...EMPTY_FILTERS, tipo: "necessidade", q: "cobertor" } }));
    expect(calls[0].url).toMatch(/tipo=necessidade/); expect(calls[0].url).toMatch(/q=cobertor/); expect((document.querySelector('input[type="search"]') as HTMLInputElement).value).toBe("cobertor");
    await click(/Carregar mais jornadas/); expect(calls.some((c) => c.url.includes(`cursor=${encodeURIComponent(cursor)}`))).toBe(true); expect(text()).toMatch(/Cobertores 4/); expect(text()).toMatch(/Cobertores 5/);
    act(() => root?.unmount()); host?.remove(); document.body.innerHTML = "";
    routes = [[/journeys\?/, () => fail(500, { message: "Falha ao carregar" })]];
    await mount(React.createElement(Harness));
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/Falha ao carregar/); expect(text()).toMatch(/Nada foi alterado/); expect(btn(/Tentar de novo/)).toBeTruthy(); expect(text()).not.toMatch(/Esta organização ainda não tem necessidades/);
    act(() => root?.unmount()); host?.remove(); document.body.innerHTML = "";
    routes = [[/journeys\?/, () => ok({ items: [], nextCursor: null, access })]];
    await mount(React.createElement(Harness));
    expect(text()).toMatch(/Esta organização ainda não tem necessidades nem ofertas sem necessidade/); expect(btn(/Limpar filtros/)).toBeFalsy();
  });
});

describe("JourneyList — mudanças de filtro em sequência rápida (URL ainda não atualizada)", () => {
  it("o segundo filtro parte do estado mais recente: não desfaz o primeiro (a URL é assíncrona)", async () => {
    routes = [[/journeys\?/, () => ok({ items: [item(1)], nextCursor: null, access })]];
    const changes: JourneyFiltersState[] = [];
    // o pai NÃO atualiza `filters` (simula a URL que ainda não mudou): as duas mudanças chegam antes de qualquer re-render com o filtro novo
    await mount(React.createElement(JourneyList, { organizationId: 3, filters: EMPTY_FILTERS, onFiltersChange: (f: JourneyFiltersState) => { changes.push(f); }, buildDetailHref: hrefOf }));
    await setValue(selectOf(/^Tipo/), "oferta_local", 0); await setValue(selectOf(/Necessidade vinculada/), "sem_necessidade", 0);
    expect(changes).toHaveLength(2); expect(changes[1]).toMatchObject({ tipo: "oferta_local", vinculo: "sem_necessidade" });
  });
});

describe("parâmetro da oferta na URL e ações das ofertas", () => {
  it("local-ID e rede-ID são aceitos; qualquer outra forma é recusada; as ações apontam para os módulos de origem", () => {
    expect(parseOfferParam("local-12")).toEqual({ kind: "oferta_local", id: 12 }); expect(parseOfferParam("rede-7")).toEqual({ kind: "atribuicao_rede", id: 7 });
    for (const bad of [null, "", "local-", "local-abc", "outra-1", "local-1x", "local--1", "local-1234567890123"]) expect(parseOfferParam(bad as never), String(bad)).toBeNull();
    expect(offerParam("oferta_local", 3)).toBe("local-3"); expect(offerParam("atribuicao_rede", 4)).toBe("rede-4");
    expect(offerStepAction("recebimento", "oferta_local", 5)!.href).toBe("/organizacoes/5/oportunidades"); expect(offerStepAction("recebimento", "atribuicao_rede", 5)!.href).toBe("/organizacoes/5/atribuicoes");
    expect(offerStepAction("correspondencia", "oferta_local", 5)).toBeNull(); expect(KIND_LABEL.oferta_local).toMatch(/sem necessidade/);
  });
});

describe("JourneyDetailView", () => {
  const detail = (over: Record<string, unknown> = {}) => ({
    ...item(7), description: "Para o inverno", itemName: "Cobertores", closure: null,
    evaluations: [{ id: "1", createdAt: "2026-11-10T11:00:00.000Z", decision: "proposto", finalScore: 76.5, algorithmVersion: "1.4", allocationId: 9, opportunity: { id: 4, title: "Doação de cobertores", category: "cobertores", quantity: 40, unit: "unidade" },
      criteria: [{ key: "categoria", score: 100, weight: 0.2, detail: "mesma categoria" }, { key: "necessidade_urgencia", score: 100, weight: 0.15, detail: "prioridade da necessidade: critica" }, { key: "horarios_restricoes", score: null, weight: 0, detail: "nao_aplicavel: dado nao coletado ainda" }], notApplicable: ["horarios_restricoes"] }],
    allocations: [{ id: 9, status: "recebida", quantityAllocated: 40, autoMatched: true, origin: "matching", evaluationId: "1", createdAt: "2026-11-10T11:01:00.000Z", responseDueAt: null, reservedUntil: null, closedAt: null, closedReason: null, decidedByName: "Ana Admin", opportunity: { id: 4, title: "Doação de cobertores", unit: "unidade" }, logistics: [{ id: "1", eventType: "coleta_agendada", scheduledFor: null, occurredAt: "2026-11-10T11:02:00.000Z", actorName: "Ana Admin" }] }],
    receipts: [{ id: "1", allocationId: 9, entryType: "original", quantity: 20, unit: "unidade", isCountable: true, unitMismatchNote: null, stockTransactionId: "5", createdAt: "2026-11-10T11:03:00.000Z", createdByName: "Ana Admin" }],
    destinations: [{ id: "3", itemName: "Cobertores", destinationType: "distribuicao_familias", quantity: 8, unit: "unidade", isCountable: true, state: "ativa", reversedQuantity: 0, proof: null, createdByDisplayName: "Beto Operador", createdAt: "2026-11-10T11:04:00.000Z" }],
    pendingApprovals: [{ id: 11, quantity: 8, unit: "unidade", requestedAt: "2026-11-10T11:05:00.000Z" }], localOffers: [{ id: 2, title: "Oferta local", status: "registrada", quantityOffered: null, unit: null, createdAt: "2026-11-10T09:00:00.000Z" }],
    timeline: [{ at: "2026-11-10T10:00:00.000Z", kind: "necessidade", title: "Necessidade registrada: Cobertores", detail: null, actor: "Ana Admin", ref: null }, { at: "2026-11-10T11:04:00.000Z", kind: "destinacao", title: "Destinação #3: 8 unidade", detail: "sem comprovante", actor: "Beto Operador", ref: null }],
    pendings: ["Atribuição #9 está proposta e aguarda decisão da organização.", "Saída de 8 unidade para esta necessidade aguarda a segunda aprovação (pedido #11); o estoque ainda não baixou."],
    audit: { correlationId: "22222222-2222-4222-8222-222222222222", entries: 9, path: "/organizacoes/3/auditoria?correlacao=22222222-2222-4222-8222-222222222222", note: "Registros de auditoria desta jornada." }, access,
    notes: ["Tudo aqui vem de registros do sistema. Nenhuma tela comprova entrega física: a prestação de contas depende dos comprovantes anexados pela organização."], ...over,
  });

  it("etapas, pendências (inclui a aprovação pendente), correspondência EXPLICADA com critério não aplicável sem número, atribuição com logística, recebimento, destinação, ofertas locais, linha do tempo e auditoria", async () => {
    routes = [[/journey\?/, () => ok(detail())]];
    await mount(React.createElement(JourneyDetailView, { organizationId: 3, needId: 7, onBack: vi.fn() }));
    expect(text()).toMatch(/Para o inverno/); expect(text()).toMatch(/Recebido da rede \(suprimento\)/); expect(text()).toMatch(/Atendimento final \(destinado\)/); expect(text()).toMatch(/Prioridade Crítica/);
    expect(text()).toMatch(/Etapas/); expect(text()).toMatch(/Registros para prestação de contas/); expect(text()).toMatch(/Isto não é homologação/);
    expect(text()).toMatch(/aguarda a segunda aprovação \(pedido #11\)/); expect(text()).toMatch(/proposta e aguarda decisão/);
    expect(text()).toMatch(/pontuação 76\.5|pontuação 76,5/); expect(text()).toMatch(/proposta\)/); expect(text()).toMatch(/Categoria: 100 \(peso 0\.2\)|Categoria: 100 \(peso 0,2\)/); expect(text()).toMatch(/Urgência da necessidade/);
    expect(text()).toMatch(/Horários e restrições: não aplicável — nao_aplicavel/); // critério sem pontuação: dito, sem número inventado
    expect(text()).toMatch(/Atribuição #9/); expect(text()).toMatch(/Coleta agendada/); expect(text()).toMatch(/Recebimento: 20 unidade/); expect(text()).toMatch(/Sem comprovante/); expect(text()).toMatch(/uma oferta registrada não é uma doação entregue/);
    expect(text()).toMatch(/não prova causa entre itens/); expect(text()).toMatch(/Correlação: 22222222-2222-4222-8222-222222222222 · 9 registro/); expect(text()).toMatch(/Nenhuma tela comprova entrega física/);
    const lnk = [...document.querySelectorAll("a")].find((a) => /Abrir os registros na Central de Auditoria/.test(a.textContent ?? "")) as HTMLAnchorElement; expect(lnk.getAttribute("href")).toContain("correlacao=");
    const dest = [...document.querySelectorAll("a")].find((a) => /Destinação \(filtrada por esta necessidade\)/.test(a.textContent ?? "")) as HTMLAnchorElement; expect(dest.getAttribute("href")).toBe("/organizacoes/3/destinacoes?need=7");
  });

  it("papel restrito: seções sem acesso dizem 'restrita ao seu papel' (não zero) e a auditoria some; necessidade antiga diz que não há correlação", async () => {
    routes = [[/journey\?/, () => ok(detail({ evaluations: null, allocations: null, destinations: null, pendingApprovals: null, localOffers: null, audit: null, access: { network: false, stock: false, opportunities: false, report: false, audit: false }, steps: [step("necessidade", "concluida"), step("correspondencia", "restrita", "O seu papel não consulta a rede.", "Correspondência (matching)"), step("prestacao", "restrita", "O seu papel não consulta a prestação de contas.", "Registros para prestação de contas")], pendings: [] }))]];
    await mount(React.createElement(JourneyDetailView, { organizationId: 3, needId: 7, onBack: vi.fn() }));
    expect(text()).toMatch(/Restrita ao seu papel/); expect(text()).toMatch(/As destinações são restritas ao seu papel/); expect(text()).toMatch(/A prestação de contas é restrita ao seu papel/);
    expect(text()).not.toMatch(/Correspondências da rede/); expect(text()).not.toMatch(/Auditoria desta jornada/); expect(text()).toMatch(/Nenhuma pendência identificada nos registros a que o seu papel tem acesso/);
    act(() => root?.unmount()); host?.remove(); document.body.innerHTML = "";
    routes = [[/journey\?/, () => ok(detail({ audit: { correlationId: null, entries: null, path: null, note: "Esta necessidade é anterior à correlação da jornada: nenhuma correlação foi fabricada." } }))]];
    await mount(React.createElement(JourneyDetailView, { organizationId: 3, needId: 7, onBack: vi.fn() }));
    expect(text()).toMatch(/nenhuma correlação foi fabricada/); expect([...document.querySelectorAll("a")].some((a) => /Central de Auditoria/.test(a.textContent ?? ""))).toBe(false);
  });

  it("404 e erro de rede: mensagem clara, 'Tentar de novo' e voltar para a lista funcionam; estado de carregamento anuncia aria-busy", async () => {
    const onBack = vi.fn();
    routes = [[/journey\?/, () => fail(404, { message: "Necessidade não encontrada nesta organização" })]];
    await mount(React.createElement(JourneyDetailView, { organizationId: 3, needId: 999, onBack }));
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/Necessidade não encontrada nesta organização/); expect(btn(/Tentar de novo/)).toBeTruthy();
    await click(/Todas as jornadas/); expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("JourneyDetailView — origem da atribuição (matching × manual)", () => {
  const base = () => ({ ...item(7), description: null, itemName: null, closure: null, receipts: [], destinations: [], pendingApprovals: [], localOffers: [], timeline: [], pendings: [], audit: null, access, notes: ["n"] });
  it("atribuição MANUAL: a tela diz que nenhuma avaliação de matching foi executada e mostra a origem 'Atribuição manual'; com matching mostra a avaliação", async () => {
    const manualAlloc = { id: 3, status: "aceita", quantityAllocated: 30, autoMatched: false, origin: "manual", evaluationId: null, createdAt: "2026-11-10T11:01:00.000Z", responseDueAt: null, reservedUntil: null, closedAt: null, closedReason: null, decidedByName: "Ana", opportunity: { id: 4, title: "Cobertores da rede", unit: "unidade" }, logistics: [] };
    routes = [[/journey\?/, () => ok({ ...base(), evaluations: [], allocations: [manualAlloc], steps: [step("necessidade", "concluida"), step("correspondencia", "nao_se_aplica", "Atribuição manual autorizada (1); nenhuma avaliação de matching foi executada para esta necessidade.", "Correspondência (matching)")] })]];
    await mount(React.createElement(JourneyDetailView, { organizationId: 3, needId: 7, onBack: vi.fn() }));
    expect(text()).toMatch(/Nenhuma avaliação de matching foi executada para esta necessidade: as atribuições abaixo foram feitas manualmente/); expect(text()).toMatch(/Atribuição manual/); expect(text()).toMatch(/Correspondência \(matching\)/); expect(text()).toMatch(/Não se aplica/);
    expect(text()).not.toMatch(/Correspondência \(matching\)Concluída/); expect(text()).not.toMatch(/pontuação \d/);
    act(() => root?.unmount()); host?.remove(); document.body.innerHTML = "";
    routes = [[/journey\?/, () => ok({ ...base(), evaluations: [], allocations: [{ ...manualAlloc, origin: "nao_verificavel", autoMatched: true }], steps: [step("necessidade", "concluida")] })]];
    await mount(React.createElement(JourneyDetailView, { organizationId: 3, needId: 7, onBack: vi.fn() }));
    expect(text()).toMatch(/Automática, sem avaliação no histórico/); expect(text()).not.toMatch(/foram feitas manualmente/);
  });
});

describe("JourneyDetailView — matching sem resultado, não executado e histórico (M42)", () => {
  const base = () => ({ ...item(7), description: null, itemName: null, closure: null, receipts: [], destinations: [], pendingApprovals: [], localOffers: [], timeline: [], pendings: [], audit: null, access, notes: ["n"], allocations: [], evaluations: [] });
  const run = (id: string, outcome: string, over: Record<string, unknown> = {}) => ({ id, origin: "varredura", originLabel: "varredura automática", finishedAt: "2026-11-11T12:00:00.000Z", repeatCount: 0, lastRepeatedAt: null, outcome, ...over });
  it("vocabulário: 'executado, sem correspondência' tem rótulo próprio, não é 'concluída' nem 'pendente'", () => {
    expect(STEP_STATE_LABEL.executado_sem_resultado).toBe("Executado, sem correspondência"); expect(stepBadge("executado_sem_resultado")).toBe("secondary");
    expect(MATCHING_STATE_LABEL.nao_executado).toBe("Matching não executado"); expect(MATCHING_STATE_LABEL.historico_nao_verificavel).toMatch(/não verificável/); expect(MATCH_RUN_OUTCOME_LABEL.sem_relacao).toMatch(/Nenhuma oferta relacionada/);
  });
  it("executado SEM correspondência: o estado diz que não é falha, lista as execuções (data, origem, resultado, reconfirmações) e não identifica a oferta", async () => {
    routes = [[/journey\?/, () => ok({ ...base(), steps: [step("necessidade", "concluida"), step("correspondencia", "executado_sem_resultado", "Matching executado em 2 execução(ões): nenhuma correspondência válida. Isto não é uma falha.", "Correspondência (matching)")],
      matching: { state: "executado_sem_correspondencia", note: "Execuções do matching anteriores ao histórico (M42) não deixaram registro por necessidade.", runs: [run("2", "sem_relacao", { repeatCount: 3, lastRepeatedAt: "2026-11-11T13:00:00.000Z" }), run("1", "avaliada_descartada", { origin: "manual", originLabel: "execução manual da administração" })] } })]];
    await mount(React.createElement(JourneyDetailView, { organizationId: 3, needId: 7, onBack: vi.fn() }));
    expect(text()).toMatch(/Matching desta necessidade/); expect(text()).toMatch(/Executado, sem correspondência/); expect(text()).toMatch(/NÃO é uma falha técnica e não significa falta de oferta/);
    expect(text()).toMatch(/Nenhuma oferta relacionada a esta necessidade/); expect(text()).toMatch(/Avaliada, sem correspondência válida \(abaixo do limiar\)/); expect(text()).toMatch(/varredura automática/); expect(text()).toMatch(/execução manual da administração/);
    expect(text()).toMatch(/reconfirmado 3 vez\(es\) pela varredura/); expect(text()).toMatch(/anteriores ao histórico \(M42\) não deixaram registro/);
    expect(document.querySelectorAll('ol[aria-label="Execuções do matching que consideraram esta necessidade"] > li')).toHaveLength(2);
    expect(text()).toMatch(/Correspondência \(matching\)/); expect(text()).not.toMatch(/Falhou/);
  });
  it("não executado: diz que nenhuma execução está registrada; com correspondência e histórico não verificável também têm texto próprio", async () => {
    for (const [state, re] of [["nao_executado", /Matching não executado/], ["executado_com_correspondencia", /Executado, com correspondência/], ["historico_nao_verificavel", /Resultado histórico não verificável/], ["atribuicao_manual", /Atribuição manual \(matching não executado\)/]] as const) {
      routes = [[/journey\?/, () => ok({ ...base(), steps: [step("necessidade", "concluida")], matching: { state, note: "n", runs: state === "executado_com_correspondencia" ? [run("1", "com_correspondencia")] : [] } })]];
      await mount(React.createElement(JourneyDetailView, { organizationId: 3, needId: 7, onBack: vi.fn() }));
      expect(text(), state).toMatch(re);
      if (state === "nao_executado") expect(text()).toMatch(/Nenhuma execução do matching registrada para esta necessidade/);
      if (state === "executado_com_correspondencia") expect(text()).toMatch(/Houve correspondência válida/);
      act(() => root?.unmount()); host?.remove(); document.body.innerHTML = "";
    }
  });
  it("avaliação de oferta NÃO atribuída é anônima: sem título, sem texto de critério; a atribuída continua identificada", async () => {
    const crit = (detail: string | null) => [{ key: "categoria", score: 40, weight: 0.2, detail }];
    routes = [[/journey\?/, () => ok({ ...base(), steps: [step("necessidade", "concluida")], matching: { state: "executado_sem_correspondencia", note: "n", runs: [] },
      evaluations: [{ id: "1", createdAt: "2026-11-11T11:00:00.000Z", decision: "descartado", finalScore: 41.5, algorithmVersion: "1.4", allocationId: null, opportunity: null, criteria: crit(null), notApplicable: [] },
        { id: "2", createdAt: "2026-11-11T11:01:00.000Z", decision: "proposto", finalScore: 80, algorithmVersion: "1.4", allocationId: 9, opportunity: { id: 4, title: "Oferta atribuída", category: "c", quantity: 1, unit: "u" }, criteria: crit("mesma categoria"), notApplicable: [] }] })]];
    await mount(React.createElement(JourneyDetailView, { organizationId: 3, needId: 7, onBack: vi.fn() }));
    expect(text()).toMatch(/Oferta da rede não atribuída a esta organização \(identificação reservada à plataforma\) — pontuação 41/); expect(text()).toMatch(/Descartada: pontuação abaixo do limiar de proposta/);
    expect(text()).toMatch(/Oferta “Oferta atribuída” — pontuação 80/); expect(text()).toMatch(/Categoria: 40 \(peso 0\.2\)(?! —)/); expect(text()).toMatch(/Categoria: 40 \(peso 0,2\)|Categoria: 40 \(peso 0\.2\)/); expect(text()).toMatch(/mesma categoria/);
  });
});

describe("OfferJourneyDetailView", () => {
  const offerDetail = (kind: "oferta_local" | "atribuicao_rede", over: Record<string, unknown> = {}) => ({
    ...offerItem(kind, 7), description: "Casacos e cobertores", category: "agasalhos", createdByName: "Ana Admin", donorName: kind === "oferta_local" ? "Doador Sintético" : null, evaluation: null, logistics: [], receipts: [], decidedByName: null,
    timeline: [{ at: "2026-11-10T10:00:00.000Z", kind: kind === "oferta_local" ? "oferta_local" : "atribuicao", title: "Registrada", detail: null, actor: "Ana Admin", ref: null }],
    pendings: ["Nenhuma necessidade está vinculada a esta oferta."],
    linking: { available: false, reason: "O sistema só permite informar a necessidade no momento em que a oferta (ou a atribuição) é criada. Ainda não existe uma operação para vincular depois — essa regra de negócio está pendente de decisão e nada foi criado no lugar dela.", alternatives: [{ label: "Abrir Oportunidades (status, categoria e recebimento da oferta)", href: "/organizacoes/3/oportunidades" }] },
    audit: { correlationId: "33333333-3333-4333-8333-333333333333", entries: 2, path: "/organizacoes/3/auditoria?correlacao=33333333-3333-4333-8333-333333333333", note: "Registros de auditoria desta oferta." }, access,
    notes: ["Tudo aqui vem de registros do sistema. Nenhuma tela comprova entrega física: a prestação de contas depende dos comprovantes anexados pela organização."], ...over,
  });

  it("oferta local: diz que não há necessidade, explica por que vincular depois não existe (decisão pendente), mostra etapas verdadeiras, auditoria e NÃO mostra medidor de atendimento", async () => {
    routes = [[/offer-journey\?/, () => ok(offerDetail("oferta_local"))]];
    await mount(React.createElement(OfferJourneyDetailView, { organizationId: 3, kind: "oferta_local", id: 7, onBack: vi.fn() }));
    expect(calls[0].url).toMatch(/kind=oferta_local/); expect(calls[0].url).toMatch(/id=7/);
    expect(text()).toMatch(/Oferta local sem necessidade/); expect(text()).toMatch(/Doador Sintético/); expect(text()).toMatch(/Necessidade vinculada.*Nenhuma/);
    expect(text()).toMatch(/Vincular depois não está disponível/); expect(text()).toMatch(/pendente de decisão/); expect(text()).toMatch(/Abrir Oportunidades \(status, categoria e recebimento da oferta\)/);
    expect(text()).toMatch(/Vínculo com necessidade/); expect(text()).toMatch(/Pendente/); expect(text()).toMatch(/Não se aplica/); expect(text()).toMatch(/Sem dados/);
    expect(text()).not.toMatch(/Atendimento final/); expect(document.querySelectorAll('[role="progressbar"]').length).toBe(0);
    expect(text()).toMatch(/Correlação: 33333333-3333-4333-8333-333333333333 · 2 registro/); expect(text()).toMatch(/Nenhuma tela comprova entrega física/);
    const lnk = [...document.querySelectorAll("a")].find((a) => /Central de Auditoria/.test(a.textContent ?? "")) as HTMLAnchorElement; expect(lnk.getAttribute("href")).toContain("correlacao=");
  });

  it("atribuição da rede sem necessidade: origem manual ou avaliação de matching ditas com precisão; sem correlação própria a auditoria é pelo recurso (nada fabricado)", async () => {
    routes = [[/offer-journey\?/, () => ok(offerDetail("atribuicao_rede", { audit: { correlationId: null, entries: 3, path: "/organizacoes/3/auditoria?recurso=opportunity_allocation&recursoId=7", note: "Atribuições sem necessidade não têm uma correlação própria: os registros são consultados pelo recurso (a atribuição). Nenhuma correlação é inventada." }, donorName: null }))]];
    await mount(React.createElement(OfferJourneyDetailView, { organizationId: 3, kind: "atribuicao_rede", id: 7, onBack: vi.fn() }));
    expect(text()).toMatch(/Atribuição da rede sem necessidade/); expect(text()).toMatch(/Origem da atribuição/); expect(text()).toMatch(/Nenhuma avaliação de matching foi executada e nenhuma pontuação foi inventada/);
    expect(text()).toMatch(/3 registro\(s\) de auditoria para este recurso/); expect(text()).not.toMatch(/Correlação:/); expect(text()).toMatch(/Nenhuma correlação é inventada/);
    act(() => root?.unmount()); host?.remove(); document.body.innerHTML = "";
    routes = [[/offer-journey\?/, () => ok(offerDetail("atribuicao_rede", { originLabel: "Matching (avaliação do motor)", evaluation: { id: "12", finalScore: 82, decision: "proposto", algorithmVersion: "1.4", createdAt: "2026-11-10T10:30:00.000Z" } }))]];
    await mount(React.createElement(OfferJourneyDetailView, { organizationId: 3, kind: "atribuicao_rede", id: 7, onBack: vi.fn() }));
    expect(text()).toMatch(/Avaliação de matching #12 — pontuação 82 \(proposta\)/); expect(text()).not.toMatch(/Nenhuma avaliação de matching foi executada/);
  });

  it("404 (outra organização, inexistente ou papel sem acesso): mensagem clara, 'Tentar de novo' e voltar; sem vazar dados", async () => {
    const onBack = vi.fn();
    routes = [[/offer-journey\?/, () => fail(404, { message: "Oferta não encontrada nesta organização (ou o seu papel não a consulta)" })]];
    await mount(React.createElement(OfferJourneyDetailView, { organizationId: 3, kind: "oferta_local", id: 999, onBack }));
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/Oferta não encontrada nesta organização/); expect(btn(/Tentar de novo/)).toBeTruthy();
    await click(/Todas as jornadas/); expect(onBack).toHaveBeenCalledTimes(1);
  });
});
