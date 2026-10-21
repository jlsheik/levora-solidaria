/**
 * Aplica incrementalmente os arquivos .sql de db/migrations/, em ordem, a um
 * banco que JÁ existe (diferente de db/migrate.ts, que aplica schema.sql
 * inteiro e falha se o banco já tiver tabelas — pensado só para banco novo).
 *
 * Idempotente: guarda em schema_migrations quais arquivos já foram
 * aplicados e pula os que já rodaram.
 *
 * ANTES da primeira escrita roda a pré-verificação de dados legados (db/legacyPreflight.ts, SOMENTE LEITURA): se um dado antigo impedir uma das
 * restrições das migrações pendentes 0005/0007/0013, ou o estado do banco for inconsistente, NADA é aplicado nem registrado.
 * Códigos de saída: 0 ok · 1 falha ao aplicar uma migração (comportamento original) · 2 BLOQUEADO pela pré-verificação · 3 pré-verificação não concluída.
 */
import "dotenv/config";
import postgres from "postgres";
import { pgConnectionFromEnv } from "./connectionOptions.js";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { formatPreflight, runPreflight } from "./legacyPreflight.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "migrations");

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.FLOOT_DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL não definida. Configure o .env (veja .env.example).");
    process.exit(1);
  }

  const sql = postgres(connectionString, { max: 1, prepare: false, ...pgConnectionFromEnv() });
  try {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    // Pré-verificação ANTES de qualquer escrita (inclusive do CREATE TABLE abaixo): transação READ ONLY, sem corrigir nada.
    // Exceção ÚNICA e restrita aos testes: o harness de test/schemaMigrationsData.test.ts aplica as migrações uma por vez "carimbando" as outras, o que a verificação de
    // consistência recusaria de propósito. Só vale com NODE_ENV=test (nunca em produção) e avisa em voz alta.
    if (process.env.LEVORA_SKIP_PREFLIGHT === "1" && process.env.NODE_ENV === "test") {
      console.log("PRÉ-VERIFICAÇÃO IGNORADA (LEVORA_SKIP_PREFLIGHT=1 com NODE_ENV=test; uso exclusivo de testes).");
    } else {
      const preflight = await runPreflight(sql, files);
      console.log(formatPreflight(preflight));
      if (preflight.exitCode !== 0) {
        process.exitCode = preflight.exitCode;
        return;
      }
    }

    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    const applied = new Set((await sql`SELECT id FROM schema_migrations`).map((r) => r.id as string));
    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`Já aplicada, pulando: ${file}`);
        continue;
      }
      console.log(`Aplicando: ${file}...`);
      const migrationSql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
      await sql.begin(async (trx) => {
        await trx.unsafe(migrationSql);
        await trx`INSERT INTO schema_migrations (id) VALUES (${file})`;
      });
      appliedCount += 1;
      console.log(`Aplicada com sucesso: ${file}`);
    }

    console.log(appliedCount > 0 ? `${appliedCount} migração(ões) aplicada(s).` : "Nenhuma migração pendente.");
  } catch (error) {
    console.error("Falha ao aplicar migração:", error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
