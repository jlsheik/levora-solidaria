/**
 * M08 (R8): a pílula de status da tabela "Atendimento das necessidades" (Prestação de contas) NÃO herda a fonte monoespaçada de `.table td`.
 * Teste estático (CSS/TSX), sem banco nem navegador; a verificação visual real (antes/depois, Chrome e Edge) está nas evidências da M08.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(__dirname, "../src/pages");
const css = readFileSync(path.join(dir, "organizacoes.$organizationId.prestacao-contas.module.css"), "utf8");
const tsx = readFileSync(path.join(dir, "organizacoes.$organizationId.prestacao-contas.tsx"), "utf8");
const rule = (sel: string) => { const i = css.indexOf(sel + " {"); return i < 0 ? null : css.slice(i, css.indexOf("}", i) + 1); };

describe("Prestação de contas: pílula de status (R8)", () => {
  it("`.table td` continua monoespaçada (valores numéricos) e `.table td:first-child` continua com a fonte do corpo", () => {
    expect(rule(".table td")).toMatch(/font-family: var\(--font-family-monospace\)/); expect(rule(".table td:first-child")).toMatch(/font-family: var\(--font-family-base\)/);
  });
  it("`.table td.statusCell` usa a fonte do corpo e vem DEPOIS de `.table td`, com especificidade maior (sem !important)", () => {
    const r = rule(".table td.statusCell"); expect(r).toBeTruthy(); expect(r).toMatch(/font-family: var\(--font-family-base\)/); expect(r).not.toMatch(/!important/);
    expect(css.indexOf(".table td.statusCell {")).toBeGreaterThan(css.indexOf(".table td {"));
  });
  it("a célula da pílula de status (e só ela) recebe `styles.statusCell`; o texto e a variante semântica do Badge não mudaram", () => {
    expect((tsx.match(/styles\.statusCell/g) ?? []).length).toBe(1);
    const i = tsx.indexOf("styles.statusCell"); const trecho = tsx.slice(i, i + 700); expect(trecho).toContain("<Badge variant={n.status === \"atendida\" ? \"success\" : n.status === \"cancelada\" ? \"destructive\" : \"outline\"}>"); expect(trecho).toContain("STATUS_LABELS[n.status]");
  });
  it("nenhuma outra regra de fonte da página foi alterada para resolver o problema", () => {
    expect((css.match(/font-family: var\(--font-family-monospace\)/g) ?? []).length).toBeGreaterThan(0); expect(css).not.toMatch(/\.table td\s*\{[^}]*font-family: var\(--font-family-base\)/);
  });
});
