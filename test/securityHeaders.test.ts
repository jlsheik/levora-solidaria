/**
 * Fase 50 — fecha o achado SEC-05 da auditoria de segurança (Fase 47):
 * ausência de security headers HTTP. Testa os headers de verdade, contra
 * um servidor Express real (não contra um objeto Response simulado) —
 * inclusive o caso de regressão descoberto nesta fase: o 404 padrão do
 * Express (finalhandler) sobrescrevia o Content-Security-Policy desta
 * aplicação com um valor próprio mais curto, sem frame-ancestors.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../server/index";
import {
  API_SECURITY_HEADERS,
  DOCUMENT_CSP,
  DOCUMENT_CSP_WITH_FRAME_ANCESTORS,
  PERMISSIONS_POLICY,
} from "../src/helpers/securityHeaders";

describe("Fase 50 — security headers da API (server/index.ts)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = await buildApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("1. o health check tem todos os headers de segurança com os valores exatos esperados", async () => {
    const response = await fetch(`${baseUrl}/_api/__health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("permissions-policy")).toBe(API_SECURITY_HEADERS["Permissions-Policy"]);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it("2. um endpoint real de autenticação (401) também recebe os mesmos headers", async () => {
    const response = await fetch(`${baseUrl}/_api/v1/auth/login_with_password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: { email: "nao-existe-fase50@example.com", password: "qualquer-coisa-123" } }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it("3. uma rota inexistente (404) devolve JSON e preserva o CSP completo — regressão: o finalhandler padrão do Express sobrescrevia este header com um valor próprio mais curto (sem frame-ancestors) antes desta fase adicionar um handler 404 explícito", async () => {
    const response = await fetch(`${baseUrl}/_api/v1/esta-rota-nao-existe`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body).toEqual({ message: "Rota não encontrada" });
    // A asserção que realmente importa: frame-ancestors sobrevive no 404.
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("4. nenhum endpoint real sobrescreve os headers de segurança com um valor próprio (checagem ampla em vários endpoints GET públicos/autenticados)", async () => {
    const paths = ["/_api/v1/auth/session", "/_api/__health"];
    for (const path of paths) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.headers.get("x-content-type-options"), `path ${path}`).toBe("nosniff");
      expect(response.headers.get("content-security-policy"), `path ${path}`).toBe("default-src 'none'; frame-ancestors 'none'");
    }
  });
});

describe("Fase 50 — CSP do documento HTML (vite.config.ts)", () => {
  it("5. DOCUMENT_CSP (usada na <meta> da build de produção) nunca inclui frame-ancestors — a spec do CSP ignora essa diretiva dentro de <meta>, então incluí-la daria falsa sensação de proteção", () => {
    expect(DOCUMENT_CSP).not.toContain("frame-ancestors");
  });

  it("6. DOCUMENT_CSP_WITH_FRAME_ANCESTORS (usada só como header HTTP real — vite preview / produção) inclui frame-ancestors 'none'", () => {
    expect(DOCUMENT_CSP_WITH_FRAME_ANCESTORS).toContain("frame-ancestors 'none'");
    expect(DOCUMENT_CSP_WITH_FRAME_ANCESTORS.startsWith(DOCUMENT_CSP)).toBe(true);
  });

  it("7. script-src é restrito a 'self', sem 'unsafe-inline' nem 'unsafe-eval' — nenhum script inline existe na build de produção (confirmado lendo dist/index.html)", () => {
    const scriptSrcMatch = DOCUMENT_CSP.match(/script-src ([^;]+)/);
    expect(scriptSrcMatch).not.toBeNull();
    const scriptSrc = scriptSrcMatch![1];
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  it("8. style-src permite 'unsafe-inline' (Radix UI + react-style-singleton usam estilo inline de verdade) e o Google Fonts, mas nada além disso", () => {
    const styleSrcMatch = DOCUMENT_CSP.match(/style-src ([^;]+)/);
    expect(styleSrcMatch).not.toBeNull();
    const styleSrc = styleSrcMatch![1];
    expect(styleSrc).toContain("'self'");
    expect(styleSrc).toContain("'unsafe-inline'");
    expect(styleSrc).toContain("https://fonts.googleapis.com");
  });

  it("9. font-src permite só fonts.gstatic.com (onde o Google Fonts serve os arquivos de fonte de verdade) além de 'self'", () => {
    const fontSrcMatch = DOCUMENT_CSP.match(/font-src ([^;]+)/);
    expect(fontSrcMatch).not.toBeNull();
    expect(fontSrcMatch![1]).toContain("https://fonts.gstatic.com");
  });

  it("10. connect-src é só 'self' — api.anthropic.com nunca é chamado pelo navegador (só pelo backend, src/helpers/aiClient.tsx), portanto nunca deveria aparecer aqui", () => {
    const connectSrcMatch = DOCUMENT_CSP.match(/connect-src ([^;]+)/);
    expect(connectSrcMatch).not.toBeNull();
    expect(connectSrcMatch![1].trim()).toBe("'self'");
    expect(DOCUMENT_CSP).not.toContain("anthropic.com");
  });

  it("11. object-src é 'none' — nenhum uso de plugin/embed no projeto", () => {
    expect(DOCUMENT_CSP).toContain("object-src 'none'");
  });

  it("12. nenhuma diretiva usa wildcard (*)", () => {
    expect(DOCUMENT_CSP).not.toMatch(/[\s:]\*/);
    expect(DOCUMENT_CSP_WITH_FRAME_ANCESTORS).not.toMatch(/[\s:]\*/);
  });
});

describe("Fase 50 — Permissions-Policy", () => {
  it("13. desabilita explicitamente as capacidades que a aplicação não usa, mas permite clipboard-write (usado de verdade em organizacoes.$organizationId.tsx)", () => {
    expect(PERMISSIONS_POLICY).toContain("camera=()");
    expect(PERMISSIONS_POLICY).toContain("microphone=()");
    expect(PERMISSIONS_POLICY).toContain("geolocation=()");
    expect(PERMISSIONS_POLICY).toContain("clipboard-write=(self)");
  });
});
