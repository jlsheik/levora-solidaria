/**
 * Aplica db/schema.sql diretamente via Node, sem depender do cliente `psql`
 * instalado separadamente no sistema (o `psql` nem sempre está disponível,
 * por exemplo em Windows com Postgres rodando só via Docker). Usa o mesmo
 * pacote "postgres" que já é dependência do projeto (src/helpers/db.tsx).
 */
import "dotenv/config";
import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.FLOOT_DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL não definida. Configure o .env (veja .env.example).");
    process.exit(1);
  }

  const sqlFilePath = path.resolve(__dirname, "schema.sql");
  const schemaSql = readFileSync(sqlFilePath, "utf-8");

  console.log(`Aplicando ${sqlFilePath} em ${connectionString.replace(/:[^:@]+@/, ":****@")}...`);

  const sql = postgres(connectionString, { max: 1, prepare: false });
  try {
    // O schema.sql já usa BEGIN/COMMIT e é idempotente-hostil por padrão
    // (CREATE TABLE sem IF NOT EXISTS), de propósito: falhar alto se o banco
    // já tiver as tabelas, em vez de aplicar parcialmente ou mascarar erro.
    await sql.unsafe(schemaSql);
    console.log("Schema aplicado com sucesso.");

    // schema.sql já é cumulativo (inclui o que cada arquivo em
    // db/migrations/ também faz) — registra todos como já aplicados para
    // que "npm run db:migrate:incremental" não tente recriá-los depois.
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    const migrationsDir = path.resolve(__dirname, "migrations");
    const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
    for (const file of migrationFiles) {
      await sql`INSERT INTO schema_migrations (id) VALUES (${file}) ON CONFLICT DO NOTHING`;
    }
  } catch (error) {
    console.error("Falha ao aplicar o schema:", error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
