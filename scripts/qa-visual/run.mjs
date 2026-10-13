#!/usr/bin/env node
// Verificação visual REPRODUZÍVEL (Edge e/ou Chrome já instalados, sem dependências novas). Veja docs/QA_VISUAL.md.
//
//   npm run qa:visual                       → todos os cenários, nos navegadores encontrados
//   npm run qa:visual -- --browser edge     → só o Edge (ENV se não existir)
//   npm run qa:visual -- --only needs-primary-new,matching-switch --verbose
//   npm run qa:visual -- --self-test        → prova que o detector pega regressões (CSS ruim injetado só no navegador) e ausências
//   npm run qa:visual -- --list             → lista os cenários
//
// Banco: SÓ um banco local descartável cujo nome termina em `_qa` (QA_DATABASE_URL, --db-url ou derivado de .env.test `_test` → `_qa`).
// Códigos de saída: 0 tudo passou · 1 violação (FAIL) · 2 não consegui medir (MISSING/UNMEASURABLE) · 3 ambiente indisponível · 4 autoteste falhou.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertDisposableDatabase } from "./lib/guard.mjs";
import { findBrowser, launchBrowser } from "./lib/browser.mjs";
import { startStack, prepareDatabase, dropDatabase, resolveDatabaseUrl } from "./lib/stack.mjs";
import { Report, EXIT } from "./lib/report.mjs";
import { STATUS } from "./lib/contrast.mjs";
import { installProbe, runScenarios } from "./lib/runner.mjs";
import { SCENARIOS, QA_PASSWORD } from "./scenarios.mjs";
import { MUTATIONS, SENTINELS } from "./selftest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { values: opt } = parseArgs({
  options: {
    browser: { type: "string", default: "auto" }, "db-url": { type: "string" }, only: { type: "string" }, out: { type: "string" },
    verbose: { type: "boolean", default: false }, "keep-db": { type: "boolean", default: false }, "self-test": { type: "boolean", default: false }, list: { type: "boolean", default: false }, "inject-css": { type: "string" },
  },
});

const only = opt.only ? new Set(opt.only.split(",").map((s) => s.trim())) : null;
const chosen = SCENARIOS.filter((s) => !only || only.has(s.id));
if (opt.list) { for (const s of SCENARIOS) console.log(`${s.id.padEnd(34)} ${s.user.padEnd(9)} ${s.measure.padEnd(9)} ${s.variant}`); process.exit(EXIT.OK); }
if (only && chosen.length === 0) { console.error("nenhum cenário corresponde a --only"); process.exit(EXIT.ENV); }

const report = new Report();
const cleanups = [];
let cleaning = false;
const cleanupAll = async () => { if (cleaning) return; cleaning = true; for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* melhor esforço */ } } };
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await cleanupAll(); process.exit(EXIT.ENV); });

async function main() {
  // 1) navegadores
  const wanted = opt.browser === "auto" ? ["edge", "chrome"] : opt.browser === "both" ? ["edge", "chrome"] : [opt.browser];
  if (!wanted.every((b) => ["edge", "chrome"].includes(b))) { report.addEnv(`--browser inválido: ${opt.browser} (use edge, chrome, both ou auto)`); return; }
  const browsers = [];
  for (const name of wanted) {
    const exe = findBrowser(name);
    if (exe) browsers.push({ name, exe });
    else if (opt.browser === "auto") console.log(`aviso: ${name} não encontrado neste computador — não será avaliado (limitação registrada no relatório)`);
    else report.addEnv(`${name} não encontrado (defina QA_${name.toUpperCase()}_PATH)`);
  }
  if (report.env.length) return;
  if (!browsers.length) { report.addEnv("nenhum navegador (Edge/Chrome) encontrado; defina QA_EDGE_PATH ou QA_CHROME_PATH"); return; }

  // 2) banco descartável + pilha (API, Vite, semente)
  const dbUrl = resolveDatabaseUrl({ cli: opt["db-url"], root });
  let target;
  try { target = assertDisposableDatabase(dbUrl); } catch (e) { report.addEnv(`banco: ${e.message}`); return; }
  console.log(`banco de QA: ${target.database} em ${target.host}:${target.port} (schema recriado a partir de db/schema.sql)`);
  let stack;
  try {
    if (!opt["keep-db"]) cleanups.push(() => dropDatabase(dbUrl)); // roda por ÚLTIMO (depois de parar API/Vite/navegador)
    await prepareDatabase(dbUrl, root);
    process.env.QA_PASSWORD = QA_PASSWORD;
    stack = await startStack({ root, databaseUrl: dbUrl });
  } catch (e) { report.addEnv(`pilha de verificação não subiu: ${e.message}`); return; }
  cleanups.push(() => stack.stop());
  console.log(`aplicação em ${stack.baseUrl}`);

  // 3) por navegador
  const injectCss = opt["inject-css"] ? (await import("node:fs")).readFileSync(opt["inject-css"], "utf8") : undefined;
  for (const b of browsers) {
    let session;
    try { session = await launchBrowser(b.exe); } catch (e) { report.addEnv(`${b.name}: não abriu (${e.message})`); continue; }
    cleanups.push(() => session.close());
    try {
      await installProbe(session.cdp, { injectCss });
      console.log(`${b.name}: ${session.version}`);
      if (opt["self-test"]) await selfTest(session, b.name, stack.baseUrl);
      else await runScenarios({ cdp: session.cdp, browserName: b.name, version: session.version, baseUrl: stack.baseUrl, scenarios: chosen, report });
    } finally { await session.close(); cleanups.pop(); }
  }
}

