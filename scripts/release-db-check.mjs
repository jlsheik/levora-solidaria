#!/usr/bin/env node
/**
 * Validação local de migrations, falha controlada, reexecução, backup e restauração (M46).
 * SOMENTE bancos descartáveis em um PostgreSQL LOCAL. Não usa credenciais reais, não conecta a bancos operacionais, não publica nada.
 *
 * Uso:
 *   RELEASE_CHECK_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres PG_BIN=<pasta bin do postgres> node scripts/release-db-check.mjs [--out <pasta>] [--baseline-ref origin/master] [--keep]
 *
 * Cenários: A banco novo · B atualização incremental a partir do schema anterior (com dados sintéticos preservados e schema final idêntico ao do banco novo) · C falha controlada de migration
 * (nada parcial persiste e a aplicação NÃO fica "pronta") · D reexecução sem efeito · E backup (pg_dump) e restauração (pg_restore) com integridade de dados, restrições e cadeia de auditoria.
 * Resultado local de preparação técnica: NÃO equivale a backup/restauração homologados em infraestrutura real.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const keep = args.includes("--keep");
const baselineRef = argVal("--baseline-ref", "origin/master");
const outDir = path.resolve(argVal("--out", fs.mkdtempSync(path.join(os.tmpdir(), "levora-db-check-"))));
fs.mkdirSync(outDir, { recursive: true });

const adminUrl = process.env.RELEASE_CHECK_ADMIN_URL;
const pgBin = process.env.PG_BIN ?? "";
const bin = (n) => (pgBin ? path.join(pgBin, process.platform === "win32" ? `${n}.exe` : n) : n);
// tsx é chamado direto pelo Node (spawn de .cmd sem shell falha no Windows).
const TSX_CLI = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

function fail(msg) { console.error(`ERRO: ${msg}`); process.exit(2); }
if (!adminUrl) fail("defina RELEASE_CHECK_ADMIN_URL (PostgreSQL LOCAL descartável).");
const parsed = new URL(adminUrl);
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) fail("RELEASE_CHECK_ADMIN_URL precisa apontar para o próprio computador (127.0.0.1/localhost). Recusado para não tocar banco real.");

const stamp = Date.now().toString(36);
const names = { P: `levora_rc_${stamp}_pre`, A: `levora_rc_${stamp}_novo`, B: `levora_rc_${stamp}_upg`, F: `levora_rc_${stamp}_falha`, R: `levora_rc_${stamp}_rest` };
const urlFor = (db) => { const u = new URL(adminUrl); u.pathname = `/${db}`; return u.toString(); };
const created = [];
const results = [];
const log = (m) => console.log(m);

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, encoding: "utf-8", shell: false, env: { ...process.env, ...(opts.env ?? {}) }, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, error: r.error };
}
const psql = (db, sqlText) => run(bin("psql"), ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", urlFor(db), "-c", sqlText]);
const psqlFile = (db, file) => run(bin("psql"), ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", urlFor(db), "-f", file]);
function createDb(name, template) {
  const r = psql("postgres", `CREATE DATABASE ${name}${template ? ` TEMPLATE ${template}` : ""}`);
  if (r.status !== 0) fail(`não consegui criar ${name}: ${r.out.slice(0, 200)}`);
  created.push(name);
}
const tsx = (db, script, extra = {}) => run(process.execPath, [TSX_CLI, script], { env: { DATABASE_URL: urlFor(db), NODE_ENV: "test", ...extra } });
function check(id, desc, ok, detail = "") { results.push({ id, desc, ok: !!ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${id} ${desc}${detail ? ` — ${detail}` : ""}`); }

const realMigrations = fs.readdirSync(path.join(root, "db", "migrations")).filter((f) => f.endsWith(".sql")).sort();
const signatureSql = `select coalesce(md5(string_agg(s, E'\\n' order by s)), 'x') || ' ' || count(*) from (
  select 'c:' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable as s from information_schema.columns where table_schema='public'
  union all select 'i:' || indexname || ':' || indexdef from pg_indexes where schemaname='public'
  union all select 'k:' || conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace
  union all select 't:' || tgname from pg_trigger where not tgisinternal) x`;
const signature = (db) => psql(db, signatureSql).out.trim();
const scalar = (db, q) => psql(db, q).out.trim();

try {
  // ---------- baseline: schema anterior às novas migrations (a master de referência) ----------
  const baseSchema = run("git", ["show", `${baselineRef}:db/schema.sql`]);
  if (baseSchema.status !== 0) fail(`git show ${baselineRef}:db/schema.sql falhou (informe --baseline-ref).`);
  const baseMigs = run("git", ["ls-tree", "--name-only", baselineRef, "db/migrations/"]).out.split(/\r?\n/).map((s) => path.basename(s)).filter((f) => f.endsWith(".sql")).sort();
  const pendingExpected = realMigrations.filter((f) => !baseMigs.includes(f));
  const baseFile = path.join(outDir, "baseline-schema.sql");
  fs.writeFileSync(baseFile, baseSchema.out);

  // ---------- A: banco novo ----------
  createDb(names.A);
  let r = tsx(names.A, "db/migrate.ts");
  check("A1", "banco novo: schema.sql aplicado", r.status === 0, `exit ${r.status}`);
  check("A2", "banco novo: todas as migrations registradas", scalar(names.A, "select count(*) from schema_migrations") === String(realMigrations.length), `${realMigrations.length} arquivos`);
  r = tsx(names.A, "db/run-migrations.ts");
  check("A3", "banco novo: runner incremental não encontra pendência", r.status === 0 && /Nenhuma migra/.test(r.out), `exit ${r.status}`);
  const sigNew = signature(names.A);

  // ---------- B: schema anterior + dados sintéticos -> atualização incremental ----------
  createDb(names.P);
  check("B0", "schema anterior (master de referência) carregado", psqlFile(names.P, baseFile).status === 0);
  const stampSql = baseMigs.map((f) => `('${f}')`).join(",");
  psql(names.P, "create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())");
  psql(names.P, `insert into schema_migrations (id) values ${stampSql}`);
  const seedSql = `
    insert into users (email, display_name) values ('sintetico1@exemplo.test','Pessoa Sintetica 1'),('sintetico2@exemplo.test','Pessoa Sintetica 2');
    insert into organizations (name, slug, type, status, city, state, created_by_user_id) select 'Org Sintetica','org-sintetica',(enum_range(null::organization_type))[1],'ativa','Cidade','UF',id from users order by id limit 1;
    insert into needs (organization_id, title, quantity_needed, unit, created_by_user_id) select o.id,'Necessidade sintetica',10,'kg',o.created_by_user_id from organizations o;`;
  r = psql(names.P, seedSql);
  check("B1", "dados sintéticos do schema anterior inseridos", r.status === 0, r.status === 0 ? "" : r.out.slice(0, 160));
  createDb(names.B, names.P);
  createDb(names.F, names.P);
  // Só as colunas que já existiam no schema anterior (as novas migrations acrescentam colunas, o que muda o texto da linha inteira).
  const preservedCols = { users: "id, email, display_name", organizations: "id, name, slug, city, state, created_by_user_id", needs: "id, organization_id, title, quantity_needed, unit" };
  const rowsChecksum = (db) => Object.entries(preservedCols).map(([t, cols]) => scalar(db, `select md5(string_agg(x::text,'|' order by x::text)) from (select ${cols} from ${t}) x`)).join(",");
  const beforeChecks = rowsChecksum(names.B);
  r = tsx(names.B, "db/run-migrations.ts");
  const applied = (r.out.match(/Aplicada com sucesso/g) ?? []).length;
  check("B2", `atualização incremental aplica só as pendentes (${pendingExpected.length})`, r.status === 0 && applied === pendingExpected.length, `exit ${r.status}, aplicadas ${applied}`);
  const afterChecks = rowsChecksum(names.B);
  check("B3", "registros sintéticos preservados após a atualização", beforeChecks === afterChecks);
  check("B4", "schema do banco atualizado é IDÊNTICO ao do banco novo", signature(names.B) === sigNew, signature(names.B) === sigNew ? "" : `novo=${sigNew} atualizado=${signature(names.B)}`);

  // ---------- D: reexecução ----------
  const sigB = signature(names.B);
  r = tsx(names.B, "db/run-migrations.ts");
  check("D1", "reexecução: nenhuma migration pendente, exit 0", r.status === 0 && /Nenhuma migra/.test(r.out));
  check("D2", "reexecução não altera o schema nem a tabela de controle", signature(names.B) === sigB && scalar(names.B, "select count(*) from schema_migrations") === String(realMigrations.length));

  // ---------- C: falha controlada ----------
  const failDir = fs.mkdtempSync(path.join(os.tmpdir(), "levora-migfail-"));
  for (const f of realMigrations) fs.copyFileSync(path.join(root, "db", "migrations", f), path.join(failDir, f));
  fs.writeFileSync(path.join(failDir, "9999_falha_controlada.sql"), "CREATE TABLE release_check_parcial (id int);\nSELECT 1/0;\n");
  r = tsx(names.F, "db/run-migrations.ts", { LEVORA_MIGRATIONS_DIR: failDir });
  check("C1", "falha controlada: o runner termina com exit diferente de zero", r.status !== 0, `exit ${r.status}`);
  check("C2", "falha controlada: nada parcial persiste (tabela e registro da migration falha ausentes)", scalar(names.F, "select to_regclass('public.release_check_parcial') is null") === "t" && scalar(names.F, "select count(*) from schema_migrations where id like '9999%'") === "0");
  check("C3", "falha controlada: migrations anteriores à falha ficaram aplicadas (transação por arquivo)", scalar(names.F, "select count(*) from schema_migrations") === String(realMigrations.length));
  const verifyArgs = run(process.execPath, [TSX_CLI, "scripts/release-db-check-helper.ts", "verify"], { env: { DATABASE_URL: urlFor(names.F), NODE_ENV: "test", RELEASE_CHECK_MIGRATIONS_DIR: failDir } });
  let verF = null; try { verF = JSON.parse(verifyArgs.out.trim().split(/\r?\n/).filter((l) => l.startsWith('{"counts"')).pop()); } catch { /* resultado inválido vira falha abaixo */ }
  check("C4", "schema incompatível com o código NÃO é apresentado como pronto (readiness false)", verF && verF.ready && verF.ready.ready === false && verF.ready.checks.schema === "desatualizado", verF ? JSON.stringify(verF.ready.checks) : verifyArgs.out.slice(0, 160));

  // ---------- E: backup e restauração ----------
  const seed = run(process.execPath, [TSX_CLI, "scripts/release-db-check-helper.ts", "seed-audit"], { env: { DATABASE_URL: urlFor(names.B), NODE_ENV: "test" } });
  check("E0", "registros de auditoria sintéticos gravados pela rotina real (cadeia de hash)", seed.status === 0, seed.out.slice(-120).trim());
  const helperVerify = (db) => { const o = run(process.execPath, [TSX_CLI, "scripts/release-db-check-helper.ts", "verify"], { env: { DATABASE_URL: urlFor(db), NODE_ENV: "test" } }); try { return JSON.parse(o.out.trim().split(/\r?\n/).filter((l) => l.startsWith('{"counts"')).pop()); } catch { return null; } };
  const vB = helperVerify(names.B);
  const dumpFile = path.join(outDir, "backup-sintetico.dump");
  const dump = run(bin("pg_dump"), ["-Fc", "--no-owner", "-f", dumpFile, urlFor(names.B)]);
  check("E1", "backup (pg_dump) gerado", dump.status === 0 && fs.existsSync(dumpFile) && fs.statSync(dumpFile).size > 0, fs.existsSync(dumpFile) ? `${fs.statSync(dumpFile).size} bytes` : dump.out.slice(0, 160));
  createDb(names.R);
  const rest = run(bin("pg_restore"), ["--no-owner", "--exit-on-error", "-d", urlFor(names.R), dumpFile]);
  check("E2", "restauração (pg_restore) concluída sem erro", rest.status === 0, rest.status === 0 ? "" : rest.out.slice(0, 200));
  check("E3", "schema restaurado idêntico ao original", signature(names.R) === signature(names.B));
  const vR = helperVerify(names.R);
  check("E4", "contagens de linhas idênticas em todas as tabelas", vB && vR && JSON.stringify(vB.counts) === JSON.stringify(vR.counts), vB ? `${Object.keys(vB.counts).length} tabelas` : "helper falhou");
  check("E5", "checksum de conteúdo idêntico (users, organizations, needs, audit_log)", vB && vR && JSON.stringify(vB.checks) === JSON.stringify(vR.checks));
  check("E6", "integridade referencial: nenhuma restrição não validada", vR && vR.unvalidatedConstraints === 0);
  check("E7", "cadeia de auditoria íntegra após a restauração", vR && vR.chainIntegra === true);
  check("E8", "aplicação pronta (readiness) no banco restaurado", vR && vR.ready && vR.ready.ready === true, vR ? JSON.stringify(vR.ready.checks) : "");
  const seed2 = run(process.execPath, [TSX_CLI, "scripts/release-db-check-helper.ts", "seed-audit"], { env: { DATABASE_URL: urlFor(names.R), NODE_ENV: "test" } });
  const vR2 = helperVerify(names.R);
  check("E9", "após restaurar, novas gravações de auditoria continuam encadeando (cadeia íntegra)", seed2.status === 0 && vR2 && vR2.chainIntegra === true);
} catch (e) {
  results.push({ id: "EXC", desc: "exceção inesperada", ok: false, detail: String(e?.message ?? e).slice(0, 200) });
} finally {
  if (!keep) for (const n of created.reverse()) psql("postgres", `DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
  const summary = { when: new Date().toISOString(), baselineRef, databasesCreated: created.length, droppedAfter: !keep, results };
  fs.writeFileSync(path.join(outDir, "release-db-check.json"), JSON.stringify(summary, null, 2));
  const failed = results.filter((r) => !r.ok);
  log(`\nresumo: ${results.length - failed.length}/${results.length} verificações passaram; saída em ${outDir}`);
  process.exitCode = failed.length ? 1 : 0;
}
