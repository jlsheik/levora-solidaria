/**
 * Aplica incrementalmente os arquivos .sql de db/migrations/, em ordem, a um
 * banco que JÁ existe (diferente de db/migrate.ts, que aplica schema.sql
 * inteiro e falha se o banco já tiver tabelas — pensado só para banco novo).
 *
 * Idempotente: guarda em schema_migrations quais arquivos já foram
 * aplicados e pula os que já rodaram.
 */
import "dotenv/config";
import postgres from "postgres";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "migrations");

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.FLOOT_DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL não definida. Configure o .env (veja .env.example).");
    process.exit(1);
  }

  const sql = postgres(connectionString, { max: 1, prepare: false });
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    const applied = new Set((await sql`SELECT id FROM schema_migrations`).map((r) => r.id as string));
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

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
