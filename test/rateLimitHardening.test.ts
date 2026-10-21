/**
 * Fase 52 — fecha o achado SEC-07 da auditoria de segurança (Fase 47):
 * rate limiting em memória, auditado em profundidade nesta fase.
 *
 * Diferente de test/rateLimit.test.ts (que testa só o helper puro
 * `checkRateLimit`, sem nenhuma camada HTTP), este arquivo testa o
 * comportamento REAL via um servidor Express de verdade (`buildApp()`,
 * mesma técnica de test/securityHeaders.test.ts) — é a única forma de
 * provar que a extração de IP (server/index.ts) resiste a spoofing via
 * X-Forwarded-For, porque o helper puro nunca vê esse header.
 */
import { makeAccessCode } from "./helpers";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../server/index";
import { resetAllRateLimitsForTests } from "../src/helpers/rateLimit";

// Os buckets do rate limiter são um Map em memória no nível do módulo
// (src/helpers/rateLimit.tsx) — persistem entre describe blocks deste
// MESMO arquivo (e entre arquivos de teste, já que o processo Node é
// compartilhado). Todas as requisições reais abaixo saem do mesmo processo
// de teste, então compartilham o mesmo IP de loopback real — sem resetar
// entre blocos, um bloco anterior exauriria o bucket "register:<loopback>"
// e os blocos seguintes testariam um estado já contaminado, não o cenário
// que cada um pretende provar.
beforeEach(() => {
  resetAllRateLimitsForTests();
});

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = await buildApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("Fase 52 — resistência a spoofing de IP via X-Forwarded-For", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    delete process.env.TRUST_PROXY; // garante o padrão seguro (sem proxy confiável configurado)
    ({ server, baseUrl } = await startServer());
  });

  afterAll(() => {
    server.close();
  });

  it("sem TRUST_PROXY configurado (padrão), 11 requisições com X-Forwarded-For FORJADO e DIFERENTE a cada vez ainda compartilham o mesmo bucket (XFF é ignorado) — a 11ª é bloqueada (limite de cadastro é 10/hora/IP)", async () => {
    const results: number[] = [];
    const codes = await Promise.all(Array.from({ length: 11 }, () => makeAccessCode())); // Fase 91: o cadastro exige código ativo
    for (let i = 0; i < 11; i++) {
      const response = await fetch(`${baseUrl}/_api/v1/auth/register_with_password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Forjado: um valor DIFERENTE a cada requisição. Se a aplicação
          // confiasse nisso sem TRUST_PROXY configurado, nenhuma destas
          // 11 requisições seria bloqueada (cada uma pareceria vir de um
          // IP novo).
          "X-Forwarded-For": `10.99.0.${i}`,
        },
        body: JSON.stringify({ json: { email: `spoof-sem-proxy-${i}@example.com`, password: "senha-valida-123", displayName: `Spoof ${i}`, accessCode: codes[i].code } }),
      });
      results.push(response.status);
    }
    expect(results.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(results[10]).toBe(429);
  });
});

describe("Fase 52 — TRUST_PROXY configurado explicitamente passa a honrar X-Forwarded-For (comportamento correto só quando há um proxy reverso real na frente)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.TRUST_PROXY = "1";
    ({ server, baseUrl } = await startServer());
  });

  afterAll(() => {
    server.close();
    delete process.env.TRUST_PROXY;
  });

  it("com TRUST_PROXY=1, 11 requisições com X-Forwarded-For diferente a cada vez recebem buckets INDEPENDENTES — nenhuma bloqueada", async () => {
    const results: number[] = [];
    const codes = await Promise.all(Array.from({ length: 11 }, () => makeAccessCode()));
    for (let i = 0; i < 11; i++) {
      const response = await fetch(`${baseUrl}/_api/v1/auth/register_with_password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": `203.0.113.${i}`,
        },
        body: JSON.stringify({ json: { email: `trust-proxy-${i}@example.com`, password: "senha-valida-123", displayName: `TP ${i}`, accessCode: codes[i].code } }),
      });
      results.push(response.status);
    }
    expect(results.every((s) => s === 200)).toBe(true);
  });
});

describe("Fase 52 — concorrência: o limite nunca é ultrapassado sob requisições simultâneas", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    delete process.env.TRUST_PROXY;
    ({ server, baseUrl } = await startServer());
  });

  afterAll(() => {
    server.close();
  });

  it("50 requisições de cadastro disparadas ao mesmo tempo, mesmo IP: no máximo 10 permitidas, nunca mais (prova que checkRateLimit não tem race condition — a seção crítica roda inteira de forma síncrona, sem nenhum await no meio)", async () => {
    const codes = await Promise.all(Array.from({ length: 50 }, () => makeAccessCode()));
    const requests = Array.from({ length: 50 }, (_, i) =>
      fetch(`${baseUrl}/_api/v1/auth/register_with_password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: { email: `concorrencia-http-${i}@example.com`, password: "senha-valida-123", displayName: `C ${i}`, accessCode: codes[i].code } }),
      })
    );
    const responses = await Promise.all(requests);
    const allowed = responses.filter((r) => r.status === 200).length;
    const blocked = responses.filter((r) => r.status === 429).length;
    expect(allowed).toBeLessThanOrEqual(10);
    expect(allowed + blocked).toBe(50);
  });
});

describe("Fase 52 — 429 do cadastro nunca revela se o e-mail já existia (continuidade de SEC-03/Fase 51)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    delete process.env.TRUST_PROXY;
    ({ server, baseUrl } = await startServer());
  });

  afterAll(() => {
    server.close();
  });

  it("o limite de IP é checado ANTES de qualquer consulta por e-mail — a 11ª tentativa é bloqueada com a mesma resposta genérica, não importa se o e-mail enviado já existia ou não", async () => {
    for (let i = 0; i < 10; i++) {
      await fetch(`${baseUrl}/_api/v1/auth/register_with_password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: { email: `enum-429-${i}@example.com`, password: "senha-valida-123", displayName: `E ${i}` } }),
      });
    }
    const comEmailNovo = await fetch(`${baseUrl}/_api/v1/auth/register_with_password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: { email: "nunca-visto-antes@example.com", password: "senha-valida-123", displayName: "Novo" } }),
    });
    const comEmailJaUsado = await fetch(`${baseUrl}/_api/v1/auth/register_with_password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: { email: "enum-429-0@example.com", password: "senha-valida-123", displayName: "Repetido" } }),
    });
    expect(comEmailNovo.status).toBe(429);
    expect(comEmailJaUsado.status).toBe(429);
    const bodyA = await comEmailNovo.json();
    const bodyB = await comEmailJaUsado.json();
    expect(bodyA).toEqual(bodyB);
  });
});
