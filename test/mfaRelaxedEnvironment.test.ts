import { describe, expect, it } from "vitest";
import { isRelaxedMfaEnvironment } from "../src/helpers/identityKeys";

// O relaxamento do MFA de plataforma só vale em ambiente descartável COMPROVADO. Estes testes passam o ambiente explicitamente (não mexem em process.env).
const base = {
  PLATFORM_MFA_REQUIRED: "false",
  LEVORA_ENVIRONMENT: "staging",
  DATABASE_URL: "postgres://u:p@localhost:5433/levora_ciclo2_ci_qa",
} as NodeJS.ProcessEnv;
const withEnv = (o: Record<string, string | undefined>) => ({ ...base, ...o }) as NodeJS.ProcessEnv;

describe("isRelaxedMfaEnvironment: MFA de plataforma só relaxa em ambiente descartável comprovado", () => {
  it("relaxa nos ambientes reservados: *_qa, *_test, *_staging e *_demo, em host da lista fechada", () => {
    for (const db of ["levora_x_qa", "levora_x_test", "levora_staging", "levora_demo"]) {
      for (const host of ["localhost", "127.0.0.1", "postgres", "[::1]"]) {
        expect(isRelaxedMfaEnvironment(withEnv({ DATABASE_URL: `postgres://u:p@${host}:5432/${db}` })), `${host}/${db}`).toBe(true);
      }
    }
  });

  it("não relaxa sem as DUAS declarações explícitas", () => {
    expect(isRelaxedMfaEnvironment(withEnv({ PLATFORM_MFA_REQUIRED: undefined }))).toBe(false);
    expect(isRelaxedMfaEnvironment(withEnv({ PLATFORM_MFA_REQUIRED: "true" }))).toBe(false);
    expect(isRelaxedMfaEnvironment(withEnv({ PLATFORM_MFA_REQUIRED: "FALSE" }))).toBe(false);
    expect(isRelaxedMfaEnvironment(withEnv({ LEVORA_ENVIRONMENT: undefined }))).toBe(false);
    expect(isRelaxedMfaEnvironment(withEnv({ LEVORA_ENVIRONMENT: "production" }))).toBe(false);
    expect(isRelaxedMfaEnvironment(withEnv({ LEVORA_ENVIRONMENT: "qa-local" }))).toBe(false);
  });

  it("não relaxa com banco de nome não reservado (desenvolvimento ou produção) mesmo com as duas variáveis", () => {
    for (const db of ["levora_solidaria", "levora_producao", "postgres", "levora_test_backup", "qa", "levora_QA"]) {
      expect(isRelaxedMfaEnvironment(withEnv({ DATABASE_URL: `postgres://u:p@localhost:5432/${db}` })), db).toBe(false);
    }
  });

  it("não relaxa com host remoto/gerenciado", () => {
    for (const host of ["db.exemplo.com", "10.0.0.5", "meu-banco.rds.amazonaws.com", "localhost.evil.com"]) {
      expect(isRelaxedMfaEnvironment(withEnv({ DATABASE_URL: `postgres://u:p@${host}:5432/levora_x_qa` })), host).toBe(false);
    }
  });

  it("falha fechada: URL ausente, inválida ou ambígua (FLOOT_DATABASE_URL divergente)", () => {
    expect(isRelaxedMfaEnvironment(withEnv({ DATABASE_URL: undefined }))).toBe(false);
    expect(isRelaxedMfaEnvironment(withEnv({ DATABASE_URL: "isto-nao-e-url" }))).toBe(false);
    expect(isRelaxedMfaEnvironment(withEnv({ FLOOT_DATABASE_URL: "postgres://u:p@localhost:5432/levora_solidaria" }))).toBe(false);
    expect(isRelaxedMfaEnvironment(withEnv({ FLOOT_DATABASE_URL: base.DATABASE_URL }))).toBe(true); // alias idêntico não é ambíguo
  });

  it("parâmetros de conexão na query (host, hostaddr, port, dbname, service...) tornam a URL ambígua: não relaxa", () => {
    for (const q of ["host=prod.exemplo.com", "hostaddr=10.0.0.5", "port=6543", "dbname=producao", "database=producao", "db=producao", "service=prod", "options=-c%20x%3D1", "HOST=prod"]) {
      expect(isRelaxedMfaEnvironment(withEnv({ DATABASE_URL: `postgres://u:p@localhost:5433/levora_x_qa?${q}` })), q).toBe(false);
    }
    expect(isRelaxedMfaEnvironment(withEnv({ DATABASE_URL: "postgres://u:p@localhost:5433/levora_x_qa?sslmode=disable" }))).toBe(true); // parâmetro inofensivo
  });

  it("combinações multi-host e credenciais enganosas não passam", () => {
    for (const u of ["postgres://localhost@db.exemplo.com/levora_x_qa", "postgres://u:p@localhost,prod.exemplo.com:5432/levora_x_qa", "postgres://u:p@/levora_x_qa"]) {
      expect(isRelaxedMfaEnvironment(withEnv({ DATABASE_URL: u })), u).toBe(false);
    }
  });

  it("outra variável de ambiente declarando produção vence", () => {
    for (const name of ["APP_ENV", "ENVIRONMENT", "DEPLOY_ENV", "RAILWAY_ENVIRONMENT", "VERCEL_ENV"]) {
      for (const value of ["production", "prod", "live", "Produção"]) {
        expect(isRelaxedMfaEnvironment(withEnv({ [name]: value })), `${name}=${value}`).toBe(false);
      }
    }
    expect(isRelaxedMfaEnvironment(withEnv({ APP_ENV: "development" }))).toBe(true);
  });
});
