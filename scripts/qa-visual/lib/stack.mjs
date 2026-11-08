// Sobe (e derruba) a pilha de verificação: banco `_qa` descartável (recriado do schema) + semente mínima + API + Vite, em portas livres.
// Tudo via `node`, sem shell. Os filhos são encerrados em `stop()` (e em Ctrl+C), inclusive a árvore de processos no Windows.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { QA_DB_OWNER_MARK, assertDisposableDatabase, decideDatabaseOwnership, deriveQaUrlFromTestUrl, readEnvValue } from "./guard.mjs";
import { killTree } from "./browser.mjs";
import { clockEnv, clockSql } from "./clock.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function pickFreePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

/** URL do banco de QA: --db-url / QA_DATABASE_URL, ou derivada de DATABASE_URL de `.env.test` (`..._test` → `..._qa`). Nunca imprime credenciais. */
export function resolveDatabaseUrl({ cli, env = process.env, root }) {
  if (cli) return cli;
  if (env.QA_DATABASE_URL) return env.QA_DATABASE_URL;
  const envTest = path.join(root, ".env.test");
  if (existsSync(envTest)) {
    const v = readEnvValue(readFileSync(envTest, "utf8"), "DATABASE_URL");
    if (v) return deriveQaUrlFromTestUrl(v);
  }
  return undefined;
}

/** Cria o banco (se faltar) e recria o schema a partir de db/schema.sql — SÓ depois da guarda de banco descartável. */
export async function prepareDatabase(url, root, { clock } = {}) {
  const target = assertDisposableDatabase(url);
  const { default: postgres } = await import("postgres");
  const adminUrl = new URL(url); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    const found = await admin`SELECT oid, pg_catalog.shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = ${target.database}`;
    let tableCount = 0;
    if (found.length > 0) { const probe = postgres(url, { max: 1, prepare: false, onnotice: () => {} }); try { tableCount = Number((await probe`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`)[0].n); } finally { await probe.end(); } }
    const decision = decideDatabaseOwnership({ exists: found.length > 0, comment: found[0]?.comment, publicTableCount: tableCount });
    if (decision === "refuse") throw new Error(`o banco "${target.database}" existe, não tem a marca de propriedade do QA (${QA_DB_OWNER_MARK}) e contém tabelas: recusado (nada é apagado). Use um banco novo.`);
    if (decision === "create") await admin.unsafe(`CREATE DATABASE "${target.database.replace(/"/g, '""')}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`); // M09: ordenação FIXADA em C — sem isso a ordem dos itens (ORDER BY name) depende do locale do cluster (pt-BR: Água, Arroz, Lenço; C: Arroz, Lenço, Água) e as imagens mudam entre ambientes
    if (decision === "create" || decision === "adopt") await admin.unsafe(`COMMENT ON DATABASE "${target.database.replace(/"/g, '""')}" IS '${QA_DB_OWNER_MARK}'`);
  } finally { await admin.end(); }
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    if (clock) { // M04: relógio congelado do banco `_qa` (função qa_clock.now + search_path do banco); a sessão do schema usa o mesmo search_path para os DEFAULT now()
      await sql.unsafe("DROP SCHEMA IF EXISTS qa_clock CASCADE"); // M05: reaproveitar um banco _qa não pode colidir com objetos de uma execução anterior
      for (const stmt of clockSql(target.database, clock, { seedTicks: clock.seedWindowSeconds ?? 0 })) await sql.unsafe(stmt); // M05: na SEMENTE cada now() avança 1 s (ordem estável); startStack congela ao fim da semente
      await sql.unsafe("SET search_path = public, qa_clock, pg_catalog"); // M05: o schema da aplicação é carregado em public (antes caía em qa_clock, o 1º do search_path); a RESOLUÇÃO em execução continua qa_clock → pg_catalog → public
    } else { // sem relógio congelado: garante que um banco reaproveitado não herde o search_path/fuso de uma execução anterior
      await sql.unsafe(`ALTER DATABASE "${target.database.replace(/"/g, '""')}" RESET search_path; ALTER DATABASE "${target.database.replace(/"/g, '""')}" RESET timezone;`);
    }
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await sql.unsafe(readFileSync(path.join(root, "db", "schema.sql"), "utf8"));
  } finally { await sql.end(); }
  return target;
}

/** Remove o banco de QA ao final (só passa pela guarda `_qa`). `FORCE` derruba conexões que tenham sobrado. */
export async function dropDatabase(url) {
  const target = assertDisposableDatabase(url);
  const { default: postgres } = await import("postgres");
  const adminUrl = new URL(url); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try { const c = await admin`SELECT pg_catalog.shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = ${target.database}`; if (c.length === 0) return; if (!String(c[0].comment ?? "").startsWith(QA_DB_OWNER_MARK)) throw new Error(`o banco "${target.database}" não tem a marca de propriedade do QA: não será apagado`); await admin.unsafe(`DROP DATABASE IF EXISTS "${target.database.replace(/"/g, '""')}" WITH (FORCE)`); } finally { await admin.end(); }
}

