/**
 * Política de DESIGNAÇÃO EXPLÍCITA do Platform Owner na migração 0026 (docs/IDENTIDADE_DECISOES_AUTENTICACAO.md, decisão B), vista pelo PREFLIGHT e pelo RUNNER real.
 * Banco temporário (`*_own_test`) criado a partir do fixture do schema da master anterior à identidade, com 0001–0025 carimbadas em schema_migrations.
 * Só identidades SINTÉTICAS (e-mails @x.com): nenhuma identidade real é escolhida ou promovida.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import postgres from "postgres";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { runPreflight } from "../db/legacyPreflight";
import { pgConnectionFromEnv } from "../db/connectionOptions";

const ROOT = process.cwd();
const BASELINE = readFileSync(path.join(ROOT, "test", "fixtures", "schema-baseline-26a5a45.sql"), "utf8");
const FILES = readdirSync(path.join(ROOT, "db", "migrations")).filter((f) => f.endsWith(".sql")).sort();
const BEFORE_0026 = FILES.filter((f) => f < "0026");
const BASE = new URL(process.env.DATABASE_URL!);
const DB = BASE.pathname.slice(1).replace(/_test$/, "") + "_own_test";
const urlFor = (db: string) => { const u = new URL(BASE); u.pathname = `/${db}`; return u.toString(); };

let admin: postgres.Sql;
let sql: postgres.Sql;
const opened: postgres.Sql[] = [];

async function fresh() {
  if (!admin) { const a = new URL(BASE); a.pathname = "/postgres"; admin = postgres(a.toString(), { max: 1, prepare: false, onnotice: () => {} }); }
  for (const c of opened.splice(0)) await c.end({ timeout: 1 }).catch(() => undefined);
  await admin.unsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${DB}"`);
  sql = postgres(urlFor(DB), { max: 1, prepare: false, onnotice: () => {} });
  opened.push(sql);
  await sql.unsafe(BASELINE);
  await sql.unsafe("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  for (const f of BEFORE_0026) await sql`INSERT INTO schema_migrations (id) VALUES (${f})`;
}

const addUser = async (email: string, role: "admin" | "user" = "user", anonymized = false) =>
  (await sql`INSERT INTO users (email, display_name, role) VALUES (${anonymized ? `usuario-excluido-${Math.floor(Math.random() * 1e6)}@removido.invalid` : email}, ${"U " + email}, ${role}::user_role) RETURNING id`)[0].id as number;

/** Preflight numa conexão NOVA com a designação pedida (o mesmo caminho que db/preflight.ts usa: PGOPTIONS → connection). */
async function preflight(pgOptions?: string) {
  const c = postgres(urlFor(DB), { max: 1, prepare: false, onnotice: () => {}, ...pgConnectionFromEnv(pgOptions ? ({ PGOPTIONS: pgOptions } as NodeJS.ProcessEnv) : {}) });
  try { return await runPreflight(c, FILES); } finally { await c.end({ timeout: 1 }); }
}
const check0026 = (r: Awaited<ReturnType<typeof preflight>>) => r.results.find((x) => x.migration === "0026_identity_foundation.sql")!;
const runner = (pgOptions?: string, skipPreflight = false) => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", DATABASE_URL: urlFor(DB), ...(skipPreflight ? { LEVORA_SKIP_PREFLIGHT: "1" } : {}) };
  delete env.PGOPTIONS; if (pgOptions) env.PGOPTIONS = pgOptions;
  const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "db/run-migrations.ts"], { encoding: "utf8", env, timeout: 120000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const owners = async () => (await sql`SELECT user_id FROM platform_access`.catch(() => [])).map((r) => r.user_id as number);
const registered = async () => (await sql`SELECT count(*)::int AS n FROM schema_migrations`)[0].n as number;

beforeEach(fresh, 60000);
afterAll(async () => {
  for (const c of opened) await c.end({ timeout: 1 }).catch(() => undefined);
  if (admin) { await admin.unsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`).catch(() => undefined); await admin.end({ timeout: 2 }).catch(() => undefined); }
});

describe("preflight da 0026: política de designação explícita (somente leitura)", () => {
  it("0 admins sem designação: autorizada (nada a promover; o owner nasce pelo bootstrap offline)", async () => {
    await addUser("a@x.com");
    const r = await preflight();
    expect(r.exitCode).toBe(0);
    expect(check0026(r).state).toBe("pendente-limpa");
  });

  it("1 admin SEM designação: BLOQUEADA (não promove por contagem), apontando o id e o rótulo", async () => {
    const a = await addUser("admin@x.com", "admin");
    const r = await preflight();
    expect(r.exitCode).toBe(2);
    expect(check0026(r).state).toBe("pendente-com-conflito");
    expect(check0026(r).offendingGroups).toEqual([`designacao_ausente_com_admins:${a}`]);
  });

  it("vários admins SEM designação: BLOQUEADA, listando todos os ids", async () => {
    const ids = [await addUser("a1@x.com", "admin"), await addUser("a2@x.com", "admin"), await addUser("a3@x.com", "admin")];
    const r = await preflight();
    expect(r.exitCode).toBe(2);
    expect(check0026(r).offendingGroups).toEqual([`designacao_ausente_com_admins:${ids.join(",")}`]);
  });

  it("designação VÁLIDA (um dos admins ativos): autorizada, com 1 ou com vários admins", async () => {
    const a1 = await addUser("a1@x.com", "admin");
    expect((await preflight(`-c levora.platform_owner_user_id=${a1}`)).exitCode).toBe(0);
    const a2 = await addUser("a2@x.com", "admin");
    expect((await preflight(`-c levora.platform_owner_user_id=${a2}`)).exitCode).toBe(0);
  });

  it("designação inelegível: usuário comum, admin anonimizado (zumbi) e id inexistente BLOQUEIAM", async () => {
    await addUser("real@x.com", "admin");
    const plain = await addUser("plain@x.com");
    const zombie = await addUser("z@x.com", "admin", true);
    for (const id of [plain, zombie, 999999]) {
      const r = await preflight(`-c levora.platform_owner_user_id=${id}`);
      expect(r.exitCode, `id ${id}`).toBe(2);
      expect(check0026(r).offendingGroups).toEqual(["designacao_inelegivel"]);
    }
  });

  it("0 admins ativos COM designação (inclusive só-zumbis): BLOQUEADA (a designação não corresponderia a ninguém)", async () => {
    const plain = await addUser("plain@x.com");
    expect(check0026(await preflight(`-c levora.platform_owner_user_id=${plain}`)).offendingGroups).toEqual(["designacao_sem_admin_ativo"]);
    await addUser("z@x.com", "admin", true);
    expect(check0026(await preflight(`-c levora.platform_owner_user_id=${plain}`)).offendingGroups).toEqual(["designacao_sem_admin_ativo"]);
  });

  it("senhas duplicadas continuam bloqueando, junto com a regra da designação", async () => {
    const a = await addUser("a@x.com", "admin");
    await sql`INSERT INTO user_passwords (user_id, password_hash) VALUES (${a}, 'h1'), (${a}, 'h2')`;
    const r = await preflight(`-c levora.platform_owner_user_id=${a}`);
    expect(r.exitCode).toBe(2);
    expect(check0026(r).offendingGroups?.[0]).toMatch(/^senhas:/);
  });

  it("SEM EFEITOS COLATERAIS: o preflight não grava nada, não cria platform_access e não registra migração", async () => {
    const a = await addUser("a@x.com", "admin");
    const before = { users: await sql`SELECT id, role FROM users ORDER BY id`, reg: await registered(), tables: (await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`)[0].n };
    await preflight(); await preflight(`-c levora.platform_owner_user_id=${a}`); await preflight(`-c levora.platform_owner_user_id=999`);
    expect((await sql`SELECT id, role FROM users ORDER BY id`).map((r) => ({ ...r }))).toEqual(before.users.map((r) => ({ ...r })));
    expect(await registered()).toBe(before.reg);
    expect((await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`)[0].n).toBe(before.tables);
    expect(await owners()).toEqual([]);
  });
});

describe("runner real (db:migrate:incremental) × designação", () => {
  it("1 admin SEM designação: o runner NÃO inicia (preflight código 2), nenhuma migração é aplicada e ninguém é promovido", async () => {
    await addUser("admin@x.com", "admin");
    const before = await registered();
    const r = runner();
    expect(r.status).toBe(2);
    expect(r.out).toContain("designacao_ausente_com_admins");
    expect(await registered()).toBe(before);
    expect(await owners()).toEqual([]);
  });

  it("mesmo SEM o preflight (defesa em profundidade) a PRÓPRIA migração aborta, atômica, sem promover ninguém", async () => {
    await addUser("admin@x.com", "admin");
    const before = await registered();
    const r = runner(undefined, true);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/Designe o Platform Owner/);
    expect(await registered()).toBe(before);
    expect(await owners()).toEqual([]);
  });

  it("PGOPTIONS ambíguo (parâmetro repetido) ou não autorizado: o runner recusa ANTES de tocar no banco", async () => {
    const a = await addUser("admin@x.com", "admin");
    const before = await registered();
    for (const opts of [`-c levora.platform_owner_user_id=${a} -c levora.platform_owner_user_id=${a}`, `-c levora.platform_owner_user_id=${a} -c statement_timeout=1`, "-c levora.outro=1"]) {
      const r = runner(opts, true);
      expect(r.status, opts).not.toBe(0);
      expect(r.out, opts).toMatch(/PGOPTIONS/);
    }
    expect(await registered()).toBe(before);
    expect(await owners()).toEqual([]);
  });

  it("1 admin COM designação: aplica 0026–0031, o designado vira owner e o preflight que a antecedeu autorizou", async () => {
    const a = await addUser("admin@x.com", "admin");
    await addUser("comum@x.com");
    const r = runner(`-c levora.platform_owner_user_id=${a}`);
    expect(r.status, r.out.slice(-400)).toBe(0);
    expect(await owners()).toEqual([a]);
    expect((await sql`SELECT id FROM schema_migrations WHERE id >= '0026' ORDER BY id`).map((x) => x.id)).toEqual(FILES.filter((f) => f >= "0026"));
    expect(await sql`SELECT id FROM users WHERE role = 'admin'`).toHaveLength(0);
  });

  it("3 admins: só o designado vira owner; os outros dois viram usuários comuns e constam do aviso (evidência no log)", async () => {
    const a1 = await addUser("a1@x.com", "admin"); const a2 = await addUser("a2@x.com", "admin"); const a3 = await addUser("a3@x.com", "admin");
    const r = runner(`-c levora.platform_owner_user_id=${a2}`);
    expect(r.status, r.out.slice(-400)).toBe(0);
    expect(await owners()).toEqual([a2]);
    expect(r.out).toContain(`admins sem acesso de plataforma após a migração: ${a1}, ${a3}`);
    expect((await sql`SELECT id, role FROM users WHERE id IN ${sql([a1, a3])}`).map((x) => x.role)).toEqual(["user", "user"]);
  });

  it("0 admins: o runner conclui SEM owner (bootstrap offline); informar designação nesse caso é recusado", async () => {
    const plain = await addUser("plain@x.com");
    const bad = runner(`-c levora.platform_owner_user_id=${plain}`);
    expect(bad.status).toBe(2);
    expect(await owners()).toEqual([]);
    const ok = runner();
    expect(ok.status, ok.out.slice(-300)).toBe(0);
    expect(await owners()).toEqual([]);
    expect((await sql`SELECT owner_bootstrapped_at FROM platform_state WHERE id = 1`)[0].owner_bootstrapped_at).toBeNull();
  });
});
