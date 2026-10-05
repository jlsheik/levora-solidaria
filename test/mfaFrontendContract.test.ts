/**
 * Fase 90 — contrato do frontend (smoke estático; a validação visual real foi feita no preview interativo).
 * Garante os pontos de segurança que não podem regredir sem alguém perceber.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

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
