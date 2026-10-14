#!/usr/bin/env node
// Verificação visual REPRODUZÍVEL (Edge e/ou Chrome já instalados, sem dependências novas). Veja docs/QA_VISUAL.md.
//
//   npm run qa:visual                       → todos os cenários × 4 viewports × 2 temas, nos navegadores encontrados
//   npm run qa:visual -- --browser edge     → só o Edge (ENV se não existir)
//   npm run qa:visual -- --viewports 375,1280 --only needs-primary-new,matching-switch --verbose
//   npm run qa:visual -- --self-test        → prova que o detector pega regressões (CSS ruim injetado só no navegador) e ausências
//   npm run qa:visual -- --list             → lista os cenários
//   npm run qa:visual -- --cleanup          → recupera órfãos de uma execução morta à força (processos, perfis, banco) e sai
//
// Banco: SÓ um banco local descartável cujo nome termina em `_qa` (QA_DATABASE_URL, --db-url ou derivado de .env.test `_test` → `_qa`).
// Códigos de saída: 0 tudo passou · 1 violação (FAIL) · 2 não consegui medir (MISSING/UNMEASURABLE) · 3 ambiente indisponível · 4 autoteste falhou.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertDisposableDatabase } from "./lib/guard.mjs";
import { findBrowser, killTree, launchBrowser } from "./lib/browser.mjs";
import { startStack, prepareDatabase, dropDatabase, resolveDatabaseUrl } from "./lib/stack.mjs";
import { Report, EXIT, expectedCombos, coverageGaps, selectionSummary } from "./lib/report.mjs";
import { STATUS } from "./lib/contrast.mjs";
import { installProbe, runScenarios } from "./lib/runner.mjs";
import { Cleanups } from "./lib/cleanup.mjs";
import { RunState, recoverOrphans } from "./lib/orphans.mjs";
import { VIEWPORTS, parseViewportsOption, viewportKey } from "./lib/viewport.mjs";
import { SCENARIOS, THEMES, QA_PASSWORD, CI_PROFILE_IDS } from "./scenarios.mjs";
import { MUTATIONS, SENTINELS } from "./selftest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { values: opt } = parseArgs({
  options: {
    browser: { type: "string", default: "auto" }, "db-url": { type: "string" }, only: { type: "string" }, out: { type: "string" }, viewports: { type: "string" }, profile: { type: "string", default: "full" },
    verbose: { type: "boolean", default: false }, "keep-db": { type: "boolean", default: false }, "self-test": { type: "boolean", default: false },
    list: { type: "boolean", default: false }, cleanup: { type: "boolean", default: false }, "inject-css": { type: "string" }, screenshots: { type: "string" },
  },
});

if (!["full", "ci"].includes(opt.profile)) { console.error("--profile aceita full ou ci"); process.exit(EXIT.ENV); }
if (opt.profile === "ci" && opt.only) { console.error("--profile ci e --only são excludentes (o perfil já define os cenários)"); process.exit(EXIT.ENV); }
const only = opt.profile === "ci" ? new Set(CI_PROFILE_IDS) : opt.only ? new Set(opt.only.split(",").map((s) => s.trim())) : null;
const chosen = SCENARIOS.filter((s) => !only || only.has(s.id));
let viewports;
try { viewports = parseViewportsOption(opt.viewports); } catch (e) { console.error(e.message); process.exit(EXIT.ENV); }
if (opt.list) { for (const s of SCENARIOS) console.log(`${s.id.padEnd(34)} ${s.user.padEnd(9)} ${s.measure.padEnd(13)} ${s.variant}`); console.log(`viewports: ${VIEWPORTS.map(viewportKey).join(", ")} · temas: ${THEMES.join(", ")}`); process.exit(EXIT.OK); }
const selection = selectionSummary(SCENARIOS.map((s) => s.id), chosen.map((s) => s.id), opt.profile === "ci" ? "ci" : only ? "only" : "full");
if (opt.profile === "ci" && chosen.length !== CI_PROFILE_IDS.length) { console.error(`o perfil ci cita cenários inexistentes: ${CI_PROFILE_IDS.filter((id) => !SCENARIOS.some((s) => s.id === id)).join(", ")}`); process.exit(EXIT.ENV); }
if (only && chosen.length === 0) { console.error("nenhum cenário corresponde a --only"); process.exit(EXIT.ENV); }

const report = new Report();
const cleanups = new Cleanups();
const state = new RunState();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await cleanups.runAll(); state.end(); process.exit(EXIT.ENV); });

