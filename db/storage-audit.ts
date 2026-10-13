/**
 * Diagnóstico de integridade do armazenamento de arquivos — SOMENTE LEITURA (ver src/helpers/storageIntegrity.ts e docs/UPLOAD_DE_ARQUIVOS.md).
 *
 *   npm run storage:audit                         # disco + S3 (se configurado), resumo no terminal
 *   npm run storage:audit -- --provider local     # só um provedor (local | s3 | all)
 *   npm run storage:audit -- --out relatorio.json # relatório completo em JSON (chaves exatas dos órfãos)
 *   node dist-server/db/storage-audit.js ...      # em produção, depois de `npm run build:server`
 *
 * Códigos de saída: 0 = completo, sem inconsistências · 1 = completo, COM inconsistências · 2 = INCOMPLETO (banco, diretório, listagem ou provedor sem
 * configuração não puderam ser verificados) · 3 = uso ou configuração inválida. Não há opção de reparo ou exclusão: nada é gravado, removido ou alterado.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { EXIT_CODES, formatSummary, runAudit, type ProviderName } from "../src/helpers/storageIntegrity.js";

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ options: { provider: { type: "string", default: "all" }, out: { type: "string" }, "local-root": { type: "string" } }, strict: true }));
  } catch (e) {
    console.error(`Uso inválido: ${(e as Error).message}\nOpções: --provider local|s3|all  --out <arquivo.json>  --local-root <diretório> (não há opção de reparo ou exclusão)`);
    return EXIT_CODES.USAGE;
  }
  if (!["local", "s3", "all"].includes(values.provider as string)) { console.error("--provider aceita local, s3 ou all"); return EXIT_CODES.USAGE; }
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL não definida: sem o banco não há como comparar os registros (configure o .env)."); return EXIT_CODES.USAGE; }
  const providers: ProviderName[] = values.provider === "all" ? ["local", "s3"] : [values.provider as ProviderName];

  // importados só depois de validar argumentos/ambiente (o módulo do banco lança sem DATABASE_URL)
  const { db, closeDbPool } = await import("../src/helpers/db.js");
  const { adapterForProvider, localStorageRoot } = await import("../src/helpers/storageAdapter.js");
  try {
    // `--provider all` com S3 não configurado: o S3 é "não verificado" (incompleto), nunca "limpo"
    let s3Adapter: { listKeys(): Promise<string[]> } | null = null;
    try { const a = adapterForProvider("s3"); if (a.listKeys) s3Adapter = { listKeys: () => a.listKeys!() }; } catch { s3Adapter = null; }

    const report = await runAudit({ db: db as never, providers, localRoot: values["local-root"] ?? localStorageRoot(), s3Adapter });
    console.log(formatSummary(report));
    if (values.out) {
      const file = path.resolve(values.out);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(report, null, 2)); // só o relatório; nenhum arquivo de armazenamento ou do banco é tocado
      console.log(`Relatório JSON: ${file}`);
    }
    return report.exitCode;
  } finally {
    await closeDbPool().catch(() => undefined);
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error("Falha inesperada na auditoria:", e instanceof Error ? e.name : e); process.exit(EXIT_CODES.INCOMPLETE); });
