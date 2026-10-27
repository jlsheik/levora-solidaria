/**
 * Guarda estática contra o retorno de APIs do zod 3 que o zod 4 ignora em silêncio ou removeu:
 *  - `required_error`, `invalid_type_error` e `errorMap` (o zod 4 não lança erro: devolve a mensagem padrão em inglês);
 *  - `ZodError#errors` (removido; usar `.issues`) — quebra `Form.tsx` em runtime.
 * Varre o código de produção (src/), sem tocar em testes nem em documentação.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "static") walk(p, out); }
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk(join(__dirname, "..", "src"));
const offenders = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => "src/" + f.split("\\").join("/").split("/src/").pop());

describe("src/ não usa APIs do zod 3 removidas/ignoradas no zod 4", () => {
  it("varre arquivos de produção (sanidade: há centenas)", () => expect(files.length).toBeGreaterThan(300));
  it("nenhum required_error / invalid_type_error / errorMap", () => expect(offenders(/\b(required_error|invalid_type_error|errorMap)\b/)).toEqual([]));
  it("nenhum ZodError#errors (err.errors / error.errors / result.error.errors)", () => expect(offenders(/\b(err|error|e)\.errors\b/)).toEqual([]));
});
