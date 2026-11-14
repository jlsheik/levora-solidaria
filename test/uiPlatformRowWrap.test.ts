/**
 * M47 — achado no Chrome real: a 375 px a página da plataforma tinha 5 px de overflow horizontal (linhas de fontes/ofertas/tarefas com ações que não quebravam de linha).
 * Regressão estática; a prova comportamental é a varredura responsiva (overflow = 0 a 375/390/768/1280 px, claro e escuro).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const css = readFileSync(path.resolve(__dirname, "../src/pages/plataforma.module.css"), "utf-8");
describe("plataforma: linhas de lista não estouram a largura em telas estreitas", () => {
  it(".sourceRow quebra linha e o bloco de texto pode encolher", () => {
    const rule = css.match(/\.sourceRow\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.sourceRow\s*>\s*:first-child\s*\{[^}]*min-width:\s*0/);
  });
});
