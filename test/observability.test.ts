/**
 * M46 — observabilidade mínima: liveness × readiness, schema incompatível não é "pronto", banco indisponível, logs estruturados sem segredos, instrumentação sem efeito no resultado.
 * Banco sintético descartável; nenhuma chamada externa.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { Kysely, sql } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import { buildApp } from "../server/index";
import { db } from "../src/helpers/db";
import { checkReadiness } from "../src/helpers/readiness";
import { buildLogLine, redactErrorArgs, safeErrorCode, sanitizeContext, withOperationLog } from "../src/helpers/opLog";
import { setSchedulerStatus } from "../src/helpers/schedulerControl";

let server: Server;
let base: string;
beforeAll(async () => {
  const app = await buildApp();
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const tmpMigrations = (files: string[]) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "levora-mig-"));
  for (const f of files) fs.writeFileSync(path.join(d, f), "-- sintetico");
  return d;
};
async function stampMigrations(ids: string[]) {
  await sql`create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())`.execute(db);
  await sql`delete from schema_migrations`.execute(db);
  for (const id of ids) await sql`insert into schema_migrations (id) values (${id})`.execute(db);
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setSchedulerStatus({ started: false, tasks: [] });
});

describe("liveness x readiness", () => {
  it("liveness responde 200 sem consultar o banco e nao vaza detalhes", async () => {
    const res = await fetch(`${base}/_api/__health`);
    expect(res.status).toBe(200);
    expect(Object.keys(await res.json()).sort()).toEqual(["apiVersion", "endpoints", "status"]);
  });

  it("readiness: 200 quando o banco responde e todas as migrations do codigo estao registradas; mostra o agendador de agentes desabilitado por padrao", async () => {
    delete process.env.AGENT_EVENTS_SCHEDULER_ENABLED;
    const dir = tmpMigrations(["0001_a.sql", "0002_b.sql"]);
    await stampMigrations(["0001_a.sql", "0002_b.sql"]);
    const r = await checkReadiness({ migrationsDir: dir });
    expect(r).toEqual({ ready: true, checks: { database: "ok", schema: "ok", scheduler: "nao_iniciado", agentEventsScheduler: "desabilitado" } });
    vi.stubEnv("AGENT_EVENTS_SCHEDULER_ENABLED", "true");
    expect((await checkReadiness({ migrationsDir: dir })).checks.agentEventsScheduler).toBe("habilitado");
  });

  it("schema incompativel (migration do codigo nao registrada, ou tabela de controle ausente) NAO e pronto", async () => {
    const dir = tmpMigrations(["0001_a.sql", "0002_b.sql", "0003_c.sql"]);
    await stampMigrations(["0001_a.sql", "0002_b.sql"]);
    expect(await checkReadiness({ migrationsDir: dir })).toMatchObject({ ready: false, checks: { database: "ok", schema: "desatualizado" } });
    await sql`drop table schema_migrations`.execute(db);
    expect(await checkReadiness({ migrationsDir: dir })).toMatchObject({ ready: false, checks: { schema: "desatualizado" } });
    expect(await checkReadiness({ migrationsDir: null })).toMatchObject({ ready: false });
  });

  it("banco indisponivel: readiness falha, enquanto a liveness continua 200", async () => {
    const dead = postgres("postgres://postgres@127.0.0.1:1/inexistente", { max: 1, connect_timeout: 1, prepare: false });
    const deadDb = new Kysely<any>({ dialect: new PostgresJSDialect({ postgres: dead }) });
    const r = await checkReadiness({ db: deadDb, migrationsDir: tmpMigrations(["0001_a.sql"]) });
    expect(r).toMatchObject({ ready: false, checks: { database: "falha", schema: "nao_verificado" } });
    await dead.end({ timeout: 1 });
    expect((await fetch(`${base}/_api/__health`)).status).toBe(200);
  });

  it("endpoint /_api/__ready: 200 com schema ok e 503 sem; corpo sem nomes de migration, erros ou URLs", async () => {
    const files = fs.readdirSync(path.resolve(__dirname, "../db/migrations")).filter((f) => f.endsWith(".sql"));
    await stampMigrations(files);
    const ok = await fetch(`${base}/_api/__ready`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("ready");
    await stampMigrations(files.slice(0, -1));
    const bad = await fetch(`${base}/_api/__ready`);
    expect(bad.status).toBe(503);
    const text = JSON.stringify(await bad.json());
    expect(text).not.toMatch(/\.sql|postgres:|127\.0\.0\.1|password|DATABASE_URL/i);
  });
});

describe("log estruturado: minimizacao e seguranca", () => {
  it("sanitiza contexto (remove chaves sensiveis, trunca strings) e converte erro em codigo, nunca em mensagem", () => {
    const ctx = sanitizeContext({ route: "x", password: "senha-secreta", token: "t0k", email: "a@b.c", authorization: "Bearer x", documento: "123", note: "n".repeat(500) });
    expect(Object.keys(ctx).sort()).toEqual(["note", "route"]);
    expect(String(ctx.note).length).toBeLessThan(130);
    expect(safeErrorCode(Object.assign(new Error("valor secreto da coluna cpf=123"), { code: "23505" }))).toBe("23505");
    expect(safeErrorCode(new TypeError("conteudo sensivel"))).toBe("TypeError");
    expect(safeErrorCode("texto qualquer com segredo")).toBe("ERRO_DESCONHECIDO");
    const line = buildLogLine({ event: "e", status: "falha", errorCode: "X", context: { route: "r", senha: "s3nha" } });
    expect(line).not.toMatch(/s3nha/);
    expect(JSON.parse(line)).toMatchObject({ event: "e", status: "falha", level: "error", errorCode: "X" });
  });

  it("filtro central de console.error: objetos de erro (com valores de coluna na mensagem) viram codigo; strings do desenvolvedor passam", () => {
    const pgLike = Object.assign(new Error('duplicate key value violates unique constraint; Key (email)=(pessoa@exemplo.test) already exists'), { code: "23505" });
    const out = redactErrorArgs(["Erro ao criar:", pgLike, 42]);
    expect(out).toEqual(["Erro ao criar:", "[erro 23505]", 42]);
    expect(JSON.stringify(out)).not.toMatch(/pessoa@exemplo/);
  });

  it("withOperationLog nao altera o resultado nem o erro de negocio e registra duracao/codigo", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await withOperationLog("op", { a: 1 }, async () => 42)).toBe(42);
    const boom = Object.assign(new Error("detalhe sensivel"), { code: "P0001" });
    await expect(withOperationLog("op", {}, async () => { throw boom; })).rejects.toBe(boom);
    const okLine = JSON.parse(String(out.mock.calls[0][0]));
    const failLine = JSON.parse(String(err.mock.calls[0][0]));
    expect(okLine).toMatchObject({ status: "ok", event: "op" });
    expect(typeof okLine.durationMs).toBe("number");
    expect(failLine).toMatchObject({ status: "falha", errorCode: "P0001" });
    expect(JSON.stringify(failLine)).not.toMatch(/sensivel/);
  });

  it("cada requisicao gera UMA linha http_request (rota registrada, status, duracao, request id) e nada do corpo/cabecalhos; o id volta ao cliente", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => { lines.push(String(m)); });
    vi.spyOn(console, "error").mockImplementation((m: unknown) => { lines.push(String(m)); });
    const res = await fetch(`${base}/_api/v1/auth/login_with_password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session=COOKIE-SECRETO-123", authorization: "Bearer TOKEN-SECRETO-456" },
      body: JSON.stringify({ email: "pessoa@exemplo.test", password: "SENHA-SECRETA-789" }),
    });
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const http = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((l) => l?.event === "http_request");
    expect(http).toHaveLength(1);
    expect(http[0]).toMatchObject({ operationId: id, context: { route: "auth/login_with_password", method: "POST", httpStatus: res.status } });
    const all = lines.join("\n");
    for (const secret of ["COOKIE-SECRETO-123", "TOKEN-SECRETO-456", "SENHA-SECRETA-789", "pessoa@exemplo.test"]) expect(all).not.toContain(secret);
  });
});
