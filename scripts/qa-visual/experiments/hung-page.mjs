// G4 — experimento local isolado (NÃO faz parte do qa:visual nem do CI): prende o renderizador de uma aba de verdade (laço infinito) e confere que o cliente CDP
// (1) não espera 30 s por comando depois do 1º timeout, (2) classifica a perda com evidência independente e (3) recusa os comandos seguintes sem esperar.
// Uso: QA_CHROME_PATH=... node scripts/qa-visual/experiments/hung-page.mjs [--timeout-ms 4000]
import { findBrowser, launchBrowser, CdpSessionLost } from "../lib/browser.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const timeoutMs = Number(arg("timeout-ms", 4000));
const exe = findBrowser("chrome"); if (!exe) { console.error("Chrome não encontrado (QA_CHROME_PATH)"); process.exit(3); }
const s = await launchBrowser(exe);
const t0 = Date.now(); const out = { versao: s.version }; let e1;
try {
  s.cdp.context.cell = "experimento hung-page";
  await s.cdp.send("Page.navigate", { url: "data:text/html,<title>x</title><p>ola</p>" });
  await new Promise((r) => setTimeout(r, 500));
  out.antes = await s.cdp.eval("1+1");
  const hang = s.cdp.send("Runtime.evaluate", { expression: "while(true){}" }, timeoutMs).catch((e) => e);
  e1 = await hang; out.primeiroErro = { tipo: e1.name, reason: e1.reason, msAteErro: Date.now() - t0 };
  const t1 = Date.now(); const e2 = await s.cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch((e) => e);
  out.segundoComando = { tipo: e2.name, msParaRecusar: Date.now() - t1 };
  out.veredito = e1.evidence ? { kind: e1.evidence.kind, causa: e1.evidence.causa, lost: e1.evidence.lost } : null;
  const ev = e1.evidence?.evidence ?? {};
  out.evidencia = { process: ev.process, browserHttp: ev.browserHttp, browserWs: { ok: ev.browserWs?.ok, processos: ev.browserWs?.processos }, pageSecondConn: ev.pageSecondConn, freshTarget: ev.freshTarget, alvos: ev.alvos, duracaoDiagnosticoMs: ev.duracaoMs, incompleto: ev.incompleto, stderr: ev.stderr?.cauda?.slice(-5), saude: s.cdp.health() };
} finally { await s.close(); }
out.processoEncerradoAposClose = await new Promise((r) => { let n = 0; const t = setInterval(() => { try { process.kill(s.child.pid, 0); if (++n > 20) { clearInterval(t); r(false); } } catch { clearInterval(t); r(true); } }, 250); });
console.log(JSON.stringify(out, null, 1));
process.exit(e1 instanceof CdpSessionLost ? 0 : 1);
