// G4 — experimento local isolado (NÃO faz parte do qa:visual nem do CI): reutiliza UM navegador e UMA pilha por muitas voltas da sequência da célula 241
// (regularization-error → regularization-filter-select → regularization-filter-no-results, 4 viewports × 2 temas = 24 células por volta) para ver se alguma
// volta degrada (tempo por célula, falhas de rede, perda de sessão). Uso (banco *_qa descartável e exclusivo, Chrome local):
//   QA_DATABASE_URL=postgres://.../meu_experimento_qa QA_CHROME_PATH=... node scripts/qa-visual/experiments/regularization-loop.mjs --laps 15 --out relatorio.json
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser, launchBrowser, CdpSessionLost } from "../lib/browser.mjs";
import { startStack, prepareDatabase, dropDatabase, resolveDatabaseUrl } from "../lib/stack.mjs";
import { installProbe, runScenarios } from "../lib/runner.mjs";
import { Report } from "../lib/report.mjs";
import { SCENARIOS, QA_PASSWORD } from "../scenarios.mjs";
import { VIEWPORTS } from "../lib/viewport.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { values: o } = parseArgs({ options: { laps: { type: "string", default: "10" }, out: { type: "string" } } });
const laps = Number(o.laps); const ids = ["regularization-error", "regularization-filter-select", "regularization-filter-no-results"];
const scenarios = SCENARIOS.filter((s) => ids.includes(s.id));
const dbUrl = resolveDatabaseUrl({ root }); if (!dbUrl) { console.error("defina QA_DATABASE_URL (banco *_qa descartável)"); process.exit(3); }
const exe = findBrowser("chrome"); if (!exe) { console.error("Chrome não encontrado"); process.exit(3); }
process.env.QA_PASSWORD = QA_PASSWORD;
const runId = `exp-${Date.now()}`; const filesDir = mkdtempSync(path.join(tmpdir(), "levora-qa-profile-files-"));
const out = { laps, voltas: [], erro: null }; let stack; let session;
try {
  await prepareDatabase(dbUrl, root, { runId });
  stack = await startStack({ root, databaseUrl: dbUrl });
  session = await launchBrowser(exe);
  await installProbe(session.cdp);
  const auth = { current: null }; out.versao = session.version;
  for (let lap = 1; lap <= laps; lap++) {
    const report = new Report(); const t0 = Date.now();
    await runScenarios({ cdp: session.cdp, browserName: "chrome", version: session.version, baseUrl: stack.baseUrl, scenarios, viewports: VIEWPORTS, report, filesDir, auth });
    const c = report.counts(); out.voltas.push({ lap, ms: Date.now() - t0, ...c, falhasCdp: session.cdp.timeouts, saude: { pendentes: session.cdp.pending.size } });
    console.log(`volta ${lap}/${laps}: ${Date.now() - t0} ms · PASS=${c.PASS} FAIL=${c.FAIL} MISSING=${c.MISSING} UNMEASURABLE=${c.UNMEASURABLE}`);
  }
} catch (e) { out.erro = { tipo: e.name, msg: String(e.message).slice(0, 300), perda: e instanceof CdpSessionLost ? e.reason : null }; console.log(`ERRO: ${out.erro.tipo}: ${out.erro.msg}`); }
finally {
  try { await session?.close(); } catch { /* ok */ }
  try { await stack?.stop(); } catch { /* ok */ }
  try { await dropDatabase(dbUrl, { runId }); } catch (e) { console.log(`aviso: banco não removido (${e.message})`); }
  rmSync(filesDir, { recursive: true, force: true });
}
if (o.out) writeFileSync(path.resolve(o.out), JSON.stringify(out, null, 1));
process.exit(out.erro ? 1 : 0);
