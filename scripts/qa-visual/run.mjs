#!/usr/bin/env node
// Verificação visual REPRODUZÍVEL (Edge e/ou Chrome já instalados, sem dependências novas). Veja docs/QA_VISUAL.md.
//
//   npm run qa:visual                       → todos os cenários × 4 viewports × 2 temas, nos navegadores encontrados
//   npm run qa:visual -- --browser edge     → só o Edge (ENV se não existir)
//   npm run qa:visual -- --viewports 375,1280 --only needs-primary-new,matching-switch --verbose
//   npm run qa:visual -- --self-test        → prova que o detector pega regressões (CSS ruim injetado só no navegador) e ausências
//   npm run qa:visual -- --list             → lista os cenários
//   npm run qa:visual -- --cleanup          → recupera órfãos de uma execução morta à força (processos, perfis, banco) e sai
//   npm run qa:visual -- --visual capture   → (M02) capturas REAIS das páginas críticas como baselines CANDIDATAS (nunca aprova); veja docs/QA_VISUAL.md "Regressão visual"
//   npm run qa:visual -- --visual compare   → (M02) compara pixel a pixel com a baseline APROVADA (--visual-dir, --visual-out, --visual-pages a,b; --visual-only não roda os cenários funcionais)
//   npm run qa:visual -- --diagnostics DIR  → grava em DIR o tempo de cada célula (timings.jsonl), o log do servidor e, em todo MISSING, estado da página/console/rede/servidor + captura de tela
//   npm run qa:visual -- --max-minutes N    → (G2) prazo máximo do PRÓPRIO script: ao expirar, grava o relatório parcial (ENV, código 3) com a célula em que estava e encerra; use um valor menor que o limite do job
//
// Banco: SÓ um banco local descartável cujo nome termina em `_qa` (QA_DATABASE_URL, --db-url ou derivado de .env.test `_test` → `_qa`).
// Códigos de saída: 0 tudo passou · 1 violação (FAIL) · 2 não consegui medir (MISSING/UNMEASURABLE) · 3 ambiente indisponível · 4 autoteste falhou
//   · 6 (só com --visual) tudo OK, mas NÃO HOMOLOGADO visualmente: falta baseline aprovada/válida (não é aprovação nem falha). Sem --visual, nada muda.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { assertDisposableDatabase } from "./lib/guard.mjs";
import { findBrowser, launchBrowser, CdpSessionLost } from "./lib/browser.mjs";
import { quickHealth, healthLine, startHeartbeat } from "./lib/chromeprobe.mjs";
import { startStack, prepareDatabase, dropDatabase, resolveDatabaseUrl } from "./lib/stack.mjs";
import { FROZEN_CLOCK, browserClockScript } from "./lib/clock.mjs";
import { Report, EXIT, expectedCombos, coverageGaps, selectionSummary } from "./lib/report.mjs";
import { STATUS } from "./lib/contrast.mjs";
import { installProbe, runScenarios } from "./lib/runner.mjs";
import { Diagnostics } from "./lib/diagnostics.mjs";
import { Cleanups } from "./lib/cleanup.mjs";
import { RunState, installSignalHandlers, recoverOrphans } from "./lib/orphans.mjs";
import { defaultCandidateDir, resolveCandidateDir } from "./lib/visualdirs.mjs";
import { VIEWPORTS, parseViewportsOption, viewportKey } from "./lib/viewport.mjs";
import { SCENARIOS, THEMES, QA_PASSWORD, CI_PROFILE_IDS } from "./scenarios.mjs";
import { Progress, countCells, startDeadline, parseMaxMinutes, fmtDuration } from "./lib/progress.mjs";
import { MUTATIONS, SENTINELS } from "./selftest.mjs";
import { execFileSync } from "node:child_process";
import { runVisualForBrowser, writeVisualReport, summarizeVisual } from "./lib/visualrun.mjs";
import { VISUAL_PAGES, VISUAL_THEMES, VISUAL_VIEWPORTS, selectPages } from "./visual-matrix.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { values: opt } = parseArgs({
  options: {
    browser: { type: "string", default: "auto" }, "db-url": { type: "string" }, only: { type: "string" }, out: { type: "string" }, viewports: { type: "string" }, profile: { type: "string", default: "full" },
    verbose: { type: "boolean", default: false }, "keep-db": { type: "boolean", default: false }, "self-test": { type: "boolean", default: false },
    list: { type: "boolean", default: false }, cleanup: { type: "boolean", default: false }, "inject-css": { type: "string" }, screenshots: { type: "string" }, diagnostics: { type: "string" },
    visual: { type: "string" }, "max-minutes": { type: "string" }, clock: { type: "string" }, "visual-dir": { type: "string" }, "visual-out": { type: "string" }, "visual-pages": { type: "string" }, "visual-matrix": { type: "string" }, "visual-only": { type: "boolean", default: false },
  },
});

