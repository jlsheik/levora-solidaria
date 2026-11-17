// G4 — experimento local isolado (NÃO faz parte do qa:visual nem do CI): derruba o renderizador da aba pelo comando do PRÓPRIO CDP (`Page.crash`, sem matar processo do sistema) e
// confere que o cliente reage ao evento (Inspector.targetCrashed / Inspector.detached) NA HORA, nomeando a causa, sem esperar o timeout de 30 s, e recusa os comandos seguintes.
// Uso: QA_CHROME_PATH=... node scripts/qa-visual/experiments/crashed-page.mjs
import { findBrowser, launchBrowser, CdpSessionLost } from "../lib/browser.mjs";

const exe = findBrowser("chrome"); if (!exe) { console.error("Chrome não encontrado (QA_CHROME_PATH)"); process.exit(3); }
const s = await launchBrowser(exe); const out = { versao: s.version }; let e1;
try {
  s.cdp.context.cell = "experimento crashed-page";
  await s.cdp.send("Page.navigate", { url: "data:text/html,<title>x</title><p>ola</p>" });
  await new Promise((r) => setTimeout(r, 500));
  out.antes = await s.cdp.eval("1+1");
  const t0 = Date.now();
  const pending = s.cdp.send("Runtime.evaluate", { expression: "new Promise(() => {})", awaitPromise: true }, 30000).catch((e) => e); // pendente quando o renderizador cai
  await s.cdp.send("Page.crash", {}, 5000, { probe: false }).catch(() => {});
  e1 = await pending;
  out.pendente = { tipo: e1.name, reason: e1.reason, msAteErro: Date.now() - t0 };
  const t1 = Date.now(); const e2 = await s.cdp.send("Network.enable").catch((e) => e);
  out.seguinte = { tipo: e2.name, msParaRecusar: Date.now() - t1 };
  out.saude = s.cdp.health();
  const v = await s.diagnose({ method: "(perda por evento)", timeoutMs: 0, health: s.cdp.health() });
  out.veredito = { kind: v.kind, lost: v.lost, causa: v.causa };
  out.evidencia = { pageSecondConn: v.evidence.pageSecondConn, freshTarget: v.evidence.freshTarget, crashDumps: v.evidence.crashDumps, duracaoMs: v.evidence.duracaoMs };
} finally { await s.close(); }
out.processoEncerradoAposClose = await new Promise((r) => { let n = 0; const t = setInterval(() => { try { process.kill(s.child.pid, 0); if (++n > 20) { clearInterval(t); r(false); } } catch { clearInterval(t); r(true); } }, 250); });
console.log(JSON.stringify(out, null, 1));
process.exit(e1 instanceof CdpSessionLost ? 0 : 1);
