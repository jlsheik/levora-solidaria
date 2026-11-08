// @vitest-environment jsdom
/**
 * M11 / R10 (residual) — comportamento do SonnerToaster com um diálogo aberto: define `--toast-reserve` e `data-toast-reserve` no <html> (o CSS do diálogo faz o resto) e os remove
 * quando o aviso some ou não há sobreposição. Geometria simulada com as medidas reais do navegador (375×812). Sem banco, sem navegador real.
 * O comportamento visual (diálogo acima do aviso, sem sobreposição) é provado pela matriz funcional real (visual-matrix-dropzone-func.mjs).
 */
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { toast } from "sonner";
import { readFileSync } from "node:fs";
import { SonnerToaster } from "../src/components/SonnerToaster";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement | null = null; let root: Root | null = null; let dialog: HTMLDivElement | null = null;
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const setViewport = (w: number, h: number) => { Object.defineProperty(window, "innerWidth", { value: w, configurable: true }); Object.defineProperty(window, "innerHeight", { value: h, configurable: true }); };
const rectOf = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;

/** Monta o toaster, um diálogo simulado (role=dialog + data-toast-aware) e um aviso; o jsdom não faz layout, então as medidas são fornecidas. */
async function mount(opts: { withDialog: boolean; aware?: boolean; toastHeight: number }) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  if (opts.withDialog) {
    dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); if (opts.aware !== false) dialog.setAttribute("data-toast-aware", "");
    dialog.getBoundingClientRect = () => rectOf(18, 36.9, 339, 738.2); Object.defineProperty(dialog, "scrollHeight", { value: 738.2, configurable: true });
    document.body.appendChild(dialog);
  }
  const proto = HTMLElement.prototype as unknown as { getBoundingClientRect: () => DOMRect };
  const origRect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) { return this.hasAttribute("data-sonner-toast") ? rectOf(16, 600, 343, opts.toastHeight) : origRect.call(this); };
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return (this as HTMLElement).hasAttribute("data-sonner-toast") ? opts.toastHeight : 0; } });
  await act(async () => { root!.render(React.createElement(SonnerToaster)); });
  await act(async () => { toast("Falha ao enviar o comprovante"); await tick(150); });
  await act(async () => { window.dispatchEvent(new Event("resize")); await tick(150); });
  return () => { proto.getBoundingClientRect = origRect; delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight; };
}
let restore: (() => void) | null = null;
afterEach(() => { act(() => root?.unmount()); restore?.(); restore = null; host?.remove(); dialog?.remove(); host = null; root = null; dialog = null; toast.dismiss(); });
const html = () => document.documentElement;

describe("SonnerToaster × diálogo (R10 residual)", () => {
  it("375×812 com diálogo e aviso de 202 px: reserva de 226 px no <html> (medido no Chrome)", async () => {
    setViewport(375, 812); restore = await mount({ withDialog: true, toastHeight: 202 });
    expect(document.querySelector("[data-sonner-toast]")).toBeTruthy();
    expect(html().hasAttribute("data-toast-reserve")).toBe(true); expect(html().style.getPropertyValue("--toast-reserve")).toBe("226px");
  });
  it("sem diálogo aberto: nada é definido", async () => {
    setViewport(375, 812); restore = await mount({ withDialog: false, toastHeight: 202 });
    expect(document.querySelector("[data-sonner-toast]")).toBeTruthy();
    expect(html().hasAttribute("data-toast-reserve")).toBe(false); expect(html().style.getPropertyValue("--toast-reserve")).toBe("");
  });
  it("diálogo que não é do componente Dialog (sem data-toast-aware, ex.: Sheet): o toaster não mexe", async () => {
    setViewport(375, 812); restore = await mount({ withDialog: true, aware: false, toastHeight: 202 });
    expect(html().hasAttribute("data-toast-reserve")).toBe(false);
  });
  it("ao desmontar o toaster, a reserva é removida do <html>", async () => {
    setViewport(375, 812); restore = await mount({ withDialog: true, toastHeight: 202 }); expect(html().hasAttribute("data-toast-reserve")).toBe(true);
    await act(async () => { root!.unmount(); await tick(30); }); root = null;
    expect(html().hasAttribute("data-toast-reserve")).toBe(false); expect(html().style.getPropertyValue("--toast-reserve")).toBe("");
  });
});

