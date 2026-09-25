import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit, resetAllRateLimitsForTests } from "../src/helpers/rateLimit";

describe("checkRateLimit (helper puro, sem banco)", () => {
  beforeEach(() => {
    resetAllRateLimitsForTests();
  });

  it("permite requisições dentro do limite e nega a partir do limite", () => {
    const params = { bucket: "teste", identifier: "ip-1", limit: 3, windowMs: 60_000 };
    expect(checkRateLimit(params).allowed).toBe(true);
    expect(checkRateLimit(params).allowed).toBe(true);
    expect(checkRateLimit(params).allowed).toBe(true);
    const fourth = checkRateLimit(params);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("mantém contadores independentes por identificador", () => {
    const base = { bucket: "teste", limit: 1, windowMs: 60_000 };
    expect(checkRateLimit({ ...base, identifier: "ip-a" }).allowed).toBe(true);
    expect(checkRateLimit({ ...base, identifier: "ip-b" }).allowed).toBe(true);
    // ip-a já usou sua única permissão; ip-b não interfere.
    expect(checkRateLimit({ ...base, identifier: "ip-a" }).allowed).toBe(false);
  });

  it("mantém contadores independentes por bucket, mesmo identificador", () => {
    expect(checkRateLimit({ bucket: "login", identifier: "ip-x", limit: 1, windowMs: 60_000 }).allowed).toBe(true);
    // Mesmo IP, bucket diferente — não deveria estar bloqueado aqui.
    expect(checkRateLimit({ bucket: "register", identifier: "ip-x", limit: 1, windowMs: 60_000 }).allowed).toBe(true);
  });

  it("libera de novo depois que a janela expira", async () => {
    const params = { bucket: "teste", identifier: "ip-janela", limit: 1, windowMs: 50 };
    expect(checkRateLimit(params).allowed).toBe(true);
    expect(checkRateLimit(params).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(checkRateLimit(params).allowed).toBe(true);
  });
});
