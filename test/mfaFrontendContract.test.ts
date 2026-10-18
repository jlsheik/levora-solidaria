/**
 * Fase 90 — contrato do frontend (smoke estático; a validação visual real foi feita no preview interativo).
 * Garante os pontos de segurança que não podem regredir sem alguém perceber.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("frontend de MFA/bootstrap — contrato", () => {
  it("rotas /plataforma/ativar (pública, sem UserRoute) e /seguranca (UserRoute) registradas", () => {
    const app = read("src/App.tsx");
    expect(app).toContain('path: "/plataforma/ativar"');
    expect(app).toContain('path: "/seguranca"');
    expect(read("src/pages/plataforma.ativar.pageLayout.tsx")).not.toContain("UserRoute");
    expect(read("src/pages/plataforma.ativar.pageLayout.tsx")).not.toContain("AdminRoute");
    expect(read("src/pages/seguranca.pageLayout.tsx")).toContain("UserRoute");
  });

  it("o token de bootstrap NUNCA vai em URL, storage ou console; vai no corpo do POST", () => {
    const page = read("src/pages/plataforma.ativar.tsx");
    const schema = read("src/endpoints/auth/bootstrap-activate_POST.schema.ts");
    for (const forbidden of ["localStorage", "sessionStorage", "console.log", "console.info", "searchParams", "useSearchParams", "location.hash", "location.search"]) expect(page).not.toContain(forbidden);
    expect(schema).toContain('authRequest<OutputType>("POST", "bootstrap-activate"');
    expect(schema).not.toMatch(/bootstrap-activate\?/);
    expect(page).toContain('setToken("")'); // o campo é limpo ao avançar
  });

  it("o login trata a resposta mfaRequired (sem sessão) e o recovery/TOTP; nenhum componente de MFA persiste segredo/códigos no navegador", () => {
    const form = read("src/components/PasswordLoginForm.tsx");
    expect(form).toContain("result.mfaRequired");
    expect(form).toContain("MfaCodeForm");
    for (const file of ["src/components/MfaCodeForm.tsx", "src/components/MfaSetupPanel.tsx", "src/components/StepUpDialog.tsx", "src/components/QrCode.tsx"]) {
      const src = read(file);
      for (const forbidden of ["localStorage", "sessionStorage", "console.log", "indexedDB", "document.cookie"]) expect(src, `${file}: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("o QR é gerado no cliente por SVG (sem imagem externa, sem dangerouslySetInnerHTML) e a plataforma pede step-up em reauth_required", () => {
    const qr = read("src/components/QrCode.tsx");
    expect(qr).not.toContain("dangerouslySetInnerHTML");
    expect(qr).not.toMatch(/https?:\/\//);
    expect(read("src/pages/plataforma.tsx")).toContain("reauth_required");
    expect(read("src/pages/plataforma.tsx")).toContain("StepUpDialog");
  });

  it("a dependência nova é só a de QR (uqr) e sem dependências transitivas", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies.uqr).toBeTruthy();
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { dependencies?: Record<string, string> }> };
    expect(lock.packages["node_modules/uqr"].dependencies ?? {}).toEqual({});
  });
});

describe("Fase 90.1 — exposição dos recovery codes e acessibilidade (contrato)", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));

  it("os recovery codes só aparecem nos arquivos esperados (emissão, schema do cliente, painel e página de segurança) — nenhum endpoint os devolve de novo", () => {
    const files = walk("src").filter((f) => /\.(ts|tsx)$/.test(f) && /\brecoveryCodes\b/.test(read(f))).map((f) => f.split("\\").join("/"));
    expect(files.sort()).toEqual(
      [
        "src/components/MfaSetupPanel.tsx",
        "src/endpoints/auth/mfa-recovery-regenerate_POST.schema.ts",
        "src/endpoints/auth/mfa-recovery-regenerate_POST.ts",
        "src/endpoints/auth/mfa-setup-confirm_POST.schema.ts",
        "src/endpoints/auth/mfa-setup-confirm_POST.ts",
        "src/helpers/bootstrapFinalize.tsx",
        "src/pages/seguranca.tsx",
      ].sort()
    );
  });

  it("sem persistência no navegador e sem cache de mutação para os códigos: nenhum localStorage/sessionStorage/persistQueryClient em src; a regeneração usa gcTime 0 e reset()", () => {
    for (const f of walk("src").filter((x) => /\.(ts|tsx)$/.test(x))) {
      const src = read(f);
      // `localStorageRoot` (src/helpers/storageAdapter.tsx) é o diretório de uploads em disco do SERVIDOR, não o localStorage do navegador: o limite de palavra o exclui.
      expect(src, f).not.toMatch(/persistQueryClient|\blocalStorage\b|sessionStorage/);
    }
    const page = read("src/pages/seguranca.tsx");
    expect(page).toContain("gcTime: 0");
    expect(page).toContain("regenerate.reset()");
  });

  it("os endpoints de MFA só registram o NOME do erro em log (nunca payload, corpo, código ou segredo)", () => {
    for (const f of walk("src/endpoints/auth").filter((x) => /(mfa|step-up|bootstrap).*_(GET|POST)\.ts$/.test(x))) {
      const src = read(f);
      for (const m of src.matchAll(/console\.(error|log|warn|info)\(([^)]*)\)/g)) {
        expect(m[2], `${f}: ${m[0]}`).toMatch(/error instanceof Error \? error\.name : "erro"/);
      }
    }
  });

  it("acessibilidade: erro de login/cadastro com texto em tom de primeiro plano (>= 4,5:1), alvo de toque de 44 px no 'guardei', Cancelar como outline e acento local no diálogo escuro", () => {
    for (const f of ["src/components/PasswordLoginForm.module.css", "src/components/PasswordRegisterForm.module.css"]) {
      const css = read(f);
      const block = /\.errorMessage \{[^}]*\}/.exec(css)![0];
      // A master (Fase 94) usa o token --error-text, cujo contraste ≥ 4,5:1 sobre as superfícies e sobre o fundo tingido de erro é provado em test/tokensContraste.test.ts;
      // a Fase 90.1 usava --foreground. Qualquer um dos dois passa; o vermelho puro (--error) continua proibido abaixo.
      expect(block).toMatch(/color: var\(--(?:foreground|error-text)\)/);
      expect(block).not.toMatch(/\n\s*color: var\(--error\)/);
    }
    const mfaCss = read("src/components/mfa.module.css");
    expect(/\.check \{[^}]*min-height: 2\.75rem/.test(mfaCss)).toBe(true);
    expect(mfaCss).toMatch(/:global\(\.dark\) \.dialogScope \{ --primary:/);
    expect(read("src/components/MfaCodeForm.tsx")).not.toMatch(/variant="ghost"/);
    expect(read("src/components/StepUpDialog.tsx")).not.toMatch(/variant="ghost"/);
    expect(read("src/components/StepUpDialog.tsx")).toContain("onCloseAutoFocus"); // devolve o foco a quem abriu
  });
});