describe("CSS do diálogo × reserva (estático)", () => {
  const css = readFileSync("src/components/Dialog.module.css", "utf8");
  it("só age com o atributo no <html> e usa a variável para posição e altura máxima", () => {
    expect(css).toContain("html[data-toast-reserve]");
    expect(css).toContain("top: calc(50% - var(--toast-reserve) / 2)");
    expect(css).toContain("max-height: min(85vh, calc(100vh - var(--toast-reserve)");
  });
  it("o max-height padrão (sem reserva) continua 85vh e a geometria inteira do R12 foi mantida", () => {
    expect(css).toContain("max-height: 85vh;");
    expect(css).toContain("round(down, 5vw, 1px)");
  });
  it("Dialog marca o conteúdo com data-toast-aware e o rodapé com data-dialog-footer", () => {
    const tsx = readFileSync("src/components/Dialog.tsx", "utf8");
    expect(tsx).toContain('data-toast-aware=""'); expect(tsx).toContain('data-dialog-footer=""');
  });
});

describe('M12 — medição ao fim da animação e botão "Fechar aviso"', () => {
  it("o aviso medido DURANTE o deslize (fora da coluna do diálogo) não define reserva; ao fim da animação (animationend) a reserva é aplicada", async () => {
    setViewport(1280, 900); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); dialog.setAttribute("data-toast-aware", "");
    dialog.getBoundingClientRect = () => rectOf(360, 43.5, 560, 813); Object.defineProperty(dialog, "scrollHeight", { value: 991, configurable: true });
    const cs = window.getComputedStyle.bind(window); window.getComputedStyle = ((el: Element) => { const o = cs(el); return el === dialog ? new Proxy(o, { get: (t, k) => (k === "paddingLeft" || k === "paddingRight" || k === "paddingTop" || k === "paddingBottom" ? "24px" : (t as unknown as Record<string, unknown>)[k as string]) }) : o; }) as typeof window.getComputedStyle;
    document.body.appendChild(dialog); let sliding = true;
    const proto = HTMLElement.prototype as unknown as { getBoundingClientRect: () => DOMRect }; const origRect = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: HTMLElement) { return this.hasAttribute("data-sonner-toast") ? rectOf(sliding ? 1268 : 892, 786, 360, 82) : origRect.call(this); };
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return (this as HTMLElement).hasAttribute("data-sonner-toast") ? 82 : 0; } });
    restore = () => { proto.getBoundingClientRect = origRect; window.getComputedStyle = cs; delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight; };
    await act(async () => { root!.render(React.createElement(SonnerToaster)); });
    await act(async () => { toast("Falha ao enviar o comprovante"); await tick(150); });
    await act(async () => { await tick(800); }); // deixa passar toda medição espontânea (montagem, alturas) ENQUANTO o aviso ainda está "deslizando"
    expect(html().hasAttribute("data-toast-reserve")).toBe(false); // medido durante o deslize: fora da coluna do diálogo
    sliding = false; const t = document.querySelector("[data-sonner-toast]") as HTMLElement;
    await act(async () => { t.dispatchEvent(new Event("animationend", { bubbles: true })); await tick(100); });
    expect(html().hasAttribute("data-toast-reserve")).toBe(true); expect(html().style.getPropertyValue("--toast-reserve")).toBe("122px"); // 32 (deslocamento padrão) + 82 (aviso) + 8 (folga)
  });
  it("o botão de fechar fica visível e o texto do rótulo é traduzido para português", async () => {
    setViewport(375, 812); restore = await mount({ withDialog: false, toastHeight: 82 });
    const btn = document.querySelector("[data-sonner-toaster] [data-close-button]"); expect(btn).toBeTruthy();
    await act(async () => { window.dispatchEvent(new Event("resize")); await tick(60); });
    expect(btn!.getAttribute("aria-label")).toBe("Fechar aviso"); expect(document.querySelector("[data-sonner-toaster]")?.closest("section")?.getAttribute("aria-label")).toMatch(/^Avisos/);
  });
});