if (opt.visual && !["capture", "compare"].includes(opt.visual)) { console.error("--visual aceita capture ou compare"); process.exit(EXIT.ENV); }
if (opt["visual-only"] && !opt.visual) { console.error("--visual-only exige --visual capture|compare"); process.exit(EXIT.ENV); }
// M04: relógio congelado — padrão ligado em --visual (capture|compare); `--clock off` desliga; `--clock <ISO>` usa outro instante fixo. Fora do modo visual o executor funcional não muda.
const testClock = opt.clock === "off" ? null : opt.clock && opt.clock !== "fixed" ? { ...FROZEN_CLOCK, iso: new Date(opt.clock).toISOString() } : opt.visual || opt.clock === "fixed" ? FROZEN_CLOCK : null;
if (opt.visual && opt["self-test"]) { console.error("--visual e --self-test são excludentes"); process.exit(EXIT.ENV); }
let maxMs = 0; try { maxMs = parseMaxMinutes(opt["max-minutes"]); } catch (e) { console.error(e.message); process.exit(EXIT.ENV); }
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
const visualCells = [];
// M19: candidatas por padrão FORA do repositório; escrita (capture) recusa destino dentro do repositório fora de .qa-visual-local/ e a área de referências (lib/visualdirs.mjs).
let visualBaselineDir; try { visualBaselineDir = opt.visual === "capture" ? resolveCandidateDir(opt["visual-dir"], { root }) : path.resolve(opt["visual-dir"] ?? defaultCandidateDir()); } catch (e) { console.error(`--visual-dir recusado (${e.code ?? "erro"}): ${e.message}`); process.exit(EXIT.ENV); }
const visualOut = path.resolve(opt["visual-out"] ?? path.join(tmpdir(), "levora-qa-visual-regression", `${opt.visual ?? "off"}-${new Date().toISOString().replace(/[:.]/g, "-")}`));
let visualPages = []; if (opt.visual) { try { visualPages = selectPages(opt["visual-matrix"] ? (await import(pathToFileURL(path.resolve(opt["visual-matrix"])).href)).VISUAL_PAGES : VISUAL_PAGES, opt["visual-pages"]); /* M08: matriz complementar opcional */ } catch (e) { console.error(e.message); process.exit(EXIT.ENV); } }
const cleanups = new Cleanups();
const state = new RunState();
let progress; let diagRef; const launched = []; // G2: progresso, diagnóstico e navegadores já abertos (para o relatório parcial do prazo máximo)
installSignalHandlers({ cleanups, state, exitCode: EXIT.ENV });

const actionsFor = (dbUrl) => ({
  removeDir: (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }),
  dropDb: async (name, deadRunId) => { if (!dbUrl) throw new Error("URL do banco indisponível para derrubar o banco órfão"); if (assertDisposableDatabase(dbUrl).database !== name) throw new Error(`o banco órfão (${name}) não é o banco de QA atual; não derrubado`); await dropDatabase(dbUrl, { runId: deadRunId }); },
});

