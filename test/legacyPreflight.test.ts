/**
 * Pré-verificação de dados legados (db/legacyPreflight.ts, `npm run db:preflight` e o início de `npm run db:migrate:incremental`): detecta, ANTES de qualquer escrita, os dados
 * antigos que impediriam as restrições das migrações pendentes 0005, 0007 e 0013 (provadas em test/schemaMigrationsData.test.ts). Aqui: bancos descartáveis `*_mig_pf*_test` a
 * partir do baseline congelado (590ff60), o runner e os comandos REAIS em processo separado, dados sintéticos. A falha de uma verificação nunca autoriza a atualização.
 */
import { describe, it, expect, afterAll } from "vitest";
import postgres from "postgres";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { runPreflight, formatPreflight, CHECKS, MAX_IDS_SHOWN, PREFLIGHT_EXIT } from "../db/legacyPreflight";

const ROOT = process.cwd();
const BASE = new URL(process.env.DATABASE_URL!);
const PREFIX = BASE.pathname.slice(1).replace(/_test$/, "").toLowerCase();
const urlFor = (db: string) => { const u = new URL(BASE); u.pathname = `/${db}`; return u.toString(); };
const FILES = readdirSync(path.join(ROOT, "db", "migrations")).filter((f) => f.endsWith(".sql")).sort();
const BASELINE = readFileSync(path.join(ROOT, "test", "fixtures", "schema-baseline-590ff60.sql"), "utf8");
const created: string[] = []; const handles: postgres.Sql[] = [];
let admin: postgres.Sql | undefined;
const getAdmin = () => { if (!admin) { const a = new URL(BASE); a.pathname = "/postgres"; admin = postgres(a.toString(), { max: 1, prepare: false, onnotice: () => {} }); } return admin; };

const SEED = `
INSERT INTO users (id,email,display_name) VALUES (1,'ana.souza@exemplo.org','Ana'),(2,'bruno.lima@exemplo.org','Bruno');
INSERT INTO organizations (id,name,slug,type,status,city,state,created_by_user_id) VALUES (1,'Associação Esperança','associacao-esperanca','organizacao_social','ativa','Contagem','MG',1);
INSERT INTO sources (id,name,type,connector_key,created_by_user_id) VALUES (1,'Cadastro manual','manual','manual',1);
INSERT INTO opportunity_registry (id,source_id,title,quantity) VALUES (1,1,'40 cobertores',5);
INSERT INTO opportunity_allocations (id,opportunity_registry_id,organization_id,quantity_allocated,status) VALUES (1,1,1,5,'aceita'),(2,1,1,1,'aceita');
INSERT INTO match_evaluations (id,opportunity_registry_id,organization_id,criteria,final_score,algorithm_version,decision,allocation_id) VALUES (1,1,1,'{}',50,'1.3','atribuir',1);`;
const BAD_EMAIL = `INSERT INTO users (id,email,display_name) VALUES (3,'ANA.SOUZA@exemplo.org','Ana (duplicada por maiúsculas)');`;
const BAD_QTY = `INSERT INTO opportunity_registry (id,source_id,title,quantity) VALUES (2,1,'quantidade zerada',0),(3,1,'quantidade negativa',-2);`;
const BAD_EVAL = `INSERT INTO match_evaluations (id,opportunity_registry_id,organization_id,criteria,final_score,algorithm_version,decision,allocation_id) VALUES (2,1,1,'{}',60,'1.2','duplicada',1);`;
const FIX_EMAIL = `DELETE FROM users WHERE id = 3;`; const FIX_QTY = `UPDATE opportunity_registry SET quantity = NULL WHERE id IN (2,3);`; const FIX_EVAL = `UPDATE match_evaluations SET allocation_id = NULL WHERE id = 2;`;

