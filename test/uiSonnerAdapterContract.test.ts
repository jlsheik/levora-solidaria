// @vitest-environment jsdom
/**
 * M19 — CONTRATO do adaptador do Sonner (B3) + ciclo de vida do controlador (B1/B4).
 * Renderiza o Sonner REAL e verifica a estrutura de DOM de que o app depende. Se o Sonner for atualizado e a estrutura mudar, este arquivo falha e obriga a revisar `sonnerAdapter.ts`.
 * Também prova: nenhum efeito colateral na importação; instalação/desinstalação da política; contagem de referências (duas instâncias, uma continua ao desmontar a outra); limpeza total.
 * Não é homologação com leitor de tela: só a estrutura/semântica do DOM é verificada.
 */
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { toast } from "sonner";
import { readFileSync } from "node:fs";
import { SONNER_SELECTORS, SONNER_TESTED_VERSION, findRegions, applyToastSemantics, toastRole, CLOSE_LABEL_PT } from "../src/components/sonnerAdapter";
import { toastControllerStats } from "../src/components/toastController";
import { SonnerToaster } from "../src/components/SonnerToaster";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const roots: { root: Root; host: HTMLElement }[] = [];
async function mountToaster() { const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host); roots.push({ root, host }); await act(async () => { root.render(React.createElement(SonnerToaster)); }); return { root, host }; }
afterEach(() => { for (const r of roots.splice(0)) { act(() => r.root.unmount()); r.host.remove(); } toast.dismiss(); });
const html = () => document.documentElement;

describe("contrato com o Sonner instalado", () => {
  it("a versão instalada é a testada (atualizar o Sonner exige revisar sonnerAdapter.ts)", () => {
    const v = JSON.parse(readFileSync("node_modules/sonner/package.json", "utf8")).version; expect(v).toBe(SONNER_TESTED_VERSION);
  });
  it("o Sonner renderiza a região persistente (section aria-live=polite) ANTES de qualquer aviso, com o rótulo 'Avisos'", async () => {
    await mountToaster(); const regions = findRegions(); expect(regions.length).toBe(1);
    expect(regions[0].getAttribute("aria-live")).toBe("polite"); expect(regions[0].getAttribute("aria-label")).toMatch(/^Avisos/); expect(regions[0].querySelector(SONNER_SELECTORS.toast)).toBeNull();
  });
  it("um aviso é um <li data-sonner-toast data-type=…> dentro de <ol data-sonner-toaster>, com botão de fechar [data-close-button]", async () => {
    await mountToaster(); await act(async () => { toast.error("Falhou"); await tick(150); });
    const li = document.querySelector(SONNER_SELECTORS.toast) as HTMLElement; expect(li).toBeTruthy(); expect(li.tagName).toBe("LI"); expect(li.getAttribute("data-type")).toBe("error");
    expect(li.closest(SONNER_SELECTORS.toaster)?.tagName).toBe("OL"); expect(li.querySelector(SONNER_SELECTORS.closeButton)).toBeTruthy();
    expect(li.hasAttribute("data-front")).toBe(true); expect(li.hasAttribute("data-visible")).toBe(true);
  });
  it("ao dispensar, o aviso passa por data-removed=true antes de sair do DOM", async () => {
    await mountToaster(); await act(async () => { toast("Olá"); await tick(150); }); const li = document.querySelector(SONNER_SELECTORS.toast) as HTMLElement;
    await act(async () => { toast.dismiss(); await tick(30); }); expect(li.getAttribute("data-removed")).toBe("true");
  });
  it("papéis: erro=alert, demais=status; idempotente; rótulo do botão em português", async () => {
    expect(toastRole("error")).toBe("alert"); for (const t of ["success", "info", "warning", "loading", "default", null]) expect(toastRole(t)).toBe("status");
    await mountToaster(); await act(async () => { toast.warning("Atenção"); await tick(150); }); const li = document.querySelector(SONNER_SELECTORS.toast) as HTMLElement;
    expect(li.getAttribute("role")).toBe("status"); applyToastSemantics(li); applyToastSemantics(li); expect(li.getAttribute("role")).toBe("status"); expect(li.querySelector(SONNER_SELECTORS.closeButton)!.getAttribute("aria-label")).toBe(CLOSE_LABEL_PT);
  });
  it("nenhum outro arquivo do app conhece os seletores internos do Sonner (só o adaptador)", () => {
    for (const f of ["src/components/SonnerToaster.tsx", "src/components/toastController.ts"]) expect(readFileSync(f, "utf8")).not.toMatch(/data-sonner|data-close-button|data-removed|data-visible|data-front/);
  });
});

describe("ciclo de vida do controlador", () => {
  it("importar o módulo não altera o `toast` do Sonner (sem efeito colateral na importação)", () => { expect((toast as unknown as Record<string, unknown>).__levoraDurationPolicy).toBeUndefined(); });
  it("montar instala a política; desmontar a desinstala e restaura as funções originais", async () => {
    const before = { success: toast.success, error: toast.error };
    const m = await mountToaster(); expect((toast as unknown as Record<string, unknown>).__levoraDurationPolicy).toBe(true); expect(toast.error).not.toBe(before.error);
    await act(async () => { m.root.unmount(); }); roots.length = 0; m.host.remove();
    expect((toast as unknown as Record<string, unknown>).__levoraDurationPolicy).toBeUndefined(); expect(toast.success).toBe(before.success); expect(toast.error).toBe(before.error);
    expect(toastControllerStats().refs).toBe(0);
  });
  it("duas instâncias compartilham um só controlador; desmontar uma mantém a outra funcionando; desmontar a última limpa tudo", async () => {
    const a = await mountToaster(); const b = await mountToaster(); expect(toastControllerStats().refs).toBe(2);
    await act(async () => { a.root.unmount(); }); a.host.remove(); expect(toastControllerStats().refs).toBe(1); expect((toast as unknown as Record<string, unknown>).__levoraDurationPolicy).toBe(true);
    await act(async () => { toast.error("Ainda funciona"); await tick(150); }); expect(document.querySelector(SONNER_SELECTORS.toast)?.getAttribute("role")).toBe("alert");
    await act(async () => { b.root.unmount(); }); b.host.remove(); roots.length = 0;
    expect(toastControllerStats().refs).toBe(0); expect((toast as unknown as Record<string, unknown>).__levoraDurationPolicy).toBeUndefined(); expect(html().hasAttribute("data-toast-reserve")).toBe(false);
  });
  it("depois de desmontar, mutações e eventos globais não chamam mais nada (observadores e ouvintes desligados)", async () => {
    const m = await mountToaster(); await act(async () => { m.root.unmount(); }); roots.length = 0; m.host.remove();
    const before = toastControllerStats().observerCallbacks; const d = document.createElement("div"); document.body.appendChild(d); d.appendChild(document.createElement("i"));
    window.dispatchEvent(new Event("resize")); document.dispatchEvent(new Event("animationend", { bubbles: true })); await tick(80); d.remove();
    expect(toastControllerStats().observerCallbacks).toBe(before);
  });
});