function runNode(root, args, env, label, onSpawn, onLog) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  onSpawn?.(child.pid, label);
  child.logs = [];
  const keep = (b) => { child.logs.push(String(b)); if (child.logs.length > 60) child.logs.shift(); onLog?.(label, b); };
  child.stdout.on("data", keep); child.stderr.on("data", keep);
  child.label = label;
  return child;
}

async function waitFor(check, what, ms = 60000, child) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child && child.exitCode !== null) throw new Error(`${what}: o processo encerrou (código ${child.exitCode}). Últimas linhas: ${child.logs.slice(-6).join(" | ").slice(0, 400)}`);
    try { if (await check()) return; } catch { /* tenta de novo */ }
    await sleep(300);
  }
  throw new Error(`${what}: não ficou pronto em ${ms / 1000}s`);
}

/** Semeia, sobe API e Vite. Retorna { baseUrl, stop }. Lança em caso de falha (o chamador classifica como ENV). */
export async function startStack({ root, databaseUrl, onSpawn, onLog, seedScript = path.join("scripts", "qa-visual", "seed.ts"), extraEnv = {}, clock }) {
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
  for (const p of [tsx, vite]) if (!existsSync(p)) throw new Error(`dependência de desenvolvimento ausente: ${path.relative(root, p)} (rode npm install)`);
  const apiPort = await pickFreePort(); const webPort = await pickFreePort();
  const env = { ...process.env, DATABASE_URL: databaseUrl, JWT_SECRET: `qa-efemero-${Math.random().toString(36).slice(2)}${Date.now()}-0123456789abcdef`, PORT: String(apiPort), QA_API_PORT: String(apiPort), QA_WEB_PORT: String(webPort), NODE_ENV: "development",
    // Identidade (Fase 90): titulares de platform_access exigem MFA. A pilha de QA é descartável, sintética e protegida por assertDisposableDatabase (banco *_qa local); a própria
    // aplicação só aceita relaxar o MFA com PLATFORM_MFA_REQUIRED=false + LEVORA_ENVIRONMENT=staging (src/helpers/identityKeys.tsx). Aqui vale SÓ para os filhos desta pilha.
    PLATFORM_MFA_REQUIRED: "false", LEVORA_ENVIRONMENT: "staging", ...(clock ? clockEnv(clock) : {}), ...extraEnv };
  const children = [];
  const stop = async () => { for (const c of children.reverse()) killTree(c); await sleep(300); };
  try {
    const seed = runNode(root, [tsx, seedScript], clock && (clock.seedWindowSeconds ?? 0) > 0 ? { ...env, QA_CLOCK_SEED_TICKS: String(clock.seedWindowSeconds) } : env, "seed", onSpawn, onLog); // M05: só a semente tem relógio que avança (1 s por leitura)
    children.push(seed);
    await new Promise((res, rej) => { seed.on("exit", (code) => (code === 0 ? res() : rej(new Error(`a semente falhou (código ${code}): ${seed.logs.slice(-6).join(" | ").slice(0, 400)}`)))); });
    let clockTicks = null;
    if (clock) { // M05 (fase F): terminada a semente, o relógio do banco volta a ser CONSTANTE no instante fixo; falha alto se a semente usou mais instantes que a janela (haveria eventos no futuro)
      const { default: postgres } = await import("postgres"); const target = assertDisposableDatabase(databaseUrl); const adm = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
      try {
        if ((clock.seedWindowSeconds ?? 0) > 0) {
          const [{ ticks }] = await adm`SELECT (CASE WHEN is_called THEN last_value ELSE 0 END)::int AS ticks FROM qa_clock.tick`; clockTicks = ticks;
          if (ticks >= clock.seedWindowSeconds) throw new Error(`a semente consumiu ${ticks} instantes (janela de ${clock.seedWindowSeconds}): eventos semeados ficariam no futuro`);
        }
        for (const stmt of clockSql(target.database, clock)) await adm.unsafe(stmt);
      } finally { await adm.end(); }
    }
    const api = runNode(root, [tsx, path.join("scripts", "qa-visual", "api.ts")], env, "api", onSpawn, onLog); children.push(api);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${apiPort}/_api/__health`)).ok, "API", 60000, api);
    const web = runNode(root, [vite, "--config", path.join("scripts", "qa-visual", "vite.config.ts"), "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"], env, "vite", onSpawn, onLog); children.push(web);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${webPort}/login`)).ok, "Vite", 60000, web);
    const logs = () => ({ api: api.logs.slice(-15), vite: web.logs.slice(-15) });
    return { baseUrl: `http://127.0.0.1:${webPort}`, apiPort, webPort, stop, logs, clockTicks };
  } catch (e) {
    await stop();
    throw e;
  }
}
