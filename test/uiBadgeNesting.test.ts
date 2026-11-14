/**
 * M47 — achado no navegador real (Chrome e Edge): o React avisava "validateDOMNesting: <div> não pode ser descendente de <p>" porque o Badge renderiza <div>.
 * Regressão estática: nenhum componente coloca <Badge> dentro de <p> (o Badge é um <div>).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith(".tsx")) out.push(p); }
  return out;
}
describe("Badge (renderiza <div>) nunca aparece dentro de <p>", () => {
  it("nenhum .tsx de src tem <p ...>…<Badge…> na mesma linha ou até o </p> seguinte", () => {
    const offenders: string[] = [];
    for (const file of walk(path.resolve(__dirname, "../src"))) {
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(/<p(\s[^>]*)?>((?:(?!<\/p>)[\s\S])*?)<Badge\b/g)) offenders.push(`${path.relative(path.resolve(__dirname, ".."), file)}: ${m[0].slice(0, 80).replace(/\s+/g, " ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