async function main() {
  // 0) órfãos de uma execução anterior morta à força (e recusa de execução simultânea)
  const dbUrl = resolveDatabaseUrl({ cli: opt["db-url"], root });
  const rec = await recoverOrphans({ ownRunId: state.runId, actions: actionsFor(dbUrl) });
  if (rec.busy) { report.addEnv(`já existe uma execução da verificação visual em andamento (pid ${rec.pid})`); return; }
  if (rec.killed?.length || rec.profiles?.length || rec.database || rec.preserved?.length) console.log(`órfãos recuperados: processos=${rec.killed.length} perfis=${rec.profiles.length} banco=${rec.database ?? "-"} preservados=${(rec.preserved?.length ?? 0) + (rec.profilesPreserved?.length ?? 0)}${rec.errors.length ? ` · erros: ${rec.errors.join("; ")}` : ""}`);
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
  let stack; let diag;
  try {
    if (!opt["keep-db"]) cleanups.add("banco de QA", async () => { await dropDatabase(dbUrl, { runId: state.runId }); state.clearDatabase(); }); // roda por ÚLTIMO (depois de parar API/Vite/navegador)
    state.setDatabase(target.database);
    await prepareDatabase(dbUrl, root, { clock: testClock, runId: state.runId });
    process.env.QA_PASSWORD = QA_PASSWORD;
    if (opt.diagnostics) { diag = new Diagnostics({ dir: opt.diagnostics }); diagRef = diag; }
    stack = await startStack({ root, databaseUrl: dbUrl, clock: testClock, onSpawn: (pid, kind, extra) => state.addChild(pid, kind, extra), onLog: diag ? (label, text) => diag.serverLog(label, text) : undefined });
    if (diag) diag.stack = stack;
  } catch (e) { report.addEnv(`pilha de verificação não subiu: ${e.message}`); return; }
  cleanups.add("API e Vite", () => stack.stop());
  console.log(`aplicação em ${stack.baseUrl}`);
  console.log(`qa:visual: node ${process.version} · ${process.platform}/${process.arch} · perfil ${opt.profile} · ${chosen.length} cenários${maxMs ? ` · prazo máximo ${fmtDuration(maxMs)}` : ""}`);
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
    try { session = await launchBrowser(b.exe, { onSpawn: (pid, kind, extra) => state.addChild(pid, kind, extra), onProfile: (d) => state.addProfile(d), onProfileGone: (d) => state.dropProfile(d) }); } catch (e) { report.addEnv(`${b.name}: não abriu (${e.message})`); continue; }
    let heartbeat;
    cleanups.add(`navegador ${b.name}`, async () => { heartbeat?.stop(); await session.close(); });
    try {
      session.cdp.context.stackUrls = { web: `${stack.baseUrl}/login`, api: `http://127.0.0.1:${stack.apiPort}/_api/__health` }; // G4: o diagnóstico de travamento também consulta a pilha
      // G4: batimento a cada 60 s (Chrome, serviços auxiliares, memória, carga, API e Vite): mostra a TENDÊNCIA antes de uma perda, que a G3 não teve
      heartbeat = startHeartbeat({ everyMs: 60000, collect: () => quickHealth({ child: session.child, stackUrls: session.cdp.context.stackUrls, baseline: session.baseline }), onBeat: (h) => { console.log(healthLine(h)); diag?.event("saude-periodica", h); } });
      await installProbe(session.cdp, { injectCss });
      if (testClock) { // M04: relógio congelado também no navegador (Date) + fuso/idioma fixos; o relógio real do Windows não é tocado
        await session.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: browserClockScript(testClock) });
        await session.cdp.send("Emulation.setTimezoneOverride", { timezoneId: testClock.timezone });
        await session.cdp.send("Emulation.setLocaleOverride", { locale: testClock.locale }).catch(() => {});
        console.log(`relógio de teste congelado em ${testClock.iso} (${testClock.timezone}) no servidor, no banco _qa e no navegador`);
      }
      if (diag) await session.cdp.send("Log.enable"); // erros do navegador (recursos que falharam, CSP) entram no diagnóstico
      console.log(`${b.name}: ${session.version}`);
      launched.push({ name: b.name, version: session.version });
      if (!opt["self-test"] && !opt["visual-only"] && !progress) progress = new Progress({ total: countCells(chosen, viewports, THEMES, browsers.length) });
      if (process.env.QA_VISUAL_FAULT === "after-browser") throw new Error("falha simulada (QA_VISUAL_FAULT=after-browser) para verificar a limpeza");
      if (opt.visual) { // M02: capturas reais + candidatas (capture) ou comparação com a baseline APROVADA (compare); resultado visual separado do funcional
        let sha = "desconhecido"; try { sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { /* sem git: fica registrado como desconhecido */ }
        visualCells.push(...await runVisualForBrowser({ session, browserName: b.name, baseUrl: stack.baseUrl, mode: opt.visual, pages: visualPages, viewports: VISUAL_VIEWPORTS, themes: VISUAL_THEMES, baselineDir: visualBaselineDir, outDir: visualOut, sourceSha: sha, filesDir, auth, clock: testClock }));
      }
      if (opt["self-test"]) await selfTest(session, b.name, stack.baseUrl, filesDir, auth);
      else if (opt["visual-only"]) ran.push({ name: b.name, version: session.version });
      else {
        try { await runScenarios({ cdp: session.cdp, browserName: b.name, version: session.version, baseUrl: stack.baseUrl, scenarios: chosen, viewports, report, filesDir, auth, diag, progress, screenshotsDir: opt.screenshots ? path.resolve(opt.screenshots) : undefined }); }
        catch (e) { if (!(e instanceof CdpSessionLost)) throw e; reportSessionLost(e, b.name, session, diag); } // G4: fail-fast: a matriz deste navegador para; o que já foi medido fica; o resto vira "não executado" na cobertura
        ran.push({ name: b.name, version: session.version });
      }
    } finally { heartbeat?.stop(); await session.close(); }
  }

  // 4) cobertura: toda combinação esperada precisa aparecer no relatório (executada ou explicitamente reportada)
  if (!opt["self-test"] && !opt["visual-only"]) {
    for (const key of coverageGaps(report.rows, expectedCombos({ browsers: ran.map((r) => r.name), scenarios: chosen, viewports: viewports.map(viewportKey), themes: THEMES }))) {
      const [browser, scenario, viewport, theme] = key.split("|");
      report.add({ browser, version: ran.find((r) => r.name === browser)?.version, scenario, target: "-", variant: "-", viewport, theme, state: "cobertura", kind: "cobertura", status: STATUS.UNMEASURABLE, detail: "combinação esperada sem nenhuma linha no relatório (não foi executada)" });
    }
  }
  return { ran, diag };
}

