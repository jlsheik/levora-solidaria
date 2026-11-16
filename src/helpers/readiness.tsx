/**
 * Prontidão (readiness) da aplicação (M46), diferente da vivacidade (liveness):
 *  - liveness (`/_api/__health`): o processo responde. NÃO consulta o banco — uma dependência fora do ar não significa processo morto, e reiniciar não resolveria.
 *  - readiness (`/_api/__ready`): o banco responde E todas as migrations do código estão registradas em `schema_migrations`. Um schema incompatível nunca é apresentado como pronto.
 *
 * Saída pública deliberadamente grosseira: estados ("ok"/"falha"), nunca nomes de migration, mensagens de erro, URLs, credenciais ou dados de organização.
 */
import { sql } from "kysely";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db as defaultDb } from "./db.js";
import type { Kysely } from "kysely";
import { getSchedulerStatus, isOptInTaskEnabled } from "./schedulerControl.js";
import { logEvent, safeErrorCode } from "./opLog.js";
import { identityKeysConfigured } from "./identityKeys.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECK_TIMEOUT_MS = 2000;

export interface ReadinessResult {
  ready: boolean;
  checks: {
    database: "ok" | "falha";
    schema: "ok" | "desatualizado" | "nao_verificado";
    scheduler: "iniciado" | "nao_iniciado";
    agentEventsScheduler: "desabilitado" | "habilitado";
    /** Chaves de identidade (pepper e cifra do TOTP) presentes e válidas. Em produção a ausência torna a aplicação NÃO pronta. */
    identityKeys: "ok" | "ausente";
  };
}

/** Procura `db/migrations` subindo a partir deste arquivo (funciona em `src/helpers` e em `dist-server/src/helpers`; a imagem Docker leva `db/`). */
export function findMigrationsDir(start: string = __dirname): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "db", "migrations");
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function checkReadiness(options: { migrationsDir?: string | null; db?: Kysely<any> } = {}): Promise<ReadinessResult> {
  const db = options.db ?? defaultDb;
  const checks: ReadinessResult["checks"] = {
    database: "falha",
    schema: "nao_verificado",
    scheduler: getSchedulerStatus().started ? "iniciado" : "nao_iniciado",
    agentEventsScheduler: isOptInTaskEnabled("processAgentEvents") ? "habilitado" : "desabilitado",
    identityKeys: identityKeysConfigured() ? "ok" : "ausente",
  };
  const identityBlocks = checks.identityKeys === "ausente" && process.env.NODE_ENV === "production";
  if (identityBlocks) logEvent({ event: "readiness_check", status: "falha", errorCode: "CHAVES_IDENTIDADE_AUSENTES", context: { check: "identityKeys" } });

  try {
    await withTimeout(sql`select 1`.execute(db), CHECK_TIMEOUT_MS);
    checks.database = "ok";
  } catch (error) {
    logEvent({ event: "readiness_check", status: "falha", errorCode: safeErrorCode(error), context: { check: "database" } });
    return { ready: false, checks };
  }

  const dir = options.migrationsDir === undefined ? findMigrationsDir() : options.migrationsDir;
  if (!dir) {
    logEvent({ event: "readiness_check", status: "falha", errorCode: "MIGRATIONS_DIR_AUSENTE", context: { check: "schema" } });
    return { ready: false, checks };
  }
  try {
    const expected = fs.readdirSync(dir).filter((f) => f.endsWith(".sql"));
    const table = await withTimeout(sql<{ e: boolean }>`select to_regclass('public.schema_migrations') is not null as e`.execute(db), CHECK_TIMEOUT_MS);
    if (!table.rows[0]?.e) {
      checks.schema = "desatualizado";
    } else {
      const applied = await withTimeout(sql<{ id: string }>`select id from schema_migrations`.execute(db), CHECK_TIMEOUT_MS);
      const have = new Set(applied.rows.map((r) => r.id));
      checks.schema = expected.every((f) => have.has(f)) ? "ok" : "desatualizado";
    }
  } catch (error) {
    logEvent({ event: "readiness_check", status: "falha", errorCode: safeErrorCode(error), context: { check: "schema" } });
    checks.schema = "nao_verificado";
  }
  if (checks.schema !== "ok") logEvent({ event: "readiness_check", status: "falha", errorCode: "SCHEMA_INCOMPATIVEL", context: { check: "schema", schema: checks.schema } });
  return { ready: checks.schema === "ok" && !identityBlocks, checks };
}
