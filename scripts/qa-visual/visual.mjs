#!/usr/bin/env node
// Validação visual com capturas reais e baselines revisáveis (M02). Veja docs/QA_VISUAL.md ("Regressão visual").
//
//   capture  --base-url URL   gera CANDIDATAS (imagem + impressão de layout + metadados) em --baseline-dir; nunca aprova e nunca toca numa aprovada
//   compare  --base-url URL   compara pixel a pixel com a baseline APROVADA; escreve o relatório, as imagens atuais/baseline/diferença e o manifesto de evidências
//   approve  --id ID --sha256 HASH --reviewer NOME --yes [--replace] [--note TEXTO]   aprovação EXPLÍCITA de uma candidata (única forma de criar uma referência oficial)
//   status   [--baseline-dir DIR]   lista baselines por estado e audita arquivos/hashes
//   verify   --out DIR              confere o manifesto de evidências de uma execução
//   gallery  --baseline-dir DIR --out DIR --source produto|fixture   galeria HTML estática para REVISÃO humana (não aprova nada)
//   determinism --a DIR --b DIR     compara duas execuções de `capture` do mesmo conjunto (os pixels têm de ser iguais)
//
// Para o app real (com banco descartável e pilha própria) use `npm run qa:visual -- --visual capture|compare` (run.mjs); aqui o app já tem de estar de pé em --base-url (útil para fixtures e depuração).
// Códigos de saída: 0 homologado (tudo VISUAL_PASS) · 1 regressão visual ou falha funcional · 2 inconclusivo · 3 ambiente indisponível · 6 NÃO HOMOLOGADO (falta baseline aprovada/válida; não é aprovação nem falha).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { findBrowser, launchBrowser } from "./lib/browser.mjs";
import { installProbe } from "./lib/runner.mjs";
import { parseViewportsOption } from "./lib/viewport.mjs";
import { BaselineError, BASELINE_STATE, approveBaseline, auditBaselines, loadManifest } from "./lib/baseline.mjs";
import { VISUAL_EXIT, runVisualForBrowser, verifyEvidence, writeVisualReport } from "./lib/visualrun.mjs";
import { buildGallery } from "./lib/gallery.mjs";
import { assertApprovable } from "./visual-calibration.mjs";
import { compareRuns } from "./lib/review.mjs";
import { encodePng } from "./lib/png.mjs";
import { VISUAL_PAGES, VISUAL_THEMES, VISUAL_VIEWPORTS, selectPages } from "./visual-matrix.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultBaselineDir = path.join(here, "visual-baselines");
const [cmd, ...rest] = process.argv.slice(2);
const { values: o } = parseArgs({ args: rest, options: {
  "base-url": { type: "string" }, browser: { type: "string", default: "both" }, pages: { type: "string" }, viewports: { type: "string" }, "baseline-dir": { type: "string", default: defaultBaselineDir }, out: { type: "string" },
  "source-sha": { type: "string" }, matrix: { type: "string" }, a: { type: "string" }, b: { type: "string" }, source: { type: "string" }, title: { type: "string" }, id: { type: "string" }, sha256: { type: "string" }, reviewer: { type: "string" }, note: { type: "string" }, replace: { type: "boolean", default: false }, yes: { type: "boolean", default: false },
} });
const fail = (msg, code = VISUAL_EXIT.ENV) => { console.error(msg); process.exit(code); };

