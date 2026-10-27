/**
 * O navegador não pode sondar `new Function` (CSP de produção sem unsafe-eval): `jitless` precisa estar ligado e ser o PRIMEIRO import de main.tsx.
 * A prova ponta a ponta é o `qa:security` (csp:funciona), que acusou 12 violações `script-src | eval` com o zod 4 sem esta configuração.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("zod no navegador sob CSP", () => {
  it("main.tsx importa a configuração antes de qualquer outro módulo", () => {
    const src = readFileSync(join(__dirname, "..", "src", "main.tsx"), "utf8");
    const first = src.split(/\r?\n/).find((l) => /^import\b/.test(l));
    expect(first).toBe('import "./zodBrowserConfig";');
  });
  it("com a configuração carregada, parse de objeto NÃO constrói funções dinâmicas (new Function)", async () => {
    vi.resetModules();
    await import("../src/zodBrowserConfig");
    const { z } = await import("zod");
    const Original = globalThis.Function;
    let calls = 0;
    globalThis.Function = new Proxy(Original, { construct(target, args, nt) { calls++; return Reflect.construct(target, args, nt); } }) as FunctionConstructor;
    try {
      const schema = z.object({ a: z.string().min(1), b: z.coerce.number() });
      expect(schema.safeParse({ a: "x", b: "2" }).success).toBe(true);
      expect(schema.safeParse({ a: "", b: "2" }).success).toBe(false);
    } finally { globalThis.Function = Original; }
    expect(calls).toBe(0);
  });
});
