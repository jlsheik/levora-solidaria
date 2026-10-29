/**
 * Slice de UX (Ciclo 24) — favicon, mensagens pt-BR dos z.enum e box-sizing das .page de organização.
 * Verificações estáticas sobre os arquivos reais; nenhuma regra de negócio é alterada.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("favicon", () => {
  it("existe em public/ e é referenciado pelo index.html (CSP img-src 'self')", () => {
    expect(existsSync("public/favicon.svg")).toBe(true);
    expect(read("index.html")).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"\s*\/>/);
  });
});

describe("z.enum com mensagem pt-BR", () => {
  it("plataforma.tsx e inventário não usam z.enum sem { error }", () => {
    for (const f of ["src/pages/plataforma.tsx", "src/pages/organizacoes.$organizationId.inventario.tsx"]) {
      const src = read(f);
      const enums = src.match(/z\.enum\([^)]*\)/g) ?? [];
      expect(enums.length).toBeGreaterThan(0);
      for (const e of enums) expect(e, `${f}: ${e}`).toContain("error:");
    }
  });
});

describe("páginas de organização", () => {
  it("toda .page com min-height:100vh declara box-sizing:border-box", () => {
    const files = readdirSync("src/pages").filter((f) => /^organizacoes\..*\.module\.css$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const block = read(`src/pages/${f}`).match(/^\.page \{[^}]*\}/m)?.[0];
      if (block && /min-height:\s*100vh/.test(block)) expect(block, f).toMatch(/box-sizing:\s*border-box/);
      // border-box inclui o padding no max-width: compensa para a largura da página (72rem de conteúdo) não encolher
      if (block && /padding:\s*var\(--spacing-8\);/.test(block)) expect(block, f).toMatch(/max-width:\s*calc\(72rem \+ 2 \* var\(--spacing-8\)\)/);
    }
  });
});
