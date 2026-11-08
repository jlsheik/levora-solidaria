// @vitest-environment jsdom
/**
 * M19 — custo do observador do SonnerToaster (correção da M18/B1): mutações de DOM sem relação com os avisos (a aplicação inteira vive sob <body>) não podem disparar
 * varreduras síncronas do documento. Mede, em rajadas de mutações alheias, (a) chamadas do callback do MutationObserver e (b) chamadas a querySelectorAll.
 * `QA_M19_MEASURE_OUT` (opcional) grava as medidas em JSON (usado para registrar antes/depois). Sem banco, sem navegador real; jsdom não mede tempo de layout.
 */
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { toast } from "sonner";
import { appendFileSync } from "node:fs";
import { SonnerToaster } from "../src/components/SonnerToaster";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
let host: HTMLDivElement | null = null; let root: Root | null = null; let app: HTMLDivElement | null = null;

const counters = { observerCallbacks: 0, queries: 0 };
const RealMO = globalThis.MutationObserver;
const origDocQ = Document.prototype.querySelectorAll; const origElQ = Element.prototype.querySelectorAll;
function instrument() {
  counters.observerCallbacks = 0; counters.queries = 0;
  globalThis.MutationObserver = class extends RealMO { constructor(cb: MutationCallback) { super((records, obs) => { counters.observerCallbacks++; cb(records, obs); }); } } as typeof MutationObserver;
  Document.prototype.querySelectorAll = function (this: Document, ...a: [string]) { counters.queries++; return origDocQ.apply(this, a); } as typeof origDocQ;
  Element.prototype.querySelectorAll = function (this: Element, ...a: [string]) { counters.queries++; return origElQ.apply(this, a); } as typeof origElQ;
}
function restoreInstrument() { globalThis.MutationObserver = RealMO; Document.prototype.querySelectorAll = origDocQ; Element.prototype.querySelectorAll = origElQ; }

/** Simula a aplicação: nós e atributos mudando FORA do toaster, em tarefas separadas (como uma barra de progresso ou um re-render a cada quadro): uma mutação por tarefa. */
async function unrelatedStream(n: number) {
  app = document.createElement("div"); const inner = document.createElement("div"); app.appendChild(inner); document.body.appendChild(app);
  for (let i = 0; i < n; i++) {
    await act(async () => { const s = document.createElement("span"); s.setAttribute("data-state", i % 2 ? "open" : "closed"); inner.appendChild(s); s.setAttribute("data-visible", "false"); s.setAttribute("data-front", "true"); if (i % 3 === 0) s.remove(); });
    await tick(1);
  }
  await tick(60);
}
const record = (name: string, extra: object = {}) => { if (process.env.QA_M19_MEASURE_OUT) appendFileSync(process.env.QA_M19_MEASURE_OUT, JSON.stringify({ cenario: name, ...counters, ...extra }) + "\n"); };

afterEach(() => { act(() => root?.unmount()); restoreInstrument(); host?.remove(); app?.remove(); host = null; root = null; app = null; toast.dismiss(); });
const reset = () => { counters.observerCallbacks = 0; counters.queries = 0; };
async function mount() { instrument(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); await act(async () => { root!.render(React.createElement(SonnerToaster)); }); await tick(60); }

describe("M19 — custo do observador diante de mutações alheias", () => {
  it("sem avisos: 300 mutações alheias (100 tarefas) não geram varreduras do documento", async () => {
    await mount(); reset(); await unrelatedStream(100); const q = counters.queries; record("sem-avisos-100-tarefas-300-mutacoes");
    expect(q).toBeLessThanOrEqual(5); // orçamento constante: nenhuma varredura por tarefa
  });
  it("com um aviso visível: mutações alheias (atributos observados fora do toaster) não geram varredura do documento", async () => {
    await mount(); await act(async () => { toast("Falha ao enviar o comprovante"); await tick(150); }); reset(); await unrelatedStream(100); const q = counters.queries; record("com-aviso-100-tarefas-300-mutacoes");
    expect(q).toBeLessThanOrEqual(5);
  });
  it("o callback do observador não roda para atributos alheios ao toaster", async () => {
    await mount(); reset(); await act(async () => { app = document.createElement("div"); document.body.appendChild(app); await tick(30); });
    const base = counters.observerCallbacks; await act(async () => { for (let i = 0; i < 300; i++) app!.setAttribute("data-state", i % 2 ? "open" : "closed"); await tick(60); });
    record("atributos-alheios-300", { callbacksAposBase: counters.observerCallbacks - base });
    expect(counters.observerCallbacks - base).toBe(0); // atributos fora do toaster nem chegam ao callback
  });
});
