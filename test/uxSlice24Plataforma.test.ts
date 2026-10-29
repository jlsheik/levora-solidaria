// @vitest-environment jsdom
/**
 * Slice de UX (Ciclo 24) — comportamento REAL em DOM do diálogo "Cadastrar fonte" (página de plataforma):
 * o campo "Tipo" (z.enum, sem valor inicial) mostra a mensagem pt-BR e não expõe o enum; um valor válido continua sendo enviado como está.
 * Os selects de urgência (padrão "media") e de movimentação de estoque (padrão "entrada") sempre têm valor válido na interface,
 * por isso a mensagem deles não é alcançável pela UI — ficam cobertos pela verificação estática de test/uxSlice24.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("../src/endpoints/sources_GET.schema", () => ({ getSources: async () => ({ sources: [] }) }));
vi.mock("../src/endpoints/sources_POST.schema", () => ({ postSources: (...a: unknown[]) => api.post(...a) }));

import PlatformPage from "../src/pages/plataforma";

const h = React.createElement;
let container: HTMLElement;
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const buttonByText = (t: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === t) as HTMLButtonElement;
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
const dialogMessages = () => Array.from(document.querySelectorAll('[role="dialog"] p')).map((p) => p.textContent ?? "");

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.post.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root.render(h(QueryClientProvider, { client: qc }, h(MemoryRouter, null, h(PlatformPage)))); });
  await flush();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe('diálogo "Cadastrar fonte": campo "Tipo"', () => {
  it("envio sem Tipo: mostra a mensagem pt-BR sob o rótulo Tipo, sem texto padrão do zod nem valores do enum, e não chama a API", async () => {
    await click(buttonByText("Nova fonte"));
    await click(buttonByText("Cadastrar"));
    await flush();
    const ps = Array.from(document.querySelectorAll('[role="dialog"] p')).filter((p) => p.textContent === "Selecione o tipo da fonte");
    expect(ps).toHaveLength(1);
    expect(ps[0].parentElement!.textContent).toMatch(/^Tipo/);
    for (const m of dialogMessages()) expect(m).not.toMatch(/Invalid option|expected one of|site_publico|pesquisa_externa|facebook_meta/);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("Tipo válido escolhido: a mensagem some e a API recebe o valor do enum inalterado", async () => {
    api.post.mockResolvedValue({ source: { id: 1, name: "Fonte QA", status: "ativa" } });
    await click(buttonByText("Nova fonte"));
    await act(async () => {
      const el = document.querySelector<HTMLInputElement>('[role="dialog"] input:not([placeholder])')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, "Fonte QA");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const trigger = document.querySelector<HTMLButtonElement>('[role="dialog"] button[role="combobox"]')!;
    await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await flush();
    const opt = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((o) => o.textContent === "Site público")!;
    await act(async () => { opt.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })); opt.click(); });
    await flush();
    await click(buttonByText("Cadastrar"));
    await flush();
    expect(dialogMessages()).not.toContain("Selecione o tipo da fonte");
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post.mock.calls[0][0]).toMatchObject({ name: "Fonte QA", type: "site_publico", connectorKey: "manual" });
  });
});