/** Autoteste: injeta CSS ruim SÓ no navegador (produção intacta) e exige que o detector acuse; e exige MISSING/UNMEASURABLE nas sentinelas. */
async function selfTest(session, name, baseUrl) {
  const byId = new Map(SCENARIOS.map((s) => [s.id, s]));
  for (const m of MUTATIONS) {
    const sub = new Report();
    const scenarios = m.scenarios.map((id) => byId.get(id));
    const remove = await installProbe(session.cdp, { injectCss: m.css });
    try { await runScenarios({ cdp: session.cdp, browserName: name, version: session.version, baseUrl, scenarios, report: sub }); } finally { await remove(); }
    const hit = sub.rows.find((r) => r.status === STATUS.FAIL && m.scenarios.includes(r.scenario) && (!m.theme || r.theme === m.theme) && (!m.state || r.state === m.state) && (!m.target || String(r.target).includes(m.target)));
    report.add({ browser: name, version: session.version, scenario: `autoteste:${m.id}`, target: m.describe, variant: "detector", theme: m.theme ?? "qualquer", state: m.state ?? "qualquer", kind: "detecção", status: hit ? STATUS.PASS : STATUS.FAIL, detail: hit ? `regressão injetada DETECTADA (${hit.scenario}: ${hit.detail.slice(0, 80)})` : "regressão injetada NÃO foi detectada — o detector está cego para este caso" });
  }
  for (const s of SENTINELS) {
    const sub = new Report();
    await runScenarios({ cdp: session.cdp, browserName: name, version: session.version, baseUrl, scenarios: [s.scenario], report: sub });
    const got = sub.rows.some((r) => r.status === s.expect);
    report.add({ browser: name, version: session.version, scenario: `autoteste:${s.id}`, target: s.describe, variant: "detector", theme: "qualquer", state: "qualquer", kind: "detecção", status: got ? STATUS.PASS : STATUS.FAIL, detail: got ? `${s.expect} reportado como esperado` : `esperava ${s.expect} e recebi ${[...new Set(sub.rows.map((r) => r.status))].join(",")}` });
  }
}

let code;
try {
  await main();
  code = report.exitCode();
  if (opt["self-test"] && code === EXIT.FAIL) code = EXIT.SELFTEST;
} catch (e) {
  report.addEnv(`erro inesperado: ${e.stack ?? e.message}`);
  code = EXIT.ENV;
} finally {
  await cleanupAll();
}
const file = opt.out ? path.resolve(opt.out) : path.join(tmpdir(), "levora-qa-visual", `relatorio-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify({ geradoEm: new Date().toISOString(), node: process.version, so: process.platform, contagem: report.counts(), env: report.env, linhas: report.rows }, null, 1));
for (const line of report.format({ verbose: opt.verbose })) console.log(line);
console.log(`Relatório JSON: ${file}`);
process.exit(code);
