// Sobe (e derruba) a pilha de verificação: banco `_qa` descartável (recriado do schema) + semente mínima + API + Vite, em portas livres.
// Tudo via `node`, sem shell. Os filhos são encerrados em `stop()` (e em Ctrl+C), inclusive a árvore de processos no Windows.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { assertDisposableDatabase, deriveQaUrlFromTestUrl, readEnvValue } from "./guard.mjs";
import { killTree } from "./browser.mjs";

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
export async function prepareDatabase(url, root) {
  const target = assertDisposableDatabase(url);
  const { default: postgres } = await import("postgres");
  const adminUrl = new URL(url); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    const found = await admin`SELECT 1 FROM pg_database WHERE datname = ${target.database}`;
    if (found.length === 0) await admin.unsafe(`CREATE DATABASE "${target.database.replace(/"/g, '""')}"`);
  } finally { await admin.end(); }
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
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
  try { await admin.unsafe(`DROP DATABASE IF EXISTS "${target.database.replace(/"/g, '""')}" WITH (FORCE)`); } finally { await admin.end(); }
}

function runNode(root, args, env, label, onSpawn) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  onSpawn?.(child.pid, label);
  child.logs = [];
  const keep = (b) => { child.logs.push(String(b)); if (child.logs.length > 60) child.logs.shift(); };
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
export async function startStack({ root, databaseUrl, onSpawn, seedScript = path.join("scripts", "qa-visual", "seed.ts"), extraEnv = {} }) {
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
  for (const p of [tsx, vite]) if (!existsSync(p)) throw new Error(`dependência de desenvolvimento ausente: ${path.relative(root, p)} (rode npm install)`);
  const apiPort = await pickFreePort(); const webPort = await pickFreePort();
  const env = { ...process.env, DATABASE_URL: databaseUrl, JWT_SECRET: `qa-efemero-${Math.random().toString(36).slice(2)}${Date.now()}-0123456789abcdef`, PORT: String(apiPort), QA_API_PORT: String(apiPort), QA_WEB_PORT: String(webPort), NODE_ENV: "development", ...extraEnv };
  const children = [];
  const stop = async () => { for (const c of children.reverse()) killTree(c); await sleep(300); };
  try {
    const seed = runNode(root, [tsx, seedScript], env, "seed", onSpawn);
    children.push(seed);
    await new Promise((res, rej) => { seed.on("exit", (code) => (code === 0 ? res() : rej(new Error(`a semente falhou (código ${code}): ${seed.logs.slice(-6).join(" | ").slice(0, 400)}`)))); });
    const api = runNode(root, [tsx, path.join("scripts", "qa-visual", "api.ts")], env, "api", onSpawn); children.push(api);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${apiPort}/_api/__health`)).ok, "API", 60000, api);
    const web = runNode(root, [vite, "--config", path.join("scripts", "qa-visual", "vite.config.ts"), "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"], env, "vite", onSpawn); children.push(web);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${webPort}/login`)).ok, "Vite", 60000, web);
    return { baseUrl: `http://127.0.0.1:${webPort}`, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
