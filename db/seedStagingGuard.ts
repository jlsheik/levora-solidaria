/**
 * Fase 68 — guarda de ambiente do seed sintético de staging.
 *
 * Este módulo é PURO de propósito: não importa `src/helpers/db` (que abre o
 * pool no import) nem nenhum endpoint. O CLI (db/seed-staging.ts) chama
 * `assertStagingEnvironment()` ANTES de importar qualquer coisa que toque o
 * banco — assim uma recusa acontece sem nenhuma conexão aberta.
 *
 * Por que não basta `NODE_ENV !== "production"`: o container de staging
 * roda o MESMO artefato de produção e o compose de staging nem define
 * NODE_ENV; um desenvolvedor local também tem NODE_ENV indefinido. Esse
 * valor não distingue "staging" de "banco de dev" de "algo que não deveria
 * ser tocado". Por isso a guarda exige EVIDÊNCIA POSITIVA, de três fontes
 * independentes, e recusa em qualquer dúvida:
 *
 *   1. declaração explícita: LEVORA_ENVIRONMENT=staging;
 *   2. nome do banco reservado: termina em `_staging` ou `_demo`;
 *   3. host do banco numa lista fechada (serviço `postgres` do compose de
 *      staging ou loopback) — um banco gerenciado/remoto nunca passa.
 *
 * Exceção única, para os testes automatizados do próprio seed: NODE_ENV=test
 * E banco terminando em `_test` (a mesma regra que test/global-setup.ts já
 * impõe antes de dropar o schema) — nunca satisfeita por um container de
 * staging ou de produção, que não definem NODE_ENV=test.
 */

export class SeedGuardError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(
      "SEED RECUSADO — o ambiente não foi reconhecido como staging/demonstração:\n" +
        reasons.map((r) => `  - ${r}`).join("\n") +
        "\nNenhuma conexão com o banco foi aberta. Este seed é exclusivo do staging sintético (docs/STAGING_DEMO.md)."
    );
    this.name = "SeedGuardError";
    this.reasons = reasons;
  }
}

export interface StagingGuardResult {
  ok: boolean;
  reasons: string[];
  database: string | null;
  host: string | null;
  mode: "staging" | "test" | null;
}

/** Hosts aceitos: serviço do compose de staging + loopback. Lista fechada. */
const ALLOWED_DB_HOSTS = new Set(["postgres", "localhost", "127.0.0.1", "::1", "[::1]"]);

/** Variáveis que, se declararem produção, vetam o seed mesmo com o resto "certo". */
const ENVIRONMENT_DECLARATION_VARS = [
  "LEVORA_ENVIRONMENT",
  "APP_ENV",
  "ENVIRONMENT",
  "DEPLOY_ENV",
  "RAILWAY_ENVIRONMENT",
  "VERCEL_ENV",
] as const;

const PRODUCTION_LIKE = /^(prod|production|producao|produção|live|prd)$/i;

export function evaluateStagingGuard(env: Record<string, string | undefined>): StagingGuardResult {
  const reasons: string[] = [];

  // 1. Declaração explícita e exata.
  const declared = (env.LEVORA_ENVIRONMENT ?? "").trim().toLowerCase();
  if (declared !== "staging") {
    reasons.push(
      declared === ""
        ? 'LEVORA_ENVIRONMENT não está definida (exigido: LEVORA_ENVIRONMENT=staging).'
        : `LEVORA_ENVIRONMENT="${declared}" — exigido exatamente "staging".`
    );
  }

  // 2. Nenhuma outra variável de ambiente pode declarar produção.
  for (const name of ENVIRONMENT_DECLARATION_VARS) {
    const value = (env[name] ?? "").trim();
    if (value && PRODUCTION_LIKE.test(value)) {
      reasons.push(`${name}="${value}" indica produção.`);
    }
  }

  // 3. Banco: URL válida, única e com nome/host reservados.
  const primary = env.DATABASE_URL?.trim();
  const alias = env.FLOOT_DATABASE_URL?.trim();
  if (!primary) {
    reasons.push("DATABASE_URL não está definida.");
  }
  // src/helpers/db.tsx usa DATABASE_URL || FLOOT_DATABASE_URL; se as duas
  // existirem e divergirem, não dá para afirmar com segurança qual banco o
  // código importado vai tocar.
  if (primary && alias && primary !== alias) {
    reasons.push("DATABASE_URL e FLOOT_DATABASE_URL divergem — ambíguo qual banco seria usado.");
  }

  let database: string | null = null;
  let host: string | null = null;
  if (primary) {
    try {
      const url = new URL(primary);
      database = decodeURIComponent(url.pathname.replace(/^\//, ""));
      host = url.hostname.toLowerCase();
    } catch {
      reasons.push("DATABASE_URL não é uma URL válida.");
    }
  }

  let mode: StagingGuardResult["mode"] = null;
  if (database !== null) {
    const stagingName = /^[a-z0-9][a-z0-9_]*_(staging|demo)$/.test(database);
    const testName = /^[a-z0-9][a-z0-9_]*_test$/.test(database);
    if (stagingName) {
      mode = "staging";
    } else if (testName && env.NODE_ENV === "test") {
      mode = "test";
    } else {
      reasons.push(
        `Nome do banco "${database}" não é reservado a staging (esperado terminar em "_staging" ou "_demo").`
      );
    }
  }

  if (host !== null && !ALLOWED_DB_HOSTS.has(host)) {
    reasons.push(
      `Host do banco "${host}" fora da lista permitida (${[...ALLOWED_DB_HOSTS].join(", ")}) — banco remoto/gerenciado nunca é aceito.`
    );
  }

  return { ok: reasons.length === 0, reasons, database, host, mode };
}

/** Lança SeedGuardError (sem nunca tocar o banco) se o ambiente não for staging. */
export function assertStagingEnvironment(
  env: Record<string, string | undefined> = process.env
): StagingGuardResult {
  const result = evaluateStagingGuard(env);
  if (!result.ok) throw new SeedGuardError(result.reasons);
  return result;
}
