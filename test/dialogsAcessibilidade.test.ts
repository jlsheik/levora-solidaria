/**
 * Contratos ESTÁTICOS dos ajustes de acessibilidade/responsividade achados no QA em Edge e Chrome reais (via CDP) na Fase 94.
 * Atenção: estes testes só travam o código-fonte; o COMPORTAMENTO (foco, contraste, quebra de linha) foi verificado manualmente no navegador e
 * NÃO é repetido pelo CI (o repositório não tem jsdom/Playwright por decisão). Ver docs/ROADMAP_ATUAL.md §10.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe.each([
  { comp: "RenameOrganizationDialog", min: "ORGANIZATION_NAME_MIN", max: "ORGANIZATION_NAME_MAX" },
  { comp: "RenameSourceDialog", min: "SOURCE_NAME_MIN", max: "SOURCE_NAME_MAX" },
])("$comp: foco e avisos acessíveis", ({ comp, min, max }) => {
  // Reproduzido nos dois diálogos: (1) ao fechar por Escape/Cancelar/salvar o foco ia para o <body> (diálogo controlado de fora, sem DialogTrigger);
  // (2) após erro (ex.: 403) o foco ficava no <body> (Salvar desabilitado durante o envio); (3) nome curto deixava aria-invalid=true sem mensagem
  // alguma, e o aviso de nome longo não estava ligado ao campo.
  const dlg = strip(read(`src/components/${comp}.tsx`));

  it("devolve o foco a quem abriu o diálogo ao fechar", () => {
    expect(dlg).toMatch(/onOpenAutoFocus=\{\(\) => \{\s*openerRef\.current = document\.activeElement instanceof HTMLElement/);
    expect(dlg).toMatch(/onCloseAutoFocus=\{\(e\) => \{\s*if \(openerRef\.current\?\.isConnected\) \{\s*e\.preventDefault\(\);\s*openerRef\.current\.focus\(\);/);
  });

  it("devolve o foco ao Salvar depois de um erro", () => {
    expect(dlg).toMatch(/useEffect\(\(\) => \{\s*if \(mutation\.isError\) saveRef\.current\?\.focus\(\);\s*\}, \[mutation\.isError\]\);/);
    expect(dlg).toMatch(/<Button ref=\{saveRef\} type="submit"/);
  });

  it("explica nome curto e nome longo e liga o aviso ao campo", () => {
    expect(dlg).toMatch(/aria-describedby=\{invalid \? hintId : undefined\}/);
    expect(dlg).toMatch(new RegExp(`trimmed\\.length < \\{?${min}\\}? && <p id=\\{hintId\\}`));
    expect(dlg).toMatch(new RegExp(`trimmed\\.length > ${max} && <p id=\\{hintId\\}`));
  });

  it("sem paliativos de temporização/camadas, e as regras de validação não mudaram", () => {
    expect(dlg).not.toMatch(/setTimeout|requestAnimationFrame|pointerEvents|pointer-events|onInteractOutside/);
    expect(dlg).toMatch(new RegExp(`const invalid = trimmed\\.length < ${min} \\|\\| trimmed\\.length > ${max};`));
    expect(dlg).toMatch(/disabled=\{invalid \|\| unchanged \|\| mutation\.isPending\}/);
  });
});

describe("CSS: contraste do diálogo no tema escuro e indicadores das necessidades em telas pequenas", () => {
  it("diálogo escuro usa --card (texto primário sobre --popup dava 4,48:1 < 4,5:1); o token --popup não mudou", () => {
    const dialogCss = read("src/components/Dialog.module.css");
    expect(dialogCss).toMatch(/:global\(\.dark\) \.content \{\s*background-color: var\(--card\);\s*\}/);
    expect(dialogCss).toMatch(/\.content \{[\s\S]*?background-color: var\(--popup\);/); // claro continua --popup
    const base = read("src/base.css");
    expect(base).toMatch(/--popup: hsl\(20, 18%, 15%\);/); // token escuro intacto (outros popups)
    expect(base).toMatch(/--card: hsl\(20, 18%, 14%\);/);
  });

  it("indicadores Faltam/Excedente: grade 2x2 por padrão, 4 colunas só quando o CORPO do cartão comporta (container query); ações abaixo em ≤ 40rem", () => {
    const css = read("src/pages/organizacoes.$organizationId.necessidades.module.css");
    expect(css).toMatch(/\.needBody \{[^}]*container-type: inline-size;/);
    expect(css).toMatch(/\.progressGrid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    expect(css).toMatch(/@container \(min-width: 36rem\) \{\s*\.progressGrid \{\s*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
    expect(css).toMatch(/@media \(max-width: 40rem\) \{\s*\.needCard \{\s*display: grid;\s*grid-template-columns: auto minmax\(0, 1fr\);\s*\}\s*\.needActions \{\s*grid-column: 1 \/ -1;/);
  });

  it("a ordem do DOM (ícone, corpo, ações) e os textos/valores dos indicadores não mudaram", () => {
    const page = read("src/pages/organizacoes.$organizationId.necessidades.tsx");
    const iconAt = page.indexOf("styles.needIcon");
    const bodyAt = page.indexOf("styles.needBody");
    const actionsAt = page.indexOf("styles.needActions");
    expect(iconAt).toBeGreaterThan(-1);
    expect(iconAt).toBeLessThan(bodyAt);
    expect(bodyAt).toBeLessThan(actionsAt);
    for (const label of ["Quantidade necessária", "Recebido pela rede", "Faltam", "Excedente"]) expect(page).toContain(`>${label}</span>`);
    expect(page).toMatch(/\{need\.requiredRemaining\} \{need\.unit\}/);
    expect(page).toMatch(/\{need\.surplus\} \{need\.unit\}/);
  });
});