let counter = 0;
async function mkdb(extraSql = "", opts: { baseline?: boolean } = {}) {
  const name = `${PREFIX}_mig_pf${++counter}_test`;
  if (!name.endsWith("_test") || !name.includes("_mig_pf")) throw new Error("banco descartável fora do padrão");
  await getAdmin().unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await getAdmin().unsafe(`CREATE DATABASE "${name}"`); created.push(name);
  const sql = postgres(urlFor(name), { max: 1, prepare: false, onnotice: () => {} }); handles.push(sql);
  if (opts.baseline !== false) { await sql.unsafe(BASELINE); await sql.unsafe(SEED); if (extraSql) await sql.unsafe(extraSql); }
  return { name, sql };
}
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const cli = (script: string, dbUrl: string, env: Record<string, string> = {}) => { const r = spawnSync(process.execPath, [TSX, script], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test", DATABASE_URL: dbUrl, ...env }, timeout: 120000 }); return { status: r.status, out: `${r.stdout}${r.stderr}` }; };
const preflightCli = (name: string) => cli("db/preflight.ts", urlFor(name));
const runnerCli = (name: string) => cli("db/run-migrations.ts", urlFor(name));
const appliedIn = (out: string) => [...out.matchAll(/Aplicada com sucesso: (\S+)/g)].map((m) => m[1]);
/** Impressão digital de todas as tabelas do baseline: detecta QUALQUER alteração de dado. */
async function fingerprint(sql: postgres.Sql) {
  const tables = (await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`).map((r) => String(r.table_name)).filter((t) => t !== "schema_migrations");
  const fp: Record<string, string> = {};
  for (const t of tables) fp[t] = String((await sql.unsafe(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`))[0].h);
  return fp;
}
const exists = async (sql: postgres.Sql, rel: string) => Boolean((await sql`SELECT to_regclass(${`public.${rel}`}) IS NOT NULL AS e`)[0].e);