/**
 * G4: a sessão CDP do navegador foi comprovadamente perdida. Não é aprovação nem "ambiente" por decreto: registra a causa operacional com as evidências (processo, endpoint, aba nova,
 * pilha, cauda do stderr higienizada), grava o diagnóstico, marca a execução como ENV (código 3) e deixa a cobertura apontar cada célula que não foi executada.
 */
function reportSessionLost(e, browserName, session, diag) {
  const where = progress ? progress.describe() : "nenhuma célula concluída";
  const v = e.evidence ?? {}; const ev = v.evidence ?? {};
  console.log(`SESSÃO CDP PERDIDA [${browserName}]: ${e.reason} — ${e.detail}`);
  console.log(`  progresso: ${where}`);
  console.log(`  veredito do diagnóstico independente: ${v.kind ?? "(sem veredito)"}${v.causa ? ` — ${v.causa}` : ""}`);
  if (ev.process) console.log(`  processo Chrome: pid=${ev.process.pid} vivo=${ev.process.alive} saída=${JSON.stringify(ev.process.saiu ?? { code: ev.process.exitCode, signal: ev.process.signalCode })}`);
  if (ev.browserHttp) console.log(`  endpoint de depuração: ${ev.browserHttp.ok ? "responde" : `sem resposta (${ev.browserHttp.error})`} · alvo browser: ${ev.browserWs?.ok ? "responde" : `sem resposta (${ev.browserWs?.error})`} · página (conexão nova): ${ev.pageSecondConn?.ok ? "responde" : `sem resposta (${ev.pageSecondConn?.error})`} · aba nova: ${ev.freshTarget?.ok ? "funciona" : "não funciona"}`);
  if (ev.stack) console.log(`  pilha: web=${ev.stack.web?.ok} api=${ev.stack.api?.ok}`);
  if (Array.isArray(ev.processosOs)) console.log(`  processos do Chrome (CPU/estado): ${ev.processosOs.map((p) => `${p.type}:${p.state}:${p.cpuPct}%`).join(" ")}`);
  const tail = ev.stderr?.cauda ?? session.stderr?.text(); if (tail?.length) console.log(`  stderr do Chrome (últimas ${Math.min(tail.length, 15)} linhas, higienizado):\n${tail.slice(-15).map((l) => `    ${l}`).join("\n")}`);
  const snap = progress?.snapshot();
  const payload = { quando: new Date().toISOString(), navegador: browserName, versao: session.version, motivo: e.reason, detalhe: e.detail, progresso: snap ?? null, saudeCdp: session.cdp.health(), veredito: v.kind ?? null, causa: v.causa ?? null, evidencia: ev, stderrCauda: session.stderr?.text() ?? null };
  diag?.event("sessao-cdp-perdida", { navegador: browserName, motivo: e.reason, veredito: v.kind ?? null, celulasConcluidas: snap?.done ?? null, ultima: snap?.last ?? null });
  diag?.json("cdp-session-lost.json", payload);
  report.addEnv(`sessão CDP do ${browserName} perdida (${e.reason}${v.kind && v.kind !== e.reason ? `; diagnóstico: ${v.kind}` : ""}) após ${where}. A cobertura ficou INCOMPLETA: cada célula não executada consta como UNMEASURABLE; nada foi aprovado por reinício.`);
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

/** Fecha a parte visual (M02): relatório + manifesto de evidências; o código final é o funcional se ele já indicar problema; senão, o visual (0 homologado | 1 | 2 | 6 não homologado). */
function finishVisual(code, outcome) {
  let sha = "desconhecido"; try { sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { /* ok */ }
  const { report: vrep, exit } = writeVisualReport(visualOut, { meta: { mode: opt.visual, sourceSha: sha, browsers: outcome?.ran ?? [], baselineDir: path.relative(root, visualBaselineDir) || ".", pages: visualPages.map((p) => p.id) }, cells: visualCells });
  for (const c of visualCells.filter((x) => !["VISUAL_PASS", "CANDIDATE_CREATED"].includes(x.status))) console.log(`${c.status.padEnd(18)} ${c.id} — ${c.detail}`);
  console.log(`Visual (${opt.visual}): ${JSON.stringify(Object.fromEntries(Object.entries(summarizeVisual(visualCells)).filter(([, n]) => n)))} · relatório ${path.join(visualOut, "visual-report.json")}`);
  console.log(exit === 0 ? "VISUAL HOMOLOGADO: toda célula teve comparação pixel a pixel com baseline aprovada." : exit === 6 ? "VISUAL NÃO HOMOLOGADO: falta baseline aprovada/válida em alguma célula (não é aprovação nem falha; o resultado funcional acima não muda)." : `visual: código ${exit}`);
  void vrep;
  return code === EXIT.OK ? exit : code;
}

/** Grava o relatório JSON e imprime o resumo. Usado pelo caminho normal e pelo encerramento por prazo máximo (G2), com `outcome` parcial. */
function emitReport(outcome, code) {
  const file = opt.out ? path.resolve(opt.out) : path.join(tmpdir(), "levora-qa-visual", `relatorio-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ geradoEm: new Date().toISOString(), node: process.version, so: process.platform, viewports: viewports.map(viewportKey), temas: THEMES, selecao: selection, navegadores: outcome?.ran ?? [], contagem: report.counts(), diagnostico: outcome?.diag ? outcome.diag.finish(report.rows) : { solicitado: !!opt.diagnostics, ligado: false }, env: report.env, linhas: report.rows }, null, 1));
  for (const line of report.format({ verbose: opt.verbose })) console.log(line);
  console.log(opt["visual-only"] ? "Cobertura funcional: NÃO executada (--visual-only): só a parte visual rodou; nenhum PASS funcional foi produzido." : selection.completo ? `Cobertura: matriz completa (${selection.total} cenários).` : `Cobertura: SUBCONJUNTO — ${selection.executados} de ${selection.total} cenários (perfil ${selection.perfil}); NÃO executados (não contam como aprovados): ${selection.omitidos.join(", ")}`);
  console.log(`Relatório JSON: ${file}`);
  if (opt["self-test"]) console.log(`Código de saída final (autoteste): ${code}`);
}

let code; let outcome; let expired = false;
// G2: prazo máximo do próprio script (--max-minutes). Ao expirar: diz onde estava, grava o relatório PARCIAL (ENV → código 3, nunca "aprovado"), tenta limpar por até 60 s e sai.
const deadline = startDeadline({ maxMs, onExpire: async (reason) => {
  expired = true;
  const where = progress ? progress.describe() : "nenhuma célula foi concluída (a pilha ou o navegador não chegaram a medir)";
  console.log(`TEMPO MÁXIMO: ${reason}. ${where}.`);
  try { diagRef?.event("tempo-maximo", { reason, ...(progress?.snapshot() ?? {}) }); } catch { /* o diagnóstico nunca impede o encerramento */ }
  report.addEnv(`${reason}: ${where}`);
  try { emitReport({ ran: launched, diag: diagRef }, EXIT.ENV); } catch (e) { console.log(`aviso: não consegui gravar o relatório parcial (${e.message})`); }
  try { const errs = await Promise.race([cleanups.runAll(), new Promise((r) => setTimeout(() => r([{ name: "limpeza", message: "excedeu 60 s; encerrando mesmo assim (o próximo qa:visual recupera órfãos)" }]), 60000))]); for (const er of errs) console.log(`aviso de limpeza (${er.name}): ${er.message}`); } catch { /* sai de qualquer forma */ }
  process.exit(EXIT.ENV);
} });
try {
  outcome = await main();
  deadline.cancel();
  code = report.exitCode();
  if (opt.visual && !report.env.length) code = finishVisual(code, outcome);
  if (opt["self-test"] && code === EXIT.FAIL) code = EXIT.SELFTEST;
} catch (e) {
  report.addEnv(`erro inesperado: ${e.stack ?? e.message}`);
  code = EXIT.ENV;
} finally {
  const errs = await cleanups.runAll();
  for (const er of errs) console.log(`aviso de limpeza (${er.name}): ${er.message}`);
}
if (opt.cleanup) process.exit(code);
if (!expired) emitReport(outcome, code);
process.exit(code);
