/**
 * Roda uma vez antes de toda a suíte (vitest globalSetup): garante que o
 * banco de dados de teste existe e recria o schema do zero a partir de
 * db/schema.sql, para que a suíte nunca dependa de um estado deixado por
 * uma execução anterior.
 *
 * NUNCA aponte TEST_DATABASE_URL/.env.test para o banco de desenvolvimento —
 * este setup dropa e recria o schema "public" inteiro.
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createRunStorageDir, removeRunStorageDir } from "./storageDir";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env.test") });

export default async function globalSetup() {
  // Armazenamento de arquivos EXCLUSIVO desta execução (ver test/storageDir.ts): os workers herdam STORAGE_LOCAL_DIR, e o diretório some no fim, com a suíte passando ou falhando.
  const storageDir = createRunStorageDir();
  process.env.STORAGE_LOCAL_DIR = storageDir;
  try {
    await prepareDatabase();
  } catch (error) {
    removeRunStorageDir(storageDir);
    throw error;
  }
  return () => {
    const result = removeRunStorageDir(storageDir);
    if (!result.removed) console.warn(`[globalSetup] não removi o armazenamento temporário da suíte: ${result.reason ?? "falha ao apagar"}`);
    else if (result.leftoverFiles > 0) console.warn(`[globalSetup] ${result.leftoverFiles} arquivo(s) de teste ficaram no armazenamento temporário (removidos); algum teste não limpa o que cria.`);
  };
}

async function prepareDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL não definida para os testes. Configure .env.test (veja .env.example) apontando para um banco de TESTE separado do de desenvolvimento."
    );
  }

  const url = new URL(connectionString);
  const targetDatabase = url.pathname.replace(/^\//, "");
  if (!targetDatabase.endsWith("_test")) {
    throw new Error(
      `DATABASE_URL de teste ("${targetDatabase}") não termina em "_test" — isto é uma checagem de segurança para nunca dropar o schema do banco de desenvolvimento por engano. Aponte .env.test para um banco cujo nome termine em "_test".`
    );
  }

  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    const existing = await admin`SELECT 1 FROM pg_database WHERE datname = ${targetDatabase}`;
    if (existing.length === 0) {
      const quotedName = `"${targetDatabase.replace(/"/g, '""')}"`;
      await admin.unsafe(`CREATE DATABASE ${quotedName}`);
    }
  } finally {
    await admin.end();
  }

  // M47: mensagens de erro do servidor ficam num idioma controlado ('C'), independente do Windows/instalação, para que o resultado da suíte seja reprodutível.
  // Valor por banco (ALTER DATABASE ... SET): vale para toda conexão aberta pelos testes. Exige superusuário; senão a verificação abaixo falha de forma explícita.
  const adminLang = postgres(adminUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    await adminLang.unsafe(`ALTER DATABASE "${targetDatabase.replace(/"/g, '""')}" SET lc_messages = 'C'`);
  } catch {
    // sem privilégio: a checagem a seguir decide
  } finally {
    await adminLang.end();
  }

  const sql = postgres(connectionString, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const [{ lc }] = await sql<{ lc: string }[]>`SELECT current_setting('lc_messages') AS lc`;
    if (!/^(C|POSIX|en[_-].*|English.*)$/i.test(lc)) {
      throw new Error(`lc_messages efetivo do banco de teste é "${lc}". Os testes comparam mensagens em inglês; use um superusuário (para o ALTER DATABASE automático) ou inicie o PostgreSQL com lc_messages = 'C'.`);
    }
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    const schemaSql = readFileSync(path.resolve(__dirname, "../db/schema.sql"), "utf-8");
    await sql.unsafe(schemaSql);
  } finally {
    await sql.end();
  }
}