if (cmd === "status") {
  const a = auditBaselines(o["baseline-dir"]); const m = loadManifest(o["baseline-dir"]);
  console.log(`baselines em ${o["baseline-dir"]}: ${a.entries} entrada(s) · ${a.approved} aprovada(s) · ${a.candidates} candidata(s)`);
  for (const e of m.entries) console.log(`${e.state.padEnd(10)} ${e.id}  sha256=${e.imageSha256.slice(0, 12)}…  ${e.browser} ${e.browserVersion}  ${e.state === "APPROVED" ? `aprovada por ${e.approvedBy} em ${e.approvedAt}` : `capturada de ${e.sourceSha.slice(0, 7)}`}`);
  for (const i of a.issues) console.log(`PROBLEMA ${i}`);
  process.exit(a.issues.length ? VISUAL_EXIT.INCONCLUSIVE : 0);
}
if (cmd === "verify") {
  if (!o.out) fail("verify exige --out DIR");
  const v = verifyEvidence(path.resolve(o.out)); console.log(`${v.files} arquivo(s) no manifesto; divergências: ${v.bad.length}`); for (const b of v.bad) console.log(`DIVERGE ${b}`);
  process.exit(v.bad.length ? VISUAL_EXIT.INCONCLUSIVE : 0);
}
if (cmd === "approve") {
  if (!o.id || !o.sha256) fail("approve exige --id e --sha256 (hash da candidata, como mostrado por `status`)");
  if (!o.yes) fail("approve exige --yes: aprovar uma referência é uma decisão humana explícita; confira a imagem antes");
  try { assertApprovable(o.id); } catch (e) { if (e.code === "UNCALIBRATED_CELL") fail(`recusado (${e.code}): ${e.message}`, 1); throw e; } // M12: grupo em NEEDS_INVESTIGATION não se aprova
  try { const e = approveBaseline(path.resolve(o["baseline-dir"]), { id: o.id, imageSha256: o.sha256, reviewer: o.reviewer, note: o.note, replace: o.replace }); console.log(`APROVADA ${e.id} sha256=${e.imageSha256} por ${e.approvedBy} em ${e.approvedAt}`); process.exit(0); }
  catch (e) { if (e instanceof BaselineError) fail(`recusado (${e.code}): ${e.message}`, 1); throw e; }
}
if (cmd === "gallery") { // galeria HTML estática para revisão humana (não aprova nada)
  if (!o.out) fail("gallery exige --out DIR");
  if (!["produto", "fixture"].includes(o.source)) fail("gallery exige --source produto|fixture (a origem das imagens precisa estar explícita na galeria)");
  const m = buildGallery({ baselineDir: path.resolve(o["baseline-dir"]), outDir: path.resolve(o.out), sourceKind: o.source, title: o.title ?? "Revisão das baselines visuais", pageOrder: VISUAL_PAGES.map((p) => p.id) });
  console.log(`galeria: ${m.summary.total} célula(s), ${m.summary.candidates} candidata(s), ${m.summary.approved} aprovada(s); problemas high=${m.summary.issues.high} medium=${m.summary.issues.medium}; Chrome×Edge diferentes ${m.summary.crossBrowserDifferent}/${m.summary.crossBrowserPairs}`);
  console.log(`abra: ${path.join(path.resolve(o.out), "index.html")}`); process.exit(0);
}
if (cmd === "determinism") { // duas execuções de captura do mesmo conjunto: os pixels precisam ser iguais (ou a diferença precisa ser explicada)
  if (!o.a || !o.b) fail("determinism exige --a DIR --b DIR (duas execuções de `capture`)");
  const dirs = { a: path.resolve(o.a), b: path.resolve(o.b) }; const rep = {};
  for (const k of ["a", "b"]) { const v = verifyEvidence(dirs[k]); if (v.bad.length) { console.log(`evidência de ${k} NÃO confere (${v.bad.length} divergência(s)): ${v.bad[0]}`); process.exit(VISUAL_EXIT.INCONCLUSIVE); } rep[k] = JSON.parse(readFileSync(path.join(dirs[k], "visual-report.json"), "utf8")); }
  const r = compareRuns({ aCells: rep.a.celulas, bCells: rep.b.celulas, read: (side, rel) => readFileSync(path.join(dirs[side], rel)) });
  const outDir = path.resolve(o.out ?? path.join(dirs.b, "determinismo")); mkdirSync(path.join(outDir, "diffs"), { recursive: true });
  const slim = r.cells.map(({ diffImage, ...c }) => c); for (const c of r.cells) if (c.diffImage) writeFileSync(path.join(outDir, "diffs", `${c.id}.png`), encodePng(c.diffImage));
  writeFileSync(path.join(outDir, "determinism-report.json"), JSON.stringify({ geradoEm: new Date().toISOString(), a: o.a, b: o.b, contagem: r.counts, deterministico: r.deterministic, maskCandidates: r.maskCandidates, celulas: slim }, null, 2) + "\n");
  console.log(`determinismo: ${r.deterministic ? "SIM (todas as células com pixels iguais)" : "NÃO"} · ${JSON.stringify(r.counts)}`); for (const m of r.maskCandidates) console.log(`variou ${m.id} bbox=${JSON.stringify(m.bbox)} ${m.pixels}px`);
  console.log(`relatório: ${path.join(outDir, "determinism-report.json")}`); process.exit(r.deterministic ? 0 : VISUAL_EXIT.FAIL);
}
if (cmd !== "capture" && cmd !== "compare") fail("uso: visual.mjs capture|compare|approve|status|verify  (veja o cabeçalho do arquivo)");

