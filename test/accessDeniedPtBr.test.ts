/**
 * Contrato estático da tela de acesso negado (ProtectedRoute + AuthErrorPage), sem navegador:
 *  - o texto está em português do Brasil (a interface inteira é pt-BR) e NÃO revela o papel do usuário nem detalhes internos de permissão;
 *  - `.container` usa `box-sizing: border-box`. Sem isso, `width: 100%` + `min-height: 100vh` + `padding` ultrapassam o viewport
 *    (medido no navegador antes da correção: 1281 px de largura em 1265 px no desktop, 391 px em 375 px no mobile, e 932 px de altura em 900 px).
 * A medição real em Chrome (1280x900 e 375x812) está nos artefatos do Ciclo 13; o CI não renderiza a interface.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("tela de acesso negado", () => {
  const tsx = read("src/components/ProtectedRoute.tsx");

  it("usa texto em português e não contém o texto antigo em inglês", () => {
    expect(tsx).toContain('title="Acesso negado"');
    expect(tsx).toContain("Você não tem autorização para acessar esta página.");
    expect(tsx).not.toMatch(/Access [Dd]enied/);
    expect(tsx).not.toContain("lacks required permissions");
  });

  it("não interpola o papel (role) do usuário na mensagem", () => {
    const message = tsx.match(/message=(\{`[^`]*`\}|"[^"]*")/)?.[1] ?? "";
    expect(message).not.toBe("");
    expect(message).not.toMatch(/\$\{|role/i);
  });

  it("o contêiner da página de erro usa box-sizing: border-box (sem overflow por padding)", () => {
    const css = read("src/components/AuthErrorPage.module.css");
    const container = css.match(/\.container \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(container).toContain("box-sizing: border-box;");
    expect(container).toContain("min-height: 100vh;");
    expect(container).toContain("padding: var(--spacing-4);");
  });
});
