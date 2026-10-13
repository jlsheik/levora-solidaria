/**
 * Comprovante (`proofUrl`): só caminho relativo do app ou http(s). Achado de `npm run qa:security` (Fase 94): o servidor gravava qualquer string
 * (inclusive `javascript:`), a interface a renderizava em `<a href>` e o React 18 não bloqueia esse esquema.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isAllowedProofUrl } from "../src/helpers/proofUrl";
import { schema } from "../src/endpoints/allocations-receive_POST.schema";

describe("isAllowedProofUrl", () => {
  it("aceita http(s) e caminho relativo do próprio app (inclusive o download de arquivo do sistema)", () => {
    for (const ok of ["https://exemplo.org/recibo.pdf", "http://exemplo.org/a?b=1#c", "/_api/v1/files-download?fileId=12", "  https://exemplo.org/x  "]) expect(isAllowedProofUrl(ok), ok).toBe(true);
  });

  it("recusa esquemas ativos, com variações de caixa, espaços e caracteres de controle que os navegadores ignoram", () => {
    const bad = ["javascript:alert(1)", "JaVaScRiPt:void(0)", " \tjavascript:void(0)", "java\tscript:void(0)", "java\nscript:void(0)", "jav&#x61;script:void(0)", "data:text/html,<script>1</script>", "vbscript:msgbox(1)", "file:///etc/passwd", "ftp://exemplo.org/a", "blob:https://exemplo.org/x", "about:blank"];
    for (const v of bad) expect(isAllowedProofUrl(v), JSON.stringify(v)).toBe(false);
  });

  it("recusa URL relativa ao protocolo e vazios (apontariam para outro site / não são endereço)", () => {
    for (const v of ["//evil.example/x", "/\\evil.example", "", "   ", "recibo.pdf", "www.exemplo.org"]) expect(isAllowedProofUrl(v), JSON.stringify(v)).toBe(false);
  });
});

describe("allocations-receive: schema do servidor", () => {
  const base = { organizationId: 1, allocationId: 1, itemId: 1, quantityReceived: 1 };
  it("recusa proofUrl javascript:/data: e aceita http(s), caminho relativo, vazio ou ausente", () => {
    expect(schema.safeParse({ ...base, proofUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(schema.safeParse({ ...base, proofUrl: "data:text/html,x" }).success).toBe(false);
    for (const ok of ["https://exemplo.org/r.pdf", "/_api/v1/files-download?fileId=3", ""]) expect(schema.safeParse({ ...base, proofUrl: ok }).success, ok).toBe(true);
    expect(schema.safeParse(base).success).toBe(true);
  });
});

describe("interface: a âncora do comprovante só aponta para endereços permitidos", () => {
  const page = readFileSync("src/pages/organizacoes.$organizationId.atribuicoes.tsx", "utf8").replace(/\r\n/g, "\n");
  it("a âncora fica atrás de isAllowedProofUrl e o endereço recusado não vira link", () => {
    expect(page).toContain('import { isAllowedProofUrl } from "../helpers/proofUrl"');
    expect(page).toMatch(/\{ev\.proofUrl && isAllowedProofUrl\(ev\.proofUrl\) && \(\s*<>\s*\{" — "\}\s*<a href=\{ev\.proofUrl\}/);
    expect(page).toMatch(/\{ev\.proofUrl && !isAllowedProofUrl\(ev\.proofUrl\) && /);
  });
  it("o formulário usa a mesma regra", () => {
    expect(page).toMatch(/proofUrl: z\.string\(\)\.refine\(\(v\) => v === "" \|\| isAllowedProofUrl\(v\)/);
  });
});
