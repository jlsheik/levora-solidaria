/**
 * Defesa em profundidade contra CSRF (src/helpers/csrfGuard.ts). Achado de `npm run qa:security` (Fase 94): uma página de OUTRA ORIGEM do MESMO
 * SITE enviava o cookie `SameSite=Lax` e, com `text/plain`, o `fetch` simples não faz preflight — a API aceitava o corpo de qualquer tipo e
 * criava registros. Os testes abaixo reproduzem os cabeçalhos que o navegador envia nesses casos, contra um servidor Express real (buildApp).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../server/index";
import { checkWriteRequest } from "../src/helpers/csrfGuard";

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

describe("checkWriteRequest (função pura)", () => {
  it("leituras (GET/HEAD/OPTIONS) nunca são barradas, mesmo entre sites", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) expect(checkWriteRequest(m, headers({ "sec-fetch-site": "cross-site" }))).toEqual({ ok: true });
  });

  it("escrita same-site/cross-site é recusada com 403 mesmo com application/json", () => {
    for (const site of ["same-site", "cross-site", "Same-Site"]) {
      const v = checkWriteRequest("POST", headers({ "sec-fetch-site": site, "content-type": "application/json" }));
      expect(v).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("escrita da própria origem ou de ação direta (none) com application/json passa", () => {
    for (const site of ["same-origin", "none"]) expect(checkWriteRequest("POST", headers({ "sec-fetch-site": site, "content-type": "application/json" }))).toEqual({ ok: true });
    expect(checkWriteRequest("POST", headers({ "sec-fetch-site": "same-origin", "content-type": "application/json; charset=utf-8" }))).toEqual({ ok: true });
  });

  it("sem Fetch Metadata (cliente que não é navegador / navegador antigo): application/json passa", () => {
    expect(checkWriteRequest("POST", headers({ "content-type": "application/json" }))).toEqual({ ok: true });
  });

  it("qualquer outro Content-Type (ou nenhum) é recusado com 415 — é o que impede o fetch 'simples' text/plain", () => {
    for (const type of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp", "", undefined]) {
      const h: Record<string, string> = type === undefined ? {} : { "content-type": type };
      expect(checkWriteRequest("POST", headers(h))).toMatchObject({ ok: false, status: 415 });
    }
  });

  it("o Content-Type não é aceito só por conter 'json' (sufixo ou parâmetro enganoso)", () => {
    expect(checkWriteRequest("POST", headers({ "content-type": "text/plain; x=application/json" }))).toMatchObject({ ok: false, status: 415 });
  });
});

describe("buildApp — o guarda está ligado antes da leitura do corpo", () => {
  let server: Server; let base: string;
  beforeAll(async () => {
    server = (await buildApp()).listen(0);
    await new Promise<void>((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); });

  const post = (h: Record<string, string>) => fetch(`${base}/_api/v1/needs`, { method: "POST", headers: h, body: JSON.stringify({ json: { organizationId: 1, title: "x", quantityNeeded: 1, unit: "kg" } }) });

  it("POST text/plain de outra origem do mesmo site (o ataque achado em navegador) → 403 pela camada 1, antes de qualquer handler", async () => {
    const r = await post({ "Content-Type": "text/plain", "Sec-Fetch-Site": "same-site", Origin: "http://127.0.0.1:9" });
    expect(r.status).toBe(403);
  });

  it("o mesmo POST de um navegador SEM Fetch Metadata (camada 2) → 415 por não ser application/json", async () => {
    const r = await post({ "Content-Type": "text/plain", Origin: "http://127.0.0.1:9" });
    expect(r.status).toBe(415);
  });

  it("POST application/json marcado como same-site/cross-site → 403", async () => {
    for (const site of ["same-site", "cross-site"]) expect((await post({ "Content-Type": "application/json", "Sec-Fetch-Site": site })).status).toBe(403);
  });

  it("POST legítimo da própria origem chega ao handler (sem sessão → 401, não 403/415)", async () => {
    const r = await post({ "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" });
    expect(r.status).toBe(401);
  });

  it("leituras entre origens continuam funcionando e a recusa também carrega os headers de segurança", async () => {
    expect((await fetch(`${base}/_api/__health`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(200);
    const blocked = await post({ "Content-Type": "text/plain" });
    expect(blocked.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
