// Diagnóstico opt-in (--diagnostics <pasta>) da verificação visual: tempo de cada célula (navegador × cenário × viewport × tema) e, em todo MISSING,
// o estado da página, o console, a rede, a saúde do servidor e uma captura de tela. Só observa: não altera medições, esperas nem resultados.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { cleanUrl, redact } from "./redact.mjs";

const q = (v) => JSON.stringify(v);

/** Resume os eventos CDP desde o início da célula: navegações, erros de console/exceções, falhas e lentidão de rede, requisições pendentes. */
export function summarizeEvents(events) {
  const reqs = new Map(); const navigations = []; const consoleErrors = []; const exceptions = []; const logs = [];
  for (const e of events) {
    const p = e.params ?? {};
    if (e.method === "Network.requestWillBeSent") reqs.set(p.requestId, { url: cleanUrl(p.request?.url), type: p.type, t0: p.timestamp, status: null, failed: null, t1: null });
    else if (e.method === "Network.responseReceived") { const r = reqs.get(p.requestId); if (r) r.status = p.response?.status; }
    else if (e.method === "Network.loadingFinished") { const r = reqs.get(p.requestId); if (r) r.t1 = p.timestamp; }
    else if (e.method === "Network.loadingFailed") { // requisição bloqueada/abortada pode falhar sem ter emitido requestWillBeSent
      let r = reqs.get(p.requestId); if (!r) { r = { url: "(sem URL registrada)", type: p.type, t0: p.timestamp, status: null, failed: null, t1: null }; reqs.set(p.requestId, r); }
      r.failed = p.errorText || p.blockedReason || "falhou"; r.canceled = !!p.canceled; r.t1 = p.timestamp;
    }
    else if (e.method === "Page.frameNavigated" && !p.frame?.parentId) navigations.push(p.frame?.url);
    else if (e.method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "warning")) consoleErrors.push(redact(`${p.type}: ${(p.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ")}`).slice(0, 200));
    else if (e.method === "Runtime.exceptionThrown") exceptions.push(redact(String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "")).slice(0, 300));
    else if (e.method === "Log.entryAdded" && p.entry?.level === "error") logs.push(redact(String(p.entry.text)).slice(0, 200));
  }
  const all = [...reqs.values()];
  const dur = (r) => (r.t1 !== null && r.t0 !== undefined ? Math.round((r.t1 - r.t0) * 1000) : null);
  return {
    requests: all.length,
    failed: all.filter((r) => r.failed).map((r) => ({ url: r.url, error: r.failed, canceled: r.canceled })).slice(0, 15),
    http4xx5xx: all.filter((r) => r.status >= 400).map((r) => ({ url: r.url, status: r.status })).slice(0, 15),
    pending: all.filter((r) => r.t1 === null).map((r) => r.url).slice(0, 15),
    slowest: all.map((r) => ({ url: r.url, ms: dur(r) })).filter((r) => r.ms !== null).sort((a, b) => b.ms - a.ms).slice(0, 5),
    mainFrameNavigations: navigations,
    consoleErrors: consoleErrors.slice(0, 15), exceptions: exceptions.slice(0, 10), logErrors: logs.slice(0, 10),
  };
}

/** Versão curta por célula: quantas requisições, quantas falharam / deram 4xx-5xx, a mais lenta (para ver "quase falhas" que não viraram MISSING). */
export function netBrief(events) {
  const s = summarizeEvents(events); const top = s.slowest[0];
  return { n: s.requests, failed: s.failed.length, bad: s.http4xx5xx.length, maxMs: top?.ms ?? 0, maxUrl: top ? String(top.url).replace(/^https?:[/][/][^/]+/, "").slice(0, 80) : null, navs: s.mainFrameNavigations.length, exc: s.exceptions.length + s.consoleErrors.length };
}

const PAGE_STATE = `JSON.stringify({
  url: location.href, title: document.title, readyState: document.readyState, hasQaProbe: !!window.__qa,
  rootChildren: document.getElementById('root') ? document.getElementById('root').childElementCount : null,
  bodyClass: document.body ? document.body.className : null,
  visibleText: (document.body ? document.body.innerText : '').slice(0, 300),
  formControls: Array.from(document.querySelectorAll('select,input,textarea')).slice(0, 10).map(function (e) { return e.id || e.name || e.type; }),
  skeletons: document.querySelectorAll('[class*="keleton"]').length, busy: document.querySelectorAll('[aria-busy="true"]').length,
  navTiming: (function () { var n = performance.getEntriesByType('navigation')[0]; return n ? { type: n.type, domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) } : null; })(),
  resources: performance.getEntriesByType('resource').length,
  innerWidth: innerWidth, innerHeight: innerHeight, scrollWidth: document.documentElement.scrollWidth
})`;

