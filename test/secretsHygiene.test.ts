/**
 * Higiene de segredos (Fase 93.3 / auditoria de identidade): nenhum arquivo VERSIONADO contém formato conhecido de credencial.
 * Varredura estática, sem rede e sem ler `.env`. Padrões escolhidos para NÃO casar com os marcadores curtos usados em testes
 * (por exemplo a string "eyJ" sozinha): exigem o formato completo da credencial.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS: Array<[string, RegExp]> = [
  ["client secret Microsoft (formato Entra)", /[A-Za-z0-9_.-]{3}[0-9]Q~[A-Za-z0-9_.~-]{20,}/],
  ["client secret Google", /GOCSPX-[A-Za-z0-9_-]{20,}/],
  ["chave de API Google", /AIza[0-9A-Za-z_-]{35}/],
  ["chave de API Anthropic", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["chave privada PEM", /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ["JWT completo (header.payload.assinatura)", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["AWS access key id", /AKIA[0-9A-Z]{16}/],
  ["token GitHub", /gh[pousr]_[A-Za-z0-9]{36,}/],
];

// Valores de teste declaradamente falsos (ex.: sk-ant-teste-...-nao-real) não são segredos.
// Arquivos que contêm formatos de segredo FALSOS de propósito, para testar o próprio scanner do CI (test/qaCi.test.ts, findSecrets: "token JWT").
const SCANNER_FIXTURES = new Set(["test/qaCi.test.ts"]);

const PLACEHOLDER = /nao-real|teste|exemplo|example|sintetic/i;

describe("nenhuma credencial em arquivo versionado", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 26 })
    .split("\0")
    .filter((f) => f && !/\.(png|jpe?g|gif|ico|woff2?|ttf|pdf|dump|zip|gz)$/i.test(f) && f !== "package-lock.json");

  it(".env e arquivos de ambiente reais não estão versionados (só os .example)", () => {
    expect(files.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith(".example"))).toEqual([]);
  });

  it("nenhum formato conhecido de segredo/token/chave privada nos arquivos versionados", () => {
    const hits: string[] = [];
    for (const file of files) {
      if (SCANNER_FIXTURES.has(file)) continue;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue; // arquivo removido da árvore de trabalho mas ainda no índice
      }
      for (const [name, re] of PATTERNS) {
        const found = text.match(new RegExp(re.source, "g")) ?? [];
        if (found.some((value) => !PLACEHOLDER.test(value))) hits.push(`${file}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
