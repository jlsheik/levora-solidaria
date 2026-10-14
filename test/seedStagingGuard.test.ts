/**
 * Fase 68 — a guarda do seed de staging TEM que ser provada, não só existir.
 * Testa a função pura e, principalmente, o CLI real: um ambiente não
 * permitido precisa falhar com exit code 2 e mensagem clara ANTES de abrir
 * qualquer conexão (o DATABASE_URL usado aqui aponta para um host
 * inalcançável — se o CLI tentasse conectar, o erro seria outro).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { evaluateStagingGuard, assertStagingEnvironment, SeedGuardError } from "../db/seedStagingGuard";

const STAGING_ENV = {
  LEVORA_ENVIRONMENT: "staging",
  DATABASE_URL: "postgres://postgres:x@postgres:5432/levora_staging",
};

describe("evaluateStagingGuard", () => {
  it("aceita exatamente o ambiente do compose de staging (sem NODE_ENV)", () => {
    const r = evaluateStagingGuard(STAGING_ENV);
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("staging");
  });

  it("aceita NODE_ENV=production se TODAS as evidências de staging existirem (NODE_ENV não decide)", () => {
    expect(evaluateStagingGuard({ ...STAGING_ENV, NODE_ENV: "production" }).ok).toBe(true);
  });

  it("recusa sem declaração explícita LEVORA_ENVIRONMENT", () => {
    const r = evaluateStagingGuard({ DATABASE_URL: STAGING_ENV.DATABASE_URL });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/LEVORA_ENVIRONMENT/);
  });

  it.each(["production", "prod", "development", "Staging-prod", ""])("recusa LEVORA_ENVIRONMENT=%j", (value) => {
    expect(evaluateStagingGuard({ ...STAGING_ENV, LEVORA_ENVIRONMENT: value }).ok).toBe(false);
  });

  it("recusa quando outra variável declara produção, mesmo com o resto correto", () => {
    for (const name of ["APP_ENV", "ENVIRONMENT", "DEPLOY_ENV", "VERCEL_ENV", "RAILWAY_ENVIRONMENT"]) {
      const r = evaluateStagingGuard({ ...STAGING_ENV, [name]: "production" });
      expect(r.ok, name).toBe(false);
      expect(r.reasons.join(" ")).toContain(name);
    }
  });

  it("recusa banco com nome não reservado (dev, produção, genérico)", () => {
    for (const db of ["levora_solidaria", "levora_production", "levora", "postgres", "staging", "levora_staging_old"]) {
      const r = evaluateStagingGuard({ ...STAGING_ENV, DATABASE_URL: `postgres://u:p@postgres:5432/${db}` });
      expect(r.ok, db).toBe(false);
    }
  });

  it("recusa host remoto/gerenciado mesmo com nome de banco de staging", () => {
    for (const host of ["db.example.com", "abc.rds.amazonaws.com", "prod-db.internal", "10.0.0.5"]) {
      const r = evaluateStagingGuard({ ...STAGING_ENV, DATABASE_URL: `postgres://u:p@${host}:5432/levora_staging` });
      expect(r.ok, host).toBe(false);
      expect(r.reasons.join(" ")).toMatch(/Host do banco/);
    }
  });

  it("aceita loopback com banco de staging/demo", () => {
    expect(evaluateStagingGuard({ ...STAGING_ENV, DATABASE_URL: "postgres://u:p@localhost:5433/levora_demo" }).ok).toBe(true);
    expect(evaluateStagingGuard({ ...STAGING_ENV, DATABASE_URL: "postgres://u:p@127.0.0.1:5433/levora_staging" }).ok).toBe(true);
  });

  it("recusa DATABASE_URL ausente, inválida ou ambígua com FLOOT_DATABASE_URL", () => {
    expect(evaluateStagingGuard({ LEVORA_ENVIRONMENT: "staging" }).ok).toBe(false);
    expect(evaluateStagingGuard({ ...STAGING_ENV, DATABASE_URL: "isto não é uma url" }).ok).toBe(false);
    expect(
      evaluateStagingGuard({ ...STAGING_ENV, FLOOT_DATABASE_URL: "postgres://u:p@postgres:5432/outro_staging" }).ok
    ).toBe(false);
  });

  it("banco *_test só é aceito com NODE_ENV=test (nunca num container de staging/produção)", () => {
    const url = "postgres://u:p@localhost:5433/levora_solidaria_test";
    expect(evaluateStagingGuard({ ...STAGING_ENV, DATABASE_URL: url, NODE_ENV: "test" })).toMatchObject({ ok: true, mode: "test" });
    expect(evaluateStagingGuard({ ...STAGING_ENV, DATABASE_URL: url }).ok).toBe(false);
    expect(evaluateStagingGuard({ ...STAGING_ENV, DATABASE_URL: url, NODE_ENV: "production" }).ok).toBe(false);
  });

  it("assertStagingEnvironment lança SeedGuardError listando os motivos", () => {
    expect(() => assertStagingEnvironment({})).toThrow(SeedGuardError);
    try {
      assertStagingEnvironment({ LEVORA_ENVIRONMENT: "production", DATABASE_URL: "postgres://u:p@db.example.com/prod" });
    } catch (e) {
      expect((e as SeedGuardError).reasons.length).toBeGreaterThanOrEqual(3);
      expect((e as Error).message).toContain("Nenhuma conexão com o banco foi aberta");
    }
  });
});

describe("CLI db/seed-staging.ts (processo real)", () => {
  const tsxCli = path.resolve(__dirname, "../node_modules/tsx/dist/cli.mjs");
  const script = path.resolve(__dirname, "../db/seed-staging.ts");

  function runCli(env: Record<string, string>) {
    return spawnSync(process.execPath, [tsxCli, script], {
      // env mínimo: nada do ambiente de teste (DATABASE_URL/.env.test) vaza para o processo filho
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  it("ambiente de produção → exit 2, mensagem clara, sem tentar conectar", () => {
    const r = runCli({
      LEVORA_ENVIRONMENT: "production",
      // host inalcançável: se o seed tentasse conectar, o erro seria ENOTFOUND/timeout, não a recusa
      DATABASE_URL: "postgres://u:p@prod-db.invalid:5432/levora_production",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("SEED RECUSADO");
    expect(r.stderr).toContain("Nenhuma conexão com o banco foi aberta");
    expect(r.stdout).not.toContain("Guarda de ambiente OK");
    expect(r.stderr).not.toMatch(/ENOTFOUND|ECONNREFUSED|getaddrinfo/);
  });

  it("sem nenhuma variável → exit 2 (em caso de dúvida, não executa)", () => {
    const r = runCli({});
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("SEED RECUSADO");
  });

  it("banco de desenvolvimento local sem declaração de staging → exit 2", () => {
    const r = runCli({ DATABASE_URL: "postgres://u:p@localhost:5433/levora_solidaria" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/LEVORA_ENVIRONMENT/);
  });
});
