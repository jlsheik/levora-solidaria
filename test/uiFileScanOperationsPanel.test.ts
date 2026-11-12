// @vitest-environment jsdom
/**
 * M32 — painel “Análise antimalware de arquivos” (administração da plataforma): renderiza com o componente REAL, `react-query` real e `fetch` simulado com o corpo no formato do servidor (superjson).
 * Cobre: carregamento, dados em ordem, atenção, limiares não definidos, erro com nova tentativa, atualização manual, estrutura acessível e ausência de dados sensíveis.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import superjson from "superjson";
import { readFileSync } from "node:fs";
import { FileScanOperationsPanel } from "../src/components/FileScanOperationsPanel";
import type { OutputType as Ops } from "../src/endpoints/file-scan-operations_GET.schema";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let host: HTMLDivElement | null = null; let root: Root | null = null; let calls = 0; let handler: () => Response | Promise<Response>;

const base = (over: Partial<Ops> = {}): Ops => ({
  generatedAt: "2026-10-16T18:00:00.000Z", mode: "required",
  scanner: { configured: true, scanner: "clamd", reachable: true, ping: "PONG", engine: "ClamAV 1.5.4", signatureVersion: 28155, signatureDate: "2026-10-16T06:24:17.000Z", signatureAgeHours: 12, freshness: "atual", maxAgeHours: 48, checkedAt: "2026-10-16T18:00:00.000Z", error: null },
  backlog: { pendente: 2, indisponivel: 0, infectado: 1, legadoNaoAnalisado: 0, aguardandoNovaTentativa: 0, abandonadas: 0, esgotadas: 0, pendenteMaisAntigoMinutos: 5, indisponivelMaisAntigoMinutos: null },
  retry: { maxAttempts: 5, baseSeconds: 30, maxSeconds: 3600, batchSize: 20, concurrency: 2, leaseSeconds: 300 },
  worker: { lastRunAt: "2026-10-16T17:55:00.000Z", lastStatus: "concluida", lastResult: null, runsLast24h: 96, failedLast24h: 0, lastRunAgeMinutes: 5 },
  analysesLast24h: { aprovadas: 40, infectadas: 1, indisponiveis: 0, duracaoMediaMs: 180, duracaoMaxMs: 1500 },
  alerts: ["scanner_sem_resposta", "assinaturas_antigas", "assinaturas_desconhecidas", "backlog_envelhecido", "tarefas_abandonadas", "tentativas_esgotadas", "worker_sem_executar", "falhas_recentes"].map((code) => ({ code, level: "ok", detail: "ok" })) as Ops["alerts"],
  ...over,
});
const json = (o: Ops) => new Response(superjson.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
const fail = () => new Response(superjson.stringify({ message: "Acesso restrito à administração da plataforma" }), { status: 403, headers: { "Content-Type": "application/json" } });

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(React.createElement(QueryClientProvider, { client: qc }, React.createElement(FileScanOperationsPanel))); });
  await act(async () => { await tick(60); });
}
beforeEach(() => { calls = 0; vi.stubGlobal("fetch", vi.fn(async () => { calls++; return handler(); })); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); host = null; root = null; vi.unstubAllGlobals(); });
const text = () => host!.textContent ?? "";

describe("FileScanOperationsPanel", () => {
  it("enquanto carrega mostra o esqueleto e a região indica ocupado; depois exibe os dados", async () => {
    let release!: (r: Response) => void; handler = () => new Promise<Response>((r) => { release = r; });
    const qc = new QueryClient(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(React.createElement(QueryClientProvider, { client: qc }, React.createElement(FileScanOperationsPanel))); }); await act(async () => { await tick(20); });
    expect(host.querySelector("section")!.getAttribute("aria-busy")).toBe("true"); expect(text()).not.toMatch(/Tudo em ordem/);
    await act(async () => { release(json(base())); await tick(60); });
    expect(text()).toMatch(/Tudo em ordem/); expect(host.querySelector("section")!.getAttribute("aria-busy")).toBe("false");
  });

  it("tudo em ordem: resumo, serviço respondendo, fila e 8 sinais 'Em ordem'; texto em português, sem nomes de arquivo", async () => {
    handler = () => json(base()); await mount();
    expect(text()).toMatch(/Análise antimalware de arquivos/); expect(text()).toMatch(/Tudo em ordem/); expect(text()).toMatch(/Respondendo/); expect(text()).toMatch(/ClamAV 1\.5\.4/);
    expect(text()).toMatch(/Obrigatória/); expect(host!.querySelectorAll("ul li").length).toBe(8); expect(text().match(/Em ordem/g)!.length).toBeGreaterThanOrEqual(9);
    expect(text()).toMatch(/Infectados \(bloqueados\)/); expect(text()).toMatch(/Duração da análise/); expect(text()).toMatch(/180 ms \/ 1,5 s/);
    expect(text()).not.toMatch(/\.(pdf|png|jpe?g|exe)\b/i); expect(text()).not.toMatch(/storage|bucket|s3:\/\//i);
  });

  it("sinais de atenção: contagem no resumo e rótulo textual 'Atenção' (não só cor)", async () => {
    const o = base(); o.alerts = o.alerts.map((a) => (a.code === "tentativas_esgotadas" || a.code === "falhas_recentes" ? { ...a, level: "alerta" as const, detail: "3 aguardando reanálise manual" } : a));
    o.backlog = { ...o.backlog, esgotadas: 3 }; handler = () => json(o); await mount();
    expect(text()).toMatch(/2 sinais de atenção/); expect((text().match(/Atenção/g) ?? []).length).toBeGreaterThanOrEqual(3); expect(text()).toMatch(/3 aguardando reanálise manual/);
  });

  it("limiares não definidos NÃO aparecem como 'tudo em ordem' e a nota explica", async () => {
    const o = base(); o.alerts = o.alerts.map((a) => (a.code === "backlog_envelhecido" || a.code === "worker_sem_executar" ? { ...a, level: "nao_definido" as const, detail: "variável não definida" } : a));
    handler = () => json(o); await mount();
    expect(text()).toMatch(/Sem alertas; 2 limiares operacionais ainda não definidos/); expect(text()).not.toMatch(/Tudo em ordem/); expect(text()).toMatch(/Limiar não definido/); expect(text()).toMatch(/isso não significa que esteja tudo bem/);
  });

  it("serviço sem resposta: estado e motivo visíveis, tom de atenção", async () => {
    const o = base({ scanner: { ...base().scanner, reachable: false, ping: "sem_resposta", engine: null, error: "timeout" } }); o.alerts = o.alerts.map((a) => (a.code === "scanner_sem_resposta" ? { ...a, level: "alerta" as const, detail: "clamd sem resposta válida" } : a));
    handler = () => json(o); await mount(); expect(text()).toMatch(/Sem resposta/); expect(text()).toMatch(/timeout/); expect(text()).toMatch(/1 sinal de atenção/);
  });

  it("worker que nunca executou e idades ausentes mostram texto honesto (não zero)", async () => {
    const o = base({ worker: { lastRunAt: null, lastStatus: null, lastResult: null, runsLast24h: 0, failedLast24h: 0, lastRunAgeMinutes: null }, analysesLast24h: { aprovadas: 0, infectadas: 0, indisponiveis: 0, duracaoMediaMs: null, duracaoMaxMs: null } });
    o.backlog = { ...o.backlog, pendenteMaisAntigoMinutos: null }; handler = () => json(o); await mount();
    expect(text()).toMatch(/Nunca executou/); expect(text()).toMatch(/Sem execução registrada/); expect(text()).toMatch(/— \/ —/);
  });

  it("erro 403/rede: mensagem em role=alert com a causa do servidor e 'Tentar de novo' refaz a consulta e recupera", async () => {
    handler = () => fail(); await mount();
    const alertEl = host!.querySelector('[role="alert"]'); expect(alertEl).toBeTruthy(); expect(alertEl!.textContent).toMatch(/Acesso restrito à administração da plataforma/); expect(text()).not.toMatch(/Tudo em ordem/);
    const before = calls; handler = () => json(base());
    const retry = [...host!.querySelectorAll("button")].find((b) => /Tentar de novo/.test(b.textContent ?? ""))!; expect(retry).toBeTruthy();
    await act(async () => { retry.click(); await tick(60); }); expect(calls).toBeGreaterThan(before); expect(text()).toMatch(/Tudo em ordem/); expect(host!.querySelector('[role="alert"]')).toBeNull();
  });

  it("botão Atualizar: nome acessível, refaz a consulta e mostra o instante; durante a atualização fica desabilitado", async () => {
    handler = () => json(base()); await mount();
    const btn = host!.querySelector('button[aria-label="Atualizar indicadores da análise de arquivos"]') as HTMLButtonElement; expect(btn).toBeTruthy(); expect(btn.disabled).toBe(false); expect(text()).toMatch(/Atualizado em/);
    const before = calls; let release!: (r: Response) => void; handler = () => new Promise<Response>((r) => { release = r; });
    await act(async () => { btn.click(); await tick(20); }); expect(calls).toBe(before + 1); expect(btn.disabled).toBe(true); expect(btn.textContent).toMatch(/Atualizando/);
    await act(async () => { release(json(base({ generatedAt: "2026-10-16T19:00:00.000Z" }))); await tick(60); }); expect(btn.disabled).toBe(false);
  });

  it("estrutura acessível: seção rotulada pelo título, subtítulos h3, métricas em <dl>/<dt>/<dd>, resumo em role=status, sem imagens sem texto", async () => {
    handler = () => json(base()); await mount();
    const section = host!.querySelector("section")!; const labelId = section.getAttribute("aria-labelledby")!; expect(host!.querySelector(`#${labelId}`)!.tagName).toBe("H2");
    expect(host!.querySelectorAll("h3").length).toBe(4); expect(host!.querySelector('[role="status"]')).toBeTruthy();
    const dls = host!.querySelectorAll("dl"); expect(dls.length).toBe(2); for (const dl of dls) { expect(dl.querySelectorAll("dt").length).toBeGreaterThan(3); for (const dt of dl.querySelectorAll("dt")) expect(dt.nextElementSibling?.tagName).toBe("DD"); }
    for (const svg of host!.querySelectorAll("svg")) expect(svg.getAttribute("aria-hidden")).toBe("true");
    for (const b of host!.querySelectorAll("button")) expect((b.textContent ?? "").trim() || b.getAttribute("aria-label")).toBeTruthy();
  });
});

describe("integração e CSS (estático)", () => {
  it("a página da plataforma monta o painel; o CSS é responsivo e usa os tokens do sistema", () => {
    const page = readFileSync("src/pages/plataforma.tsx", "utf8"); expect(page).toContain('import { FileScanOperationsPanel } from "../components/FileScanOperationsPanel"'); expect(page).toContain("<FileScanOperationsPanel />");
    const css = readFileSync("src/components/FileScanOperationsPanel.module.css", "utf8").split("\r\n").join("\n");
    expect(css).toContain("repeat(auto-fit, minmax(10.5rem, 1fr))"); expect(css).toContain("@media (max-width: 40rem)"); expect(css).toContain("overflow-wrap: anywhere"); expect(css).toContain("var(--card)"); expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
  it("o painel é somente leitura: não importa nenhum endpoint de escrita", () => {
    const src = readFileSync("src/components/FileScanOperationsPanel.tsx", "utf8"); expect(src).not.toMatch(/_POST|useMutation/); expect(src).toContain("file-scan-operations_GET.schema");
  });
});

describe("CSS do painel — tokens (defeito encontrado na prévia real: `--spacing-5` não existe e o espaçamento era descartado em silêncio)", () => {
  it("todo `var(--token)` usado existe em base.css (ou tem valor de reserva)", () => {
    const css = readFileSync("src/components/FileScanOperationsPanel.module.css", "utf8"); const base = readFileSync("src/base.css", "utf8");
    const used = [...css.matchAll(/var\((--[a-z0-9-]+)(,[^)]*)?\)/g)]; expect(used.length).toBeGreaterThan(10);
    for (const m of used) if (!m[2]) expect(base, `token ${m[1]}`).toContain(`${m[1]}:`);
  });
  it("<dd> dentro das métricas zera a margem padrão do navegador (senão a dica fica recuada 40 px)", () => { expect(readFileSync("src/components/FileScanOperationsPanel.module.css", "utf8")).toMatch(/\.metric dd \{ margin: 0; \}/); });
});
