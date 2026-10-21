/**
 * Pré-verificação de dados legados, SEM aplicar nada (nem cria `schema_migrations`): `npm run db:preflight`.
 * É a mesma verificação que `npm run db:migrate:incremental` executa antes da primeira escrita; use-a antes da janela de manutenção.
 * Execute a partir do repositório (`npm run db:preflight`): os arquivos .sql de db/migrations não existem em dist-server, como no db/run-migrations.
 * Códigos de saída: 0 autorizada · 2 BLOQUEADA (dados legados impeditivos, estrutura ausente ou estado inconsistente) · 3 não verificada (conexão, permissão ou consulta).
 * Somente leitura: não há opção de correção; os registros são identificados por id (nenhum e-mail é impresso).
 */
import "dotenv/config";
import postgres from "postgres";
import { pgConnectionFromEnv } from "./connectionOptions.js";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PREFLIGHT_EXIT, formatPreflight, runPreflight } from "./legacyPreflight.js";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "migrations");

async function main(): Promise<number> {
  const connectionString = process.env.DATABASE_URL || process.env.FLOOT_DATABASE_URL;
  if (!connectionString) { console.error("DATABASE_URL não definida. Configure o .env (veja .env.example)."); return PREFLIGHT_EXIT.UNVERIFIED; }
  const sql = postgres(connectionString, { max: 1, prepare: false, onnotice: () => {}, ...pgConnectionFromEnv() });
  try {
    let files: string[];
    try {
      files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    } catch {
      // os .sql não são copiados para dist-server (vale também para db/run-migrations): rode a partir do repositório, com `npm run db:preflight`
      console.error("Diretório de migrações não encontrado: execute a partir do repositório (npm run db:preflight). A atualização NÃO está autorizada.");
      return PREFLIGHT_EXIT.UNVERIFIED;
    }
    const result = await runPreflight(sql, files);
    console.log(formatPreflight(result));
    return result.exitCode;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error(`Falha inesperada na pré-verificação (${e instanceof Error ? e.name : "erro"})`); process.exit(PREFLIGHT_EXIT.UNVERIFIED); });