const actionsFor = (dbUrl) => ({
  killTree: (pid) => killTree(pid),
  removeDir: (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }),
  dropDb: async (name) => { if (!dbUrl) throw new Error("URL do banco indisponível para derrubar o banco órfão"); if (assertDisposableDatabase(dbUrl).database !== name) throw new Error(`o banco órfão (${name}) não é o banco de QA atual; não derrubado`); await dropDatabase(dbUrl); },
});

async function main() {
  // 0) órfãos de uma execução anterior morta à força (e recusa de execução simultânea)
  const dbUrl = resolveDatabaseUrl({ cli: opt["db-url"], root });
  const rec = await recoverOrphans({ actions: actionsFor(dbUrl) });
  if (rec.busy) { report.addEnv(`já existe uma execução da verificação visual em andamento (pid ${rec.pid})`); return; }
  if (rec.killed?.length || rec.profiles?.length || rec.database) console.log(`órfãos recuperados: processos=${rec.killed.length} perfis=${rec.profiles.length} banco=${rec.database ?? "-"}${rec.errors.length ? ` · erros: ${rec.errors.join("; ")}` : ""}`);
  if (opt.cleanup) { console.log("limpeza concluída"); return; }
  state.begin();
  cleanups.add("registro de execução", async () => state.end());

  // 1) navegadores
  const wanted = opt.browser === "auto" || opt.browser === "both" ? ["edge", "chrome"] : [opt.browser];
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
  let target;
  try { target = assertDisposableDatabase(dbUrl); } catch (e) { report.addEnv(`banco: ${e.message}`); return; }
  console.log(`banco de QA: ${target.database} em ${target.host}:${target.port} (schema recriado a partir de db/schema.sql)`);
  let stack;
  try {
    if (!opt["keep-db"]) cleanups.add("banco de QA", async () => { await dropDatabase(dbUrl); state.clearDatabase(); }); // roda por ÚLTIMO (depois de parar API/Vite/navegador)
    state.setDatabase(target.database);
    await prepareDatabase(dbUrl, root);
    process.env.QA_PASSWORD = QA_PASSWORD;
    stack = await startStack({ root, databaseUrl: dbUrl, onSpawn: (pid, kind) => state.addChild(pid, kind) });
  } catch (e) { report.addEnv(`pilha de verificação não subiu: ${e.message}`); return; }
  cleanups.add("API e Vite", () => stack.stop());
  console.log(`aplicação em ${stack.baseUrl}`);
  if (process.env.QA_VISUAL_FAULT === "after-stack") throw new Error("falha simulada (QA_VISUAL_FAULT=after-stack) para verificar a limpeza");

  if (opt.screenshots) mkdirSync(path.resolve(opt.screenshots), { recursive: true });
  // diretório temporário dos arquivos sintéticos enviados aos campos de arquivo (apagado no fim)
  const filesDir = mkdtempSync(path.join(tmpdir(), "levora-qa-profile-files-"));
  state.addProfile(filesDir);
  cleanups.add("arquivos sintéticos", async () => { rmSync(filesDir, { recursive: true, force: true }); state.dropProfile(filesDir); });

  // 3) por navegador
  const injectCss = opt["inject-css"] ? readFileSync(opt["inject-css"], "utf8") : undefined;
  const ran = [];
  for (const b of browsers) {
    const auth = { current: null }; // sessão do navegador compartilhada entre as chamadas deste navegador
    let session;
    try { session = await launchBrowser(b.exe, { onSpawn: (pid, kind) => state.addChild(pid, kind), onProfile: (d) => state.addProfile(d), onProfileGone: (d) => state.dropProfile(d) }); } catch (e) { report.addEnv(`${b.name}: não abriu (${e.message})`); continue; }
    cleanups.add(`navegador ${b.name}`, async () => session.close());
    try {
      await installProbe(session.cdp, { injectCss });
      console.log(`${b.name}: ${session.version}`);
      if (process.env.QA_VISUAL_FAULT === "after-browser") throw new Error("falha simulada (QA_VISUAL_FAULT=after-browser) para verificar a limpeza");
      if (opt["self-test"]) await selfTest(session, b.name, stack.baseUrl, filesDir, auth);
      else { await runScenarios({ cdp: session.cdp, browserName: b.name, version: session.version, baseUrl: stack.baseUrl, scenarios: chosen, viewports, report, filesDir, auth, screenshotsDir: opt.screenshots ? path.resolve(opt.screenshots) : undefined }); ran.push({ name: b.name, version: session.version }); }
    } finally { await session.close(); }
  }

  // 4) cobertura: toda combinação esperada precisa aparecer no relatório (executada ou explicitamente reportada)
  if (!opt["self-test"]) {
    for (const key of coverageGaps(report.rows, expectedCombos({ browsers: ran.map((r) => r.name), scenarios: chosen, viewports: viewports.map(viewportKey), themes: THEMES }))) {
      const [browser, scenario, viewport, theme] = key.split("|");
      report.add({ browser, version: ran.find((r) => r.name === browser)?.version, scenario, target: "-", variant: "-", viewport, theme, state: "cobertura", kind: "cobertura", status: STATUS.UNMEASURABLE, detail: "combinação esperada sem nenhuma linha no relatório (não foi executada)" });
    }
  }
  return { ran };
}

