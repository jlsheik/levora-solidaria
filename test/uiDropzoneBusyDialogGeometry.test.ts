// @vitest-environment jsdom
/**
 * M10 — R11 (texto "Enviando…" legível) e R12 (geometria inteira do diálogo). Sem banco, sem navegador real: componente real em jsdom + contrato estático do CSS.
 * Os valores de contraste e a estabilidade de pixels são MEDIDOS no navegador real (ver relatório M10); aqui fica a trava contra regressão do contrato.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FileDropzone } from "../src/components/FileDropzone";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const read = (rel: string) => readFileSync(path.resolve(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const block = (css: string, selector: string) => { const i = css.indexOf(selector + " {"); if (i < 0) return ""; return css.slice(i, css.indexOf("}", i) + 1); };

let host: HTMLDivElement; let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("R11 — estado de progresso da dropzone", () => {
  it("CSS: a dropzone desabilitada comum NÃO mudou (opacity 0.5, não-permitido, sem ponteiro)", () => {
    const d = block(read("src/components/FileDropzone.module.css"), ".dropzone.disabled");
    expect(d).toContain("opacity: 0.5"); expect(d).toContain("cursor: not-allowed"); expect(d).toContain("pointer-events: none");
  });
  it("CSS: só com `.busy` o texto volta à opacidade plena; ícone e borda ficam esmaecidos; cursor de progresso", () => {
    const css = read("src/components/FileDropzone.module.css");
    const b = block(css, ".dropzone.disabled.busy"); expect(b).toContain("opacity: 1"); expect(b).toContain("cursor: progress"); expect(b).toContain("color-mix(in srgb, var(--input-border), transparent 50%)");
    expect(block(css, ".dropzone.disabled.busy .icon")).toContain("opacity: 0.5");
    expect(css.indexOf(".dropzone.disabled {")).toBeLessThan(css.indexOf(".dropzone.disabled.busy {")); // a regra específica vem depois (mesma especificidade que não vence: tem mais classes)
  });
  it("CSS: o texto de status não recebe opacidade própria (título e subtítulo mantêm as cores dos tokens)", () => {
    const css = read("src/components/FileDropzone.module.css");
    expect(block(css, ".title")).not.toContain("opacity"); expect(block(css, ".subtitle")).not.toContain("opacity");
  });
  it("componente: `busy` aplica a classe, anuncia por região viva e NÃO usa aria-busy (que adiaria o anúncio)", () => {
    act(() => { root.render(React.createElement(FileDropzone, { disabled: true, busy: true, title: "Enviando..." })); });
    const label = host.querySelector("label")!; expect(/busy/.test(label.className)).toBe(true); expect(/disabled/.test(label.className)).toBe(true);
    expect(label.hasAttribute("aria-busy")).toBe(false);
    const title = host.querySelector("span[aria-live]")!; expect(title.getAttribute("aria-live")).toBe("polite"); expect(title.textContent).toBe("Enviando...");
    expect(host.querySelector("input")!.disabled).toBe(true);
  });
  it("componente: sem `busy` nada muda (sem classe busy, sem região viva)", () => {
    act(() => { root.render(React.createElement(FileDropzone, { disabled: true, title: "x" })); });
    const label = host.querySelector("label")!; expect(/busy/.test(label.className)).toBe(false); expect(host.querySelector("span[aria-live]")).toBeNull();
  });
  it("Atribuições passa `busy` junto de `disabled` (o outro consumidor segue como antes)", () => {
    expect(read("src/pages/organizacoes.$organizationId.atribuicoes.tsx")).toContain("busy={uploadProofMutation.isPending}");
    expect(read("src/components/DestinationProofDialogs.tsx")).not.toContain("busy=");
  });
});

describe("R12 — geometria inteira do diálogo", () => {
  it("a largura máxima usa margem lateral arredondada a pixel inteiro e mantém a linha antiga como reserva (sem round())", () => {
    const css = read("src/components/Dialog.module.css"); const content = block(css, ".content");
    const legacy = content.indexOf("max-width: calc(90vw - 2 * var(--spacing-6));"); const novo = content.indexOf("max-width: calc(100vw - 2 * round(down, 5vw, 1px) - 2 * var(--spacing-6));");
    expect(legacy).toBeGreaterThan(-1); expect(novo).toBeGreaterThan(legacy); // reserva antes; a declaração nova vence onde round() existe
  });
  it("a centralização e a largura de telas largas continuam como estavam (translate(-50%,-50%); width 32rem)", () => {
    const content = block(read("src/components/Dialog.module.css"), ".content");
    expect(content).toContain("transform: translate(-50%, -50%)"); expect(content).toContain("width: 32rem");
  });
  it("aritmética: com a margem arredondada, a largura e o x do diálogo são inteiros em janelas ímpares e pares (sem meio pixel horizontal)", () => {
    const largura = (vw: number) => vw - 2 * Math.floor(0.05 * vw); // 100vw − 2·round(down, 5vw, 1px)
    for (const vw of [320, 360, 375, 377, 390, 412, 414, 428, 480, 599]) { const w = largura(vw); expect(Number.isInteger((vw - w) / 2)).toBe(true); expect(w).toBeLessThanOrEqual(vw); expect(w).toBeGreaterThanOrEqual(0.9 * vw - 1e-9); }
    expect((375 - largura(375)) / 2).toBe(18); expect(largura(375)).toBe(339); // medido no navegador: x=18, largura 339 (antes 18,75 / 337,5)
  });
});