describe("M12 — CSS dos avisos (estático)", () => {
  const css = readFileSync("src/components/SonnerToaster.module.css", "utf8").split("\r\n").join("\n");
  const layerEnd = css.indexOf("html .toaster .toast .closeButton[data-close-button] {"); // início do bloco FORA de @layer
  it("o botão de fechar é estilizado FORA de @layer (o CSS do Sonner não é camadado e venceria) e com área de toque de 44 px", () => {
    const afterLayer = css.slice(layerEnd);
    expect(afterLayer).toContain("[data-close-button]"); expect(afterLayer).toContain("inset: -10px"); expect(afterLayer).toContain("var(--muted-foreground)");
    expect(css.slice(0, layerEnd)).not.toMatch(/\.closeButton\s*\{/);
  });
  it("o ponteiro só volta ao aviso quando existe um Dialog com data-toast-aware (Sheet e Command não são afetados)", () => {
    expect(css).toContain('body:has([role="dialog"][data-toast-aware])'); expect(css).toContain("pointer-events: auto");
  });
  it("DialogContent ignora a interação externa quando o alvo está dentro do toaster e ainda chama o handler de quem usa", () => {
    const tsx = readFileSync("src/components/Dialog.tsx", "utf8");
    expect(tsx).toContain('closest("[data-sonner-toaster]")'); expect(tsx).toContain("props.onInteractOutside?.(event)"); expect(tsx).toContain("event.preventDefault()");
  });
  it("Sheet e Command não foram alterados para os avisos", () => {
    for (const f of ["src/components/Sheet.tsx", "src/components/Command.tsx"]) expect(readFileSync(f, "utf8")).not.toMatch(/sonner|toast-aware|isToastTarget/);
  });
});

describe("M13 — teclado e semântica dos avisos sob diálogo modal", () => {
  const press = (init: KeyboardEventInit) => { const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }); document.dispatchEvent(e); return e; };
  const visible = () => [...document.querySelectorAll("[data-sonner-toast]")].filter((t) => t.getAttribute("data-removed") !== "true").length;
  it("Alt+T com um Dialog aberto dispensa os avisos SEM mover o foco e cancela o evento; Alt+T sem Dialog não é interceptado", async () => {
    setViewport(1280, 900); restore = await mount({ withDialog: true, toastHeight: 82 }); const inner = document.createElement("button"); dialog!.appendChild(inner); inner.focus();
    expect(visible()).toBe(1);
    let e!: KeyboardEvent; await act(async () => { e = press({ altKey: true, code: "KeyT", key: "t" }); await tick(400); });
    expect(e.defaultPrevented).toBe(true); expect(visible()).toBe(0); expect(document.activeElement).toBe(inner); // foco continua dentro do diálogo
  });
  it("sem Dialog, Alt+T não é cancelado e o aviso permanece (é o atalho do Sonner para focar a região)", async () => {
    setViewport(1280, 900); restore = await mount({ withDialog: false, toastHeight: 82 }); let e!: KeyboardEvent; await act(async () => { e = press({ altKey: true, code: "KeyT", key: "t" }); await tick(200); });
    expect(e.defaultPrevented).toBe(false); expect(visible()).toBe(1);
  });
  it("outras combinações (Alt+Shift+T, Ctrl+Alt+T, T sozinho) não dispensam nada", async () => {
    setViewport(1280, 900); restore = await mount({ withDialog: true, toastHeight: 82 });
    await act(async () => { press({ altKey: true, shiftKey: true, code: "KeyT" }); press({ altKey: true, ctrlKey: true, code: "KeyT" }); press({ code: "KeyT" }); await tick(200); }); expect(visible()).toBe(1);
  });
  it("erro recebe role=alert e informativo role=status ASSIM QUE inserido (sem depender de resize/medição); nenhum texto de atalho é injetado por aviso", async () => {
    setViewport(1280, 900); restore = await mount({ withDialog: false, toastHeight: 82 });
    await act(async () => { toast.error("Falhou"); toast.success("Ok"); await tick(300); });
    const roles = [...document.querySelectorAll("[data-sonner-toast]")].map((t) => `${t.getAttribute("data-type")}:${t.getAttribute("role")}`);
    expect(roles).toContain("error:alert"); expect(roles).toContain("success:status");
    expect(document.querySelector("[data-toast-hint]")).toBeNull(); // M19: o atalho não é repetido em cada aviso; a região (aria-live) já o traz no rótulo
  });
});
