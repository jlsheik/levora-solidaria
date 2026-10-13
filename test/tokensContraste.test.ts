/**
 * Contratos dos componentes/tokens COMPARTILHADOS corrigidos na Fase 94 (acessibilidade visual): botão \`outline\`, \`Input\`/\`Textarea\`/Select
 * (dimensionamento e borda) e texto de erro. Dois tipos de teste aqui, sem navegador:
 *  1) ARITMÉTICA DE CONTRASTE a partir dos tokens reais de \`src/base.css\` (parse de hsl(), mistura em sRGB, razão WCAG) — prova que as cores
 *     definidas no CSS atendem 4,5:1 (texto) / 3:1 (borda de controle) sobre as superfícies do tema;
 *  2) CONTRATOS ESTÁTICOS do CSS/TSX (estrutura e ausência de regressões).
 * Isto NÃO substitui as medições no navegador (cores efetivas, hover/foco, dimensões), feitas à mão em Edge e Chrome e registradas no roadmap;
 * o CI não renderiza a interface.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
type RGB = [number, number, number];

function tokens(css: string, selector: ":root" | ".dark"): Record<string, string> {
  const out: Record<string, string> = {};
  const re = selector === ":root" ? /(^|\n):root \{([\s\S]*?)\n\}/g : /(^|\n)\.dark \{([\s\S]*?)\n\}/g;
  for (const m of css.matchAll(re)) for (const d of m[2].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
}
function hslToRgb(v: string): RGB {
  const m = v.match(/^hsl\(\s*([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\s*\)$/);
  if (!m) throw new Error("token não é hsl(): " + v);
  const h = Number(m[1]), s = Number(m[2]) / 100, l = Number(m[3]) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1))); };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
const lum = ([r, g, b]: RGB) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a: RGB, b: RGB) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
/** color-mix(in srgb, A pa%, B) com B opaco; com B "transparent" use \`over\` (A com alpha pa sobre a superfície) */
const mix = (a: RGB, b: RGB, pa: number): RGB => [a[0] * pa + b[0] * (1 - pa), a[1] * pa + b[1] * (1 - pa), a[2] * pa + b[2] * (1 - pa)];

const css = read("src/base.css");
const THEMES = { claro: { t: tokens(css, ":root"), toward: [0, 0, 0] as RGB }, escuro: { t: { ...tokens(css, ":root"), ...tokens(css, ".dark") }, toward: [255, 255, 255] as RGB } };
const surfaces = (t: Record<string, string>) => ({ background: hslToRgb(t["background"]), surface: hslToRgb(t["surface"]), card: hslToRgb(t["card"]), popup: hslToRgb(t["popup"]) });