/** Autoteste: injeta CSS ruim SÓ no navegador (produção intacta) e exige que o detector acuse; e exige MISSING/UNMEASURABLE nas sentinelas. */
async function selfTest(session, name, baseUrl, filesDir, auth) {
  const byId = new Map(SCENARIOS.map((s) => [s.id, s]));
  for (const m of MUTATIONS) {
    const sub = new Report();
    const scenarios = m.scenarios.map((id) => byId.get(id));
    const vps = (m.viewports ?? [1280]).map((w) => VIEWPORTS.find((v) => v.w === w));
    const remove = await installProbe(session.cdp, { injectCss: m.css, injectJs: m.js });
    try { await runScenarios({ cdp: session.cdp, browserName: name, version: session.version, baseUrl, scenarios, viewports: vps, report: sub, filesDir, auth }); } finally { await remove(); }
    const hit = sub.rows.find((r) => r.status === STATUS.FAIL && m.scenarios.includes(r.scenario) && (!m.theme || r.theme === m.theme) && (!m.state || r.state === m.state) && (!m.target || String(r.target).includes(m.target)));
    report.add({ browser: name, version: session.version, scenario: `autoteste:${m.id}`, target: m.describe, variant: "detector", viewport: (m.viewports ?? [1280]).join("/"), theme: m.theme ?? "qualquer", state: m.state ?? "qualquer", kind: "detecção", status: hit ? STATUS.PASS : STATUS.FAIL, detail: hit ? `regressão injetada DETECTADA (${hit.scenario} @${hit.viewport}: ${hit.detail.slice(0, 80)})` : "regressão injetada NÃO foi detectada — o detector está cego para este caso" });
  }
  for (const s of SENTINELS) {
    const sub = new Report();
    await runScenarios({ cdp: session.cdp, browserName: name, version: session.version, baseUrl, scenarios: [s.scenario], viewports: [VIEWPORTS[3]], report: sub, filesDir, auth });
    const got = sub.rows.some((r) => r.status === s.expect);
    report.add({ browser: name, version: session.version, scenario: `autoteste:${s.id}`, target: s.describe, variant: "detector", viewport: "1280", theme: "qualquer", state: "qualquer", kind: "detecção", status: got ? STATUS.PASS : STATUS.FAIL, detail: got ? `${s.expect} reportado como esperado` : `esperava ${s.expect} e recebi ${[...new Set(sub.rows.map((r) => r.status))].join(",")}` });
  }
}

let code; let outcome;
try {
  outcome = await main();
  code = report.exitCode();
  if (opt["self-test"] && code === EXIT.FAIL) code = EXIT.SELFTEST;
} catch (e) {
  report.addEnv(`erro inesperado: ${e.stack ?? e.message}`);
  code = EXIT.ENV;
} finally {
  const errs = await cleanups.runAll();
  for (const er of errs) console.log(`aviso de limpeza (${er.name}): ${er.message}`);
}
if (opt.cleanup) process.exit(code);
const file = opt.out ? path.resolve(opt.out) : path.join(tmpdir(), "levora-qa-visual", `relatorio-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify({ geradoEm: new Date().toISOString(), node: process.version, so: process.platform, viewports: viewports.map(viewportKey), temas: THEMES, selecao: selection, navegadores: outcome?.ran ?? [], contagem: report.counts(), env: report.env, linhas: report.rows }, null, 1));
for (const line of report.format({ verbose: opt.verbose })) console.log(line);
console.log(selection.completo ? `Cobertura: matriz completa (${selection.total} cenários).` : `Cobertura: SUBCONJUNTO — ${selection.executados} de ${selection.total} cenários (perfil ${selection.perfil}); NÃO executados (não contam como aprovados): ${selection.omitidos.join(", ")}`);
console.log(`Relatório JSON: ${file}`);
if (opt["self-test"]) console.log(`Código de saída final (autoteste): ${code}`);
process.exit(code);