// ---- capture | compare
if (!o["base-url"]) fail(`${cmd} exige --base-url (app já em execução). Para o app real com banco descartável use: npm run qa:visual -- --visual ${cmd}`);
let matrix = { pages: VISUAL_PAGES, themes: VISUAL_THEMES, viewports: VISUAL_VIEWPORTS };
if (o.matrix) { const m = await import(pathToFileURL(path.resolve(o.matrix)).href); matrix = { pages: m.VISUAL_PAGES ?? VISUAL_PAGES, themes: m.VISUAL_THEMES ?? VISUAL_THEMES, viewports: m.VISUAL_VIEWPORTS ?? VISUAL_VIEWPORTS }; }
let pages; let viewports;
try { pages = selectPages(matrix.pages, o.pages); viewports = o.viewports ? parseViewportsOption(o.viewports, matrix.viewports) : [...matrix.viewports]; } catch (e) { fail(e.message); }
let sourceSha = o["source-sha"];
if (!sourceSha) { try { sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { fail("não consegui descobrir o SHA testado; informe --source-sha"); } }
const wanted = o.browser === "both" || o.browser === "auto" ? ["chrome", "edge"] : [o.browser];
if (!wanted.every((b) => ["chrome", "edge"].includes(b))) fail("--browser: chrome, edge ou both");
const outDir = path.resolve(o.out ?? path.join(tmpdir(), "levora-qa-visual-regression", `${cmd}-${new Date().toISOString().replace(/[:.]/g, "-")}`)); mkdirSync(outDir, { recursive: true });
const baselineDir = path.resolve(o["baseline-dir"]); const filesDir = mkdtempSync(path.join(tmpdir(), "levora-qa-visual-files-"));
const cells = []; const browsers = [];
try {
  for (const name of wanted) {
    const exe = findBrowser(name); if (!exe) fail(`${name} não encontrado (defina QA_${name.toUpperCase()}_PATH)`);
    const session = await launchBrowser(exe);
    try {
      await installProbe(session.cdp); browsers.push({ name, version: session.version }); console.log(`${name}: ${session.version}`);
      cells.push(...await runVisualForBrowser({ session, browserName: name, baseUrl: o["base-url"].replace(/\/$/, ""), mode: cmd, pages, viewports, themes: matrix.themes, baselineDir, outDir, sourceSha, filesDir }));
    } finally { await session.close(); }
  }
} finally { rmSync(filesDir, { recursive: true, force: true }); }
const { report, exit } = writeVisualReport(outDir, { meta: { mode: cmd, sourceSha, baseUrl: "(local)", browsers, baselineDir: path.relative(process.cwd(), baselineDir) || ".", pages: pages.map((p) => p.id) }, cells });
for (const c of cells.filter((x) => !["VISUAL_PASS", "CANDIDATE_CREATED"].includes(x.status))) console.log(`${c.status.padEnd(18)} ${c.id} — ${c.detail}`);
console.log(`Resumo: ${JSON.stringify(Object.fromEntries(Object.entries(report.resumo).filter(([, n]) => n)))}`);
console.log(`Relatório: ${path.join(outDir, "visual-report.json")}`);
console.log(exit === VISUAL_EXIT.OK ? "HOMOLOGADO: todas as células tiveram comparação pixel a pixel com baseline aprovada." : exit === VISUAL_EXIT.NOT_HOMOLOGATED ? "NÃO HOMOLOGADO: falta baseline aprovada/válida em alguma célula (não é aprovação nem falha)." : `código de saída ${exit}`);
process.exit(exit);