async function probeUrl(url) {
  const t = Date.now();
  try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); return { status: r.status, ms: Date.now() - t }; } catch (e) { return { error: String(e.message).slice(0, 120), ms: Date.now() - t }; }
}

export class Diagnostics {
  constructor({ dir, stack }) {
    this.dir = path.resolve(dir); this.stack = stack; this.missing = 0; this.cells = 0; this.screenshots = 0; this.insufficient = 0; this.started = Date.now();
    mkdirSync(this.dir, { recursive: true });
    // Monitor de congelamento do próprio processo do QA (ou do sistema: suspensão, pausa longa de coleta de lixo): o laço de eventos deveria acordar a cada ~200 ms.
    let last = Date.now();
    this.lagTimer = setInterval(() => { const now = Date.now(); const lag = now - last - 200; if (lag > 1000) this.event("event-loop-lag", { lagMs: lag }); last = now; }, 200);
    this.lagTimer.unref();
  }
  event(kind, data = {}) { appendFileSync(path.join(this.dir, "events.jsonl"), `${q({ at: new Date().toISOString(), kind, ...data })}\n`); }
  /** Linha por célula: quanto tempo cada fase levou. Serve de linha de base para comparar o que passa com o que falha. */
  cell(row) { this.cells++; appendFileSync(path.join(this.dir, "timings.jsonl"), `${q({ at: new Date().toISOString(), ...row, rssMb: Math.round(process.memoryUsage().rss / 1048576) })}\n`); }
  serverLog(label, text0) { const text = redact(text0); appendFileSync(path.join(this.dir, "server.log"), `${new Date().toISOString()} [${label}] ${String(text).replace(/\r?\n$/, "")}\n`); }
  /** Chamado em cada MISSING/UNMEASURABLE de passo ou presença. Nunca lança: o diagnóstico não pode alterar o resultado. */
  async capture(ctx, sc, state, why, cellInfo) {
    const n = ++this.missing; const id = `missing-${String(n).padStart(3, "0")}-${ctx.name}-${sc.id}-${ctx.vpKey}-${ctx.theme}`;
    const out = { id, at: new Date().toISOString(), sinceRunStartS: Math.round((Date.now() - this.started) / 1000), browser: ctx.name, version: ctx.version, scenario: sc.id, viewport: ctx.vpKey, theme: ctx.theme, route: sc.path, expected: sc.target?.css, state, why, cell: cellInfo };
    try { out.page = JSON.parse(await ctx.cdp.eval(PAGE_STATE)); } catch (e) { out.pageError = String(e.message).slice(0, 200); }
    try { out.events = summarizeEvents(ctx.cdp.events.slice(cellInfo?.eventsFrom ?? 0)); } catch (e) { out.eventsError = String(e.message).slice(0, 200); }
    if (this.stack) {
      out.server = { web: await probeUrl(`${this.stack.baseUrl}/login`), api: await probeUrl(`http://127.0.0.1:${this.stack.apiPort}/_api/__health`) };
      try { out.serverLogTail = this.stack.logs?.(); } catch { /* opcional */ }
    }
    try { const shot = await ctx.cdp.send("Page.captureScreenshot", { format: "png" }, 8000); writeFileSync(path.join(this.dir, `${id}.png`), Buffer.from(shot.data, "base64")); out.screenshot = `${id}.png`; this.screenshots++; } catch (e) { out.screenshotError = String(e.message).slice(0, 120); }
    if (out.pageError || out.eventsError || out.screenshotError || cellInfo?.authVerdict === "sem-evidencia") this.insufficient++; // o diagnóstico existe, mas faltou dado para explicar a causa
    writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(out, null, 1));
    return out;
  }
  /**
   * Fecha o diagnóstico e grava summary.json: células registradas contra células do relatório (a diferença é diagnóstico faltante, nunca "sem problemas"),
   * falhas diagnosticadas, quantas com captura de tela e quantas sem dados suficientes.
   */
  finish(rows) {
    clearInterval(this.lagTimer);
    const reportCells = new Set(rows.filter((r) => !String(r.scenario).startsWith("autoteste:")).map((r) => [r.browser, r.scenario, r.viewport, r.theme].join("|"))).size;
    const s = { ligado: true, celulasRegistradas: this.cells, celulasNoRelatorio: reportCells, completo: this.cells > 0 && this.cells === reportCells, falhasDiagnosticadas: this.missing, comCapturaDeTela: this.screenshots, semDadosSuficientes: this.insufficient };
    writeFileSync(path.join(this.dir, "summary.json"), JSON.stringify(s, null, 1));
    return s;
  }
}