describe.each(Object.entries(THEMES))("tokens %s: contraste calculado a partir de src/base.css", (_nome, { t, toward }) => {
  const S = surfaces(t);
  const primary = hslToRgb(t["primary"]);
  const error = hslToRgb(t["error"]);

  it("--error-text (texto de erro) ≥ 4,5:1 sobre as superfícies e sobre o fundo tingido de erro (15%/25%)", () => {
    const et = hslToRgb(t["error-text"]);
    for (const [nome, s] of Object.entries(S)) {
      expect(ratio(et, s), `texto de erro sobre ${nome}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(et, mix(error, s, 0.15)), `texto de erro sobre ${nome} + 15% de erro (caixas de erro)`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(et, mix(error, s, 0.25)), `texto de erro sobre ${nome} + 25% de erro (badge em hover)`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("--input-border (borda de controle) ≥ 3:1 sobre as superfícies (WCAG 1.4.11)", () => {
    const ib = hslToRgb(t["input-border"]);
    for (const [nome, s] of Object.entries(S)) expect(ratio(ib, s), `borda de controle sobre ${nome}`).toBeGreaterThanOrEqual(3);
  });

  it("botão outline: texto (primário 80% rumo ao preto/branco) ≥ 4,5:1 no normal, hover (10%) e ativo (15%) sobre as superfícies", () => {
    const texto = mix(toward, primary, 0.2); // color-mix(in srgb, var(--primary) 80%, black|white)
    for (const [nome, s] of Object.entries(S)) {
      expect(ratio(texto, s), `normal sobre ${nome}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(texto, mix(primary, s, 0.1)), `hover sobre ${nome}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(texto, mix(primary, s, 0.15)), `ativo sobre ${nome}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("os tokens existentes que não devem mudar continuam iguais (--error, --border, --primary)", () => {
    expect(t["error"]).toBe(_nome === "claro" ? "hsl(4, 62%, 42%)" : "hsl(4, 68%, 58%)");
    expect(t["border"]).toBe(_nome === "claro" ? "hsl(24, 16%, 84%)" : "hsl(20, 14%, 22%)");
    expect(t["primary"]).toBe(_nome === "claro" ? "hsl(14, 62%, 45%)" : "hsl(16, 68%, 56%)");
  });
});

describe("CSS dos componentes compartilhados (contrato estático)", () => {
  it("Input/Textarea/Select: .input é border-box, com altura 2.5rem e borda de controle; desabilitado mantém a borda sutil", () => {
    const input = read("src/components/Input.module.css");
    expect(input).toMatch(/\.input \{[^}]*width: 100%;[^}]*box-sizing: border-box;/);
    expect(input).toMatch(/\.input \{[^}]*border: 1px solid var\(--input-border\);/);
    expect(input).toMatch(/\.input \{[^}]*height: 2\.5rem;/);
    expect(input).toMatch(/\.input:disabled \{\s*border-color: var\(--border\);/);
    // Textarea e gatilho do Select reutilizam a MESMA classe (um só lugar de dimensionamento)
    expect(read("src/components/Textarea.tsx")).toMatch(/inputStyles\.input/);
    expect(read("src/components/Select.tsx")).toMatch(/inputStyles\.input/);
    const ta = read("src/components/Textarea.module.css");
    expect(ta).not.toMatch(/box-sizing|border-color|border: 1px/);
    expect(ta).toMatch(/\.textarea \{[^}]*min-height: 6rem;/);
  });

  it("Input.module.css: estados hover/foco/erro/desabilitado continuam definidos", () => {
    const input = read("src/components/Input.module.css");
    for (const sel of [".input:hover", ".input:focus", ".input:disabled", ":global(.dark) .input:hover", ":global(.dark) .input:focus"]) expect(input).toContain(sel);
    const form = read("src/components/Form.module.css");
    expect(form).toMatch(/\.formControl\.error:not\(button\) \{\s*border-color: var\(--error\);/); // campo inválido segue em --error
  });

  it("texto de erro usa --error-text; --error continua para preenchimento/borda (rótulo, mensagem, caixas, badge, dropzone, delta de estoque)", () => {
    const form = read("src/components/Form.module.css");
    expect(form).toMatch(/\.formLabel\.error \{\s*color: var\(--error-text\);/);
    expect(form).toMatch(/\.formMessage \{[^}]*color: var\(--error-text\);/);
    expect(read("src/components/Badge.module.css")).toMatch(/\.destructive \{[^}]*color: var\(--error-text\);/);
    expect(read("src/components/PasswordLoginForm.module.css")).toMatch(/\.errorMessage \{[^}]*color: var\(--error-text\);/);
    expect(read("src/components/PasswordRegisterForm.module.css")).toMatch(/\.errorMessage \{[^}]*color: var\(--error-text\);/);
    expect(read("src/components/FileDropzone.module.css")).toMatch(/color: var\(--error-text\);/);
    expect(read("src/pages/organizacoes.$organizationId.inventario.module.css")).toMatch(/\.deltaNegative \{[^}]*color: var\(--error-text\);/);
    // associações acessíveis dos formulários continuam nos diálogos (aria-invalid/aria-describedby/role=alert)
    for (const f of ["EditNeedDialog", "RenameOrganizationDialog", "RenameSourceDialog"]) {
      const tsx = read(`src/components/${f}.tsx`);
      expect(tsx).toMatch(/aria-invalid=/);
      expect(tsx).toMatch(/aria-describedby=/);
      expect(tsx).toMatch(/role="alert"/);
    }
  });

  it("Button outline: estrutura e estados preservados (normal, hover, ativo, foco, desabilitado)", () => {
    const btn = read("src/components/Button.module.css");
    expect(btn).toMatch(/\.outline \{\s*background-color: transparent;\s*border-color: var\(--primary\);\s*color: var\(--primary\);/);
    expect(btn).toMatch(/\.outline:not\(:disabled\) \{\s*color: color-mix\(in srgb, var\(--primary\) 80%, black\);/);
    expect(btn).toMatch(/:global\(\.dark\) \.outline:not\(:disabled\) \{\s*color: color-mix\(in srgb, var\(--primary\) 80%, white\);/);
    expect(btn).toMatch(/\.outline:hover \{\s*background-color: color-mix\(in srgb, var\(--primary\) 10%, transparent\);/);
    expect(btn).toMatch(/\.outline:active \{\s*background-color: color-mix\(in srgb, var\(--primary\) 15%, transparent\);/);
    // o hover/ativo NÃO mexem mais na cor do texto (era a mistura com --primary-foreground que derrubava o contraste)
    const hover = btn.match(/\.outline:hover \{([^}]*)\}/)![1];
    const active = btn.match(/\.outline:active \{([^}]*)\}/)![1];
    expect(hover).not.toMatch(/(^|\s)color:/);
    expect(active).not.toMatch(/(^|\s)color:/);
    expect(btn).toMatch(/\.disabled \{[^}]*opacity: 0\.5;[^}]*cursor: not-allowed;[^}]*pointer-events: none;/);
    expect(btn).toMatch(/\.button:focus-visible \{[^}]*0 0 0 4px var\(--primary\)/);
  });

  it("os 13 usos de <Button variant=\"outline\"> continuam usando a variante (sem trocar por classes locais)", () => {
    const files = [
      "src/components/EditNeedDialog.tsx", "src/components/ReceiptHistoryPanel.tsx", "src/components/RenameOrganizationDialog.tsx", "src/components/RenameSourceDialog.tsx",
      "src/pages/organizacoes.$organizationId.atribuicoes.tsx", "src/pages/organizacoes.$organizationId.prestacao-contas.tsx", "src/pages/organizacoes.$organizationId.tsx",
      "src/pages/plataforma.tsx", "src/pages/_index.tsx",
    ];
    let total = 0;
    for (const f of files) {
      const src = read(f);
      // só <Button ...variant="outline"> (multilinha incluída), não <Badge variant="outline">
      total += [...src.matchAll(/<Button\b[^>]*?variant="outline"/g)].length;
    }
    expect(total).toBe(13);
  });
});