afterAll(async () => {
  for (const h of handles) await h.end({ timeout: 2 }).catch(() => undefined);
  if (admin) { for (const n of created) await admin.unsafe(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`).catch(() => undefined); await admin.end({ timeout: 2 }).catch(() => undefined); }
}, 60000);

describe("caminhos sem bloqueio", () => {
  it("banco sem conflitos: autorizada (código 0), as 3 migrações pendentes 'limpas', nada é criado nem alterado, e repetir dá o mesmo resultado", async () => {
    const { name, sql } = await mkdb();
    const before = await fingerprint(sql);
    const first = preflightCli(name); const second = preflightCli(name);
    expect(first.status, first.out).toBe(0); expect(second.out).toBe(first.out); // determinística e sem efeitos
    for (const c of CHECKS) expect(first.out).toContain(`[pendente-limpa] ${c.migration}`);
    expect(first.out).toContain("AUTORIZADA");
    expect(await exists(sql, "schema_migrations")).toBe(false); // nem a tabela de controle foi criada
    expect(await fingerprint(sql)).toEqual(before);
  }, 120000);

  it("runner real depois da autorização: aplica as 13 migrações UMA vez e na ordem; a segunda execução não reaplica; a pré-verificação passa a ver as três como já aplicadas", async () => {
    const { name, sql } = await mkdb();
    const run = runnerCli(name);
    expect(run.status, run.out).toBe(0);
    expect(appliedIn(run.out)).toEqual(FILES); // ordem original preservada
    expect(run.out.indexOf("AUTORIZADA")).toBeLessThan(run.out.indexOf("Aplicando:")); // a verificação veio ANTES da primeira migração
    const again = runnerCli(name);
    expect(again.status).toBe(0); expect(again.out).toContain("Nenhuma migração pendente"); expect(appliedIn(again.out)).toEqual([]);
    const pf = preflightCli(name); expect(pf.status).toBe(0);
    for (const c of CHECKS) expect(pf.out).toContain(`[ja-aplicada] ${c.migration}`);
    expect((await sql`SELECT count(*)::int AS n FROM schema_migrations`)[0].n).toBe(FILES.length);
  }, 180000);

  it("instalação nova por db/schema.sql (db:migrate): as restrições já estão presentes e registradas — autorizada, e o runner incremental é um no-op", async () => {
    const { name } = await mkdb("", { baseline: false });
    const inst = cli("db/migrate.ts", urlFor(name)); expect(inst.status, inst.out).toBe(0);
    const pf = preflightCli(name); expect(pf.status, pf.out).toBe(0);
    for (const c of CHECKS) expect(pf.out).toContain(`[ja-aplicada] ${c.migration}`);
    const run = runnerCli(name); expect(run.status).toBe(0); expect(run.out).toContain("Nenhuma migração pendente");
  }, 180000);
});

describe("bloqueio por dados legados: nada é aplicado, registrado ou alterado", () => {
  const cases: Array<[string, string, string, string, string, RegExp]> = [
    ["0013 — e-mails que diferem só em maiúsculas/minúsculas", BAD_EMAIL, FIX_EMAIL, "0013_users_email_case_insensitive.sql", "organization_invites", /ids impeditivos: 1,3\b/],
    ["0005 — quantidade de oportunidade ≤ 0", BAD_QTY, FIX_QTY, "0005_opportunity_registry_quantity_check.sql", "organization_invites", /ids impeditivos: 2 \| 3\b/],
    ["0007 — avaliações duplicadas para a mesma alocação", BAD_EVAL, FIX_EVAL, "0007_need_fulfillments_fk_restrict.sql", "organization_invites", /ids impeditivos: 1,2\b/],
  ];
  for (const [label, bad, fix, migration, newTable, ids] of cases) {
    it(`${label}: preflight e runner saem com 2, identificam os registros por id, não vazam e-mail e, corrigido o dado, a atualização conclui`, async () => {
      const { name, sql } = await mkdb(bad);
      const before = await fingerprint(sql);
      const pf = preflightCli(name);
      expect(pf.status, pf.out).toBe(2);
      expect(pf.out).toContain(`[pendente-com-conflito] ${migration}`); expect(pf.out).toMatch(ids); expect(pf.out).toContain("BLOQUEADA-POR-DADOS");
      expect(pf.out).not.toMatch(/@|exemplo\.org|ana\.souza|bruno/i); // nenhum dado pessoal
      const run = runnerCli(name);
      expect(run.status, run.out).toBe(2); expect(appliedIn(run.out)).toEqual([]); expect(run.out).not.toContain("Aplicando:");
      expect(await exists(sql, "schema_migrations")).toBe(false); // nenhuma migração registrada (nem a tabela)
      expect(await exists(sql, newTable)).toBe(false); // nem a 0001 (a primeira) foi aplicada
      expect(await fingerprint(sql)).toEqual(before); // nenhum dado foi tocado
      // reaplicável depois da correção manual (não fica bloqueado por um resultado anterior)
      await sql.unsafe(fix);
      const ok = runnerCli(name); expect(ok.status, ok.out).toBe(0); expect(appliedIn(ok.out)).toEqual(FILES);
    }, 180000);
  }

  it("várias condições ao mesmo tempo: as três aparecem no mesmo relatório e cada correção parcial remove só o seu bloqueio", async () => {
    const { name, sql } = await mkdb(BAD_EMAIL + BAD_QTY + BAD_EVAL);
    const all = preflightCli(name); expect(all.status).toBe(2);
    for (const c of CHECKS) expect(all.out).toContain(`[pendente-com-conflito] ${c.migration}`);
    await sql.unsafe(FIX_EMAIL); const two = preflightCli(name);
    expect(two.status).toBe(2); expect(two.out).toContain("[pendente-limpa] 0013_users_email_case_insensitive.sql"); expect(two.out).toContain("[pendente-com-conflito] 0005_"); expect(two.out).toContain("[pendente-com-conflito] 0007_");
    await sql.unsafe(FIX_QTY); const one = preflightCli(name);
    expect(one.status).toBe(2); expect(one.out).toContain("[pendente-limpa] 0005_"); expect(one.out).toContain("[pendente-com-conflito] 0007_");
    await sql.unsafe(FIX_EVAL); expect(preflightCli(name).status).toBe(0);
  }, 180000);

  it("limites de saída: acima de 20 grupos mostra os 20 primeiros, avisa quantos faltam e informa a contagem exata", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => `(${100 + i},1,'zerada ${i}',0)`).join(",");
    const { sql } = await mkdb(`INSERT INTO opportunity_registry (id,source_id,title,quantity) VALUES ${rows};`);
    const r = await runPreflight(sql, FILES);
    const c = r.results.find((x) => x.migration.startsWith("0005"))!;
    expect(c.conflictingRows).toBe(25); expect(c.offendingGroups).toHaveLength(MAX_IDS_SHOWN + 1); // 20 ids + o aviso de quantos faltam
    expect(c.offendingGroups!.at(-1)).toBe("… e mais 5"); expect(c.offendingGroups!.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => String(100 + i)));
    expect(formatPreflight(r)).toContain("25 registro(s) impedem");
  });
});

describe("a verificação concorda com o banco sobre o que é 'duplicado' (mesma expressão e collation do índice)", () => {
  it("para pares de e-mails com maiúsculas, acentos, espaços e letras especiais, o veredito da pré-verificação é IGUAL ao de criar o índice de verdade", async () => {
    const { sql } = await mkdb();
    const pairs: Array<[string, string]> = [["Ana@x.com", "ana@x.com"], ["JOSÉ@x.com", "josé@x.com"], ["a@x.com", "a@x.com "], ["İ@x.com", "i@x.com"], ["ǅ@x.com", "ǆ@x.com"], ["ß@x.com", "SS@x.com"], ["a@x.com", "a＠x.com"], ["MARIA@X.COM", "maria@x.com"]];
    const verdicts: string[] = [];
    for (const [a, b] of pairs) {
      let preflightSaysConflict = false; let indexFails = false;
      await sql.begin(async (tx) => {
        await tx`DELETE FROM users WHERE id > 2`;
        await tx`INSERT INTO users (id, email, display_name) VALUES (50, ${a}, 'a'), (51, ${b}, 'b')`;
        const r = await runPreflight({ begin: (_m: unknown, fn: (t: never) => unknown) => fn(tx as never) } as never, FILES);
        preflightSaysConflict = r.results.find((x) => x.migration.startsWith("0013"))!.state === "pendente-com-conflito";
        await tx`SAVEPOINT s`;
        try { await tx.unsafe(`CREATE UNIQUE INDEX idx_probe_email_lower ON users (LOWER(email))`); } catch { indexFails = true; }
        await tx`ROLLBACK TO SAVEPOINT s`;
        throw new Error("desfaz");
      }).catch((e) => { if (e.message !== "desfaz") throw e; });
      expect({ par: [a, b], preflight: preflightSaysConflict }).toEqual({ par: [a, b], preflight: indexFails });
      verdicts.push(`${a}|${b}:${indexFails}`);
    }
    expect(verdicts.find((v) => v.startsWith("Ana@x.com"))).toBe("Ana@x.com|ana@x.com:true"); // o caso básico realmente conflita
    expect(verdicts.find((v) => v.startsWith("a@x.com|a@x.com "))).toBe("a@x.com|a@x.com :false"); // espaço no fim NÃO é maiúscula/minúscula: não conflita
  }, 120000);
});

describe("estado do banco: inconsistências e estruturas ausentes não autorizam a atualização", () => {
  const FUTURE = [...FILES, "0099_migracao_futura.sql"]; // simula uma migração nova ainda pendente
  const installed = async () => { const d = await mkdb("", { baseline: false }); expect(cli("db/migrate.ts", urlFor(d.name)).status).toBe(0); return d; };

  it("restrição registrada como aplicada mas AUSENTE no banco → bloqueada por estado quando há migração pendente", async () => {
    const { sql } = await installed(); await sql.unsafe(`DROP INDEX idx_users_email_lower`);
    const r = await runPreflight(sql, FUTURE);
    expect(r.status).toBe("bloqueada-por-estado"); expect(r.exitCode).toBe(PREFLIGHT_EXIT.BLOCKED);
    expect(r.results.find((x) => x.migration.startsWith("0013"))).toMatchObject({ state: "inconsistente" });
    expect(formatPreflight(r)).toMatch(/NÃO existe no banco/);
  }, 120000);

  it("restrição que já existe mas a migração NÃO está registrada → bloqueada (o runner falharia ao recriá-la)", async () => {
    const { sql } = await installed(); await sql`DELETE FROM schema_migrations WHERE id = '0013_users_email_case_insensitive.sql'`;
    const r = await runPreflight(sql, FILES);
    expect(r.status).toBe("bloqueada-por-estado");
    expect(formatPreflight(r)).toMatch(/NÃO registrada em schema_migrations, mas a restrição já existe/);
  }, 120000);

  it("sem migração pendente o estado estranho vira AVISO (não há atualização a autorizar); migração desconhecida registrada também é só aviso", async () => {
    const { sql } = await installed(); await sql.unsafe(`DROP INDEX idx_users_email_lower`);
    const r = await runPreflight(sql, FILES);
    expect(r.status).toBe("autorizada"); expect(r.warnings.join(" ")).toContain("0013");
    await sql`INSERT INTO schema_migrations (id) VALUES ('0042_de_uma_versao_futura.sql')`;
    expect((await runPreflight(sql, FILES)).warnings.join(" ")).toContain("não conhece");
  }, 120000);

  it("tabela/coluna esperada ausente → 'estrutura-ausente', bloqueada; banco totalmente vazio também (não é o ponto histórico esperado)", async () => {
    const { sql } = await mkdb(); await sql.unsafe(`DROP TABLE match_evaluations CASCADE`);
    const r = await runPreflight(sql, FILES);
    expect(r.status).toBe("bloqueada-por-estado"); expect(r.results.find((x) => x.migration.startsWith("0007"))).toMatchObject({ state: "estrutura-ausente" });
    const empty = await mkdb("", { baseline: false });
    const e = preflightCli(empty.name); expect(e.status).toBe(2); expect(e.out).toContain("estrutura-ausente"); expect(e.out).toContain("npm run db:migrate");
    const run = runnerCli(empty.name); expect(run.status).toBe(2); expect(await exists(empty.sql, "schema_migrations")).toBe(false);
  }, 180000);
});

describe("falhas de infraestrutura nunca autorizam a atualização", () => {
  it("banco indisponível: código 3, sem URL, host ou senha no diagnóstico; o runner também sai com 3 e não aplica nada", () => {
    const dead = `postgres://usuario_teste:senha-secreta-123@127.0.0.1:1/${PREFIX}_mig_pfx_test`;
    for (const script of ["db/preflight.ts", "db/run-migrations.ts"]) {
      const r = cli(script, dead); expect(r.status, `${script}: ${r.out}`).toBe(3);
      expect(r.out).toContain("NÃO está autorizada"); expect(r.out).not.toMatch(/senha-secreta|usuario_teste|postgres:\/\/|127\.0\.0\.1/); expect(r.out).not.toContain("Aplicando:");
    }
  }, 120000);

  it("erro na consulta de pré-verificação (no meio ou no início) → 'nao-verificada' (código 3), nunca autorizada", async () => {
    const boom = (failAt: number) => ({ begin: async (_m: unknown, fn: (tx: never) => unknown) => {
      let n = 0; const tx = new Proxy(async () => undefined, { apply: () => { if (++n >= failAt) throw Object.assign(new Error("falha forçada postgres://u:p@h/db"), { code: "57P01" }); return Promise.resolve([{ e: true }]); }, get: (_t, p) => (p === "unsafe" ? () => { throw Object.assign(new Error("falha forçada"), { code: "42501" }); } : undefined) });
      return fn(tx as never);
    } });
    for (const at of [1, 2, 3]) {
      const r = await runPreflight(boom(at) as never, FILES);
      expect(r.status).toBe("nao-verificada"); expect(r.exitCode).toBe(PREFLIGHT_EXIT.UNVERIFIED); expect(r.results.every((x) => x.state !== "pendente-limpa" && x.state !== "ja-aplicada")).toBe(true);
      expect(formatPreflight(r)).not.toMatch(/postgres:\/\//); expect(formatPreflight(r)).toContain("NÃO está autorizada");
    }
    const rejected = await runPreflight({ begin: async () => { throw Object.assign(new Error("ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" }); } } as never, FILES);
    expect(rejected.exitCode).toBe(3); expect(formatPreflight(rejected)).not.toContain("10.0.0.5"); expect(formatPreflight(rejected)).toContain("ECONNREFUSED");
  });
});

describe("somente leitura (verificável)", () => {
  it("roda numa transação READ ONLY; uma escrita nela é recusada pelo Postgres", async () => {
    const { sql } = await mkdb();
    let ro = "";
    const spying = { begin: (mode: string, fn: (tx: postgres.Sql) => Promise<unknown>) => sql.begin(mode, async (tx) => { const out = await fn(tx); ro = String(Object.values((await tx`SHOW transaction_read_only`)[0])[0]); return out; }) };
    await runPreflight(spying as never, FILES); expect(ro).toBe("on");
    await expect(sql.begin("read only", async (tx) => { await tx`UPDATE users SET display_name = 'x' WHERE id = 1`; })).rejects.toMatchObject({ code: "25006" });
  }, 120000);

  it("o código-fonte da verificação não contém nenhum comando de escrita ou de alteração de estrutura", () => {
    const src = readFileSync(path.join(ROOT, "db", "legacyPreflight.ts"), "utf8").split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const strings = [...src.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join("\n");
    expect(strings).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i);
    const cliSrc = readFileSync(path.join(ROOT, "db", "preflight.ts"), "utf8");
    expect(cliSrc).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE TABLE|ALTER|DROP)\b/);
  });

  it("o desvio de testes (LEVORA_SKIP_PREFLIGHT) NÃO funciona fora de NODE_ENV=test: o bloqueio continua valendo", async () => {
    const { name, sql } = await mkdb(BAD_QTY);
    const r = spawnSync(process.execPath, [TSX, "db/run-migrations.ts"], { encoding: "utf8", env: { ...process.env, NODE_ENV: "production", DATABASE_URL: urlFor(name), LEVORA_SKIP_PREFLIGHT: "1" }, timeout: 120000 });
    expect(r.status).toBe(2); expect(`${r.stdout}${r.stderr}`).not.toContain("IGNORADA"); expect(await exists(sql, "schema_migrations")).toBe(false);
  }, 120000);
});
