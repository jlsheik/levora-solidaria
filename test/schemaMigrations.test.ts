/**
 * Caminho de ATUALIZAÇÃO × instalação NOVA do banco. A suíte, o `qa:visual`/`qa:security` e o staging usam `db/schema.sql` (instalação nova), mas um banco que já
 * existe é atualizado por `db/migrations/*.sql` via `npm run db:migrate:incremental`. Nenhum teste garantia que os dois chegam ao MESMO schema, nem que o registro
 * `schema_migrations` fica coerente — o que, se divergisse, faria os testes validarem um banco que a produção não tem (ou faria `db:migrate:incremental` tentar recriar
 * o que já existe). Aqui, em bancos descartáveis cujo nome termina em `_test` (criados e removidos pelo próprio teste):
 *   A = `npm run db:migrate` (schema.sql + registro das migrações) · B = baseline congelado (commit 590ff60, antes de qualquer migração) + `db:migrate:incremental`.
 * O catálogo (colunas, constraints, índices, gatilhos, funções, tabelas, enums) de A e B precisa ser idêntico.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BASE = new URL(process.env.DATABASE_URL!);
const NAME_A = `${BASE.pathname.slice(1).replace(/_test$/, "")}_driftA_test`.toLowerCase();
const NAME_B = `${BASE.pathname.slice(1).replace(/_test$/, "")}_driftB_test`.toLowerCase();
const urlFor = (db: string) => { const u = new URL(BASE); u.pathname = `/${db}`; return u.toString(); };
const migrationFiles = readdirSync(path.join(ROOT, "db", "migrations")).filter((f) => f.endsWith(".sql")).sort();

let admin: postgres.Sql; let A: postgres.Sql; let B: postgres.Sql;
const logs: Record<string, string> = {};

const cli = (script: string, dbName: string) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), script], { encoding: "utf8", env: { ...process.env, DATABASE_URL: urlFor(dbName) }, timeout: 120000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

/** Catálogo normalizado: comentários e espaços dentro de funções não contam (só o comportamento). */
async function catalog(sql: postgres.Sql) {
  const q = async (text: string) => (await sql.unsafe(text)).map((r) => String((r as { v: string }).v)).sort();
  const norm = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  return {
    tables: await q(`SELECT table_name AS v FROM information_schema.tables WHERE table_schema='public' AND table_name <> 'schema_migrations'`),
    columns: await q(`SELECT table_name||'.'||column_name||' '||data_type||' '||is_nullable||' '||coalesce(column_default,'') AS v FROM information_schema.columns WHERE table_schema='public' AND table_name <> 'schema_migrations'`),
    constraints: await q(`SELECT conrelid::regclass::text||' '||contype::text||' '||pg_get_constraintdef(oid) AS v FROM pg_constraint WHERE connamespace='public'::regnamespace AND conrelid::regclass::text <> 'schema_migrations'`),
    indexes: await q(`SELECT indexdef AS v FROM pg_indexes WHERE schemaname='public' AND tablename <> 'schema_migrations'`),
    triggers: await q(`SELECT pg_get_triggerdef(t.oid) AS v FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace`),
    functions: (await q(`SELECT pg_get_functiondef(p.oid) AS v FROM pg_proc p WHERE p.pronamespace='public'::regnamespace`)).map(norm).sort(),
    enums: await q(`SELECT t.typname||' '||string_agg(e.enumlabel,',' ORDER BY e.enumsortorder) AS v FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid GROUP BY t.typname`),
  };
}

async function recreate(name: string) {
  if (!name.endsWith("_test")) throw new Error(`banco descartável fora do padrão: ${name}`); // nunca derruba/cria fora de *_test
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${name}"`);
}

beforeAll(async () => {
  if (!BASE.pathname.slice(1).endsWith("_test")) throw new Error("DATABASE_URL de teste deve terminar em _test");
  const adminUrl = new URL(BASE); adminUrl.pathname = "/postgres";
  admin = postgres(adminUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  await recreate(NAME_A); await recreate(NAME_B);
  A = postgres(urlFor(NAME_A), { max: 1, prepare: false, onnotice: () => {} });
  B = postgres(urlFor(NAME_B), { max: 1, prepare: false, onnotice: () => {} });
  // A: instalação nova pelo comando real
  logs.A = cli("db/migrate.ts", NAME_A).out;
  logs.A2 = cli("db/run-migrations.ts", NAME_A).out;
  // B: baseline congelado + atualização incremental pelo comando real (duas vezes: a segunda não pode aplicar nada)
  await B.unsafe(readFileSync(path.join(ROOT, "test", "fixtures", "schema-baseline-590ff60.sql"), "utf8"));
  logs.B1 = cli("db/run-migrations.ts", NAME_B).out;
  logs.B2 = cli("db/run-migrations.ts", NAME_B).out;
}, 180000);

afterAll(async () => {
  await A?.end({ timeout: 2 }).catch(() => undefined); await B?.end({ timeout: 2 }).catch(() => undefined);
  if (admin) { await admin.unsafe(`DROP DATABASE IF EXISTS "${NAME_A}" WITH (FORCE)`).catch(() => undefined); await admin.unsafe(`DROP DATABASE IF EXISTS "${NAME_B}" WITH (FORCE)`).catch(() => undefined); await admin.end({ timeout: 2 }).catch(() => undefined); }
});

describe("caminho de atualização × instalação nova", () => {
  it("as migrações são numeradas em sequência, sem lacunas nem duplicatas", () => {
    expect(migrationFiles.length).toBeGreaterThanOrEqual(13);
    migrationFiles.forEach((f, i) => expect(f.startsWith(String(i + 1).padStart(4, "0") + "_"), f).toBe(true));
  });

  it("o baseline congelado é de FATO anterior às migrações (não tem as tabelas que elas criam)", async () => {
    const base = readFileSync(path.join(ROOT, "test", "fixtures", "schema-baseline-590ff60.sql"), "utf8");
    for (const created of ["organization_invites", "need_fulfillments", "need_resolutions"]) expect(base).not.toContain(created);
  });

  it("`db:migrate` (instalação nova) registra TODAS as migrações em schema_migrations e `db:migrate:incremental` em seguida não aplica nada", async () => {
    expect(logs.A).toContain("Schema aplicado com sucesso");
    expect((await A`SELECT id FROM schema_migrations ORDER BY id`).map((r) => r.id)).toEqual(migrationFiles);
    expect(logs.A2).toContain("Nenhuma migração pendente");
    expect(logs.A2).not.toContain("Aplicando:");
  });

  it("baseline + `db:migrate:incremental` aplica cada migração uma vez, em ordem, e a segunda execução é um no-op", async () => {
    const applied = [...logs.B1.matchAll(/Aplicada com sucesso: (\S+)/g)].map((m) => m[1]);
    expect(applied).toEqual(migrationFiles);
    expect(logs.B1).toContain(`${migrationFiles.length} migração(ões) aplicada(s).`);
    expect(logs.B2).toContain("Nenhuma migração pendente");
    expect((await B`SELECT id FROM schema_migrations ORDER BY id`).map((r) => r.id)).toEqual(migrationFiles);
  });

  it("os dois caminhos chegam ao MESMO schema: tabelas, colunas, constraints, índices, gatilhos, funções e enums", async () => {
    const [a, b] = [await catalog(A), await catalog(B)];
    for (const key of Object.keys(a) as Array<keyof typeof a>) {
      const onlyInstall = a[key].filter((x) => !b[key].includes(x));
      const onlyUpgrade = b[key].filter((x) => !a[key].includes(x));
      expect({ key, soNaInstalacaoNova: onlyInstall, soNoCaminhoDeAtualizacao: onlyUpgrade }).toEqual({ key, soNaInstalacaoNova: [], soNoCaminhoDeAtualizacao: [] });
      expect(a[key].length, key).toBeGreaterThan(0);
    }
    expect(a.tables.length).toBe(32); // +1 na Fase 98: platform_assignment_settings (0015); +2 na Fase 99C: unit_regularization_cases e _events (0016); +2 na Fase 99D: stock_destinations (0018) e need_closures (0019); +1 na Fase 99E: stock_exit_requests (0020); +1 na Fase 99G: destination_correction_requests (0022)
  });

  it("o catálogo detecta divergência de verdade (controle): uma coluna a mais num dos bancos aparece na comparação", async () => {
    await B.unsafe(`ALTER TABLE users ADD COLUMN controle_de_deriva TEXT`);
    try {
      const [a, b] = [await catalog(A), await catalog(B)];
      expect(b.columns.filter((x) => !a.columns.includes(x)).some((x) => x.includes("controle_de_deriva"))).toBe(true);
    } finally { await B.unsafe(`ALTER TABLE users DROP COLUMN controle_de_deriva`); }
  });
});
