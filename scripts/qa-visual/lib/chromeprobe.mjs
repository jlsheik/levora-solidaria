// G4 — diagnóstico INDEPENDENTE do navegador quando um comando CDP deixa de responder.
//
// Por que existe: na G3 a sessão da página parou de responder na célula 241 e a harness continuou pagando 30 s por comando durante 17 min, sem saber se o
// processo do Chrome estava vivo, se o renderizador estava preso, se a aba nova funcionaria ou se a pilha (API/Vite) tinha caído. Aqui cada pergunta é feita
// por um canal que NÃO depende da sessão presa (HTTP do endpoint de depuração, WebSocket do alvo "browser", segunda conexão à página, aba nova, /proc, pilha),
// cada passo com prazo próprio e o conjunto com um teto — o diagnóstico nunca vira outro travamento. Nada aqui grava cookie, token, URL com query nem dado real:
// só estados, contagens, nomes de processo e um trecho curto e higienizado do stderr.
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { cleanUrl, redact } from "./redact.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cauda limitada do stderr do Chrome: guarda só os últimos `maxBytes`, higieniza ao ler (URL sem query, sem segredo, sem caracteres de controle). */
export class TailBuffer {
  constructor(maxBytes = 8192) { this.max = maxBytes; this.buf = ""; this.total = 0; this.lines = 0; }
  push(chunk) {
    const s = String(chunk); this.total += s.length; this.lines += (s.match(/\n/g) ?? []).length;
    this.buf += s; if (this.buf.length > this.max) this.buf = this.buf.slice(this.buf.length - this.max);
  }
  /** No máximo `maxLines` linhas de até 300 caracteres, já higienizadas. */
  text(maxLines = 40) {
    const clean = (l) => redact(l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, (_m, u) => cleanUrl(u))).slice(0, 300);
    return this.buf.split(/\r?\n/).filter(Boolean).slice(-maxLines).map(clean);
  }
  info() { return { bytesRecebidos: this.total, linhasRecebidas: this.lines, retidos: this.buf.length }; }
}

/** Resultado de um passo com prazo próprio: { ok, ms, value | error }. Nunca lança. */
export async function step(ms, fn) {
  const t0 = Date.now(); let timer;
  try {
    const value = await Promise.race([Promise.resolve().then(fn), new Promise((_r, rej) => { timer = setTimeout(() => rej(new Error(`sem resposta em ${ms} ms`)), ms); })]);
    return { ok: true, ms: Date.now() - t0, value };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 160) }; } finally { clearTimeout(timer); }
}

// ---------- leitura de /proc (Linux) ----------
/** `/proc/<pid>/stat` → { pid, comm, state, ppid, ticks (utime+stime) }. O nome vem entre parênteses e pode conter espaços. */
export function parseStat(text) {
  const open = text.indexOf("("); const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const rest = text.slice(close + 2).split(" "); // [state, ppid, pgrp, session, tty, tpgid, flags, minflt, cminflt, majflt, cmajflt, utime, stime, ...]
  const utime = Number(rest[11]); const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { pid: Number(text.slice(0, open).trim()), comm: text.slice(open + 1, close), state: rest[0], ppid: Number(rest[1]), ticks: utime + stime };
}

/** Descendentes (incluindo a raiz) de `rootPid` num mapa pid → processo. */
export function descendants(procs, rootPid) {
  const out = []; const stack = [rootPid]; const seen = new Set();
  while (stack.length) { const p = stack.pop(); if (seen.has(p)) continue; seen.add(p); const me = procs.get(p); if (me) out.push(me); for (const q of procs.values()) if (q.ppid === p) stack.push(q.pid); }
  return out;
}

/** Foto dos processos do Chrome (raiz + filhos) a partir de /proc. `fsx` é injetável nos testes. */
export function procSnapshot(rootPid, fsx = { readdirSync, readFileSync }) {
  const procs = new Map();
  for (const name of fsx.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try { const st = parseStat(fsx.readFileSync(`/proc/${name}/stat`, "utf8")); if (st) procs.set(st.pid, st); } catch { /* o processo terminou entre a listagem e a leitura */ }
  }
  return descendants(procs, rootPid).map((p) => {
    let rssKb = null; try { rssKb = Number(fsx.readFileSync(`/proc/${p.pid}/statm`, "utf8").split(" ")[1]) * 4; } catch { /* ok */ }
    let type = null; try { const cl = fsx.readFileSync(`/proc/${p.pid}/cmdline`, "utf8").replace(/\0/g, " "); const m = /--type=([a-z-]+)/.exec(cl); const sub = /--utility-sub-type=([A-Za-z.]+)/.exec(cl); type = m ? (sub ? `${m[1]}:${sub[1]}` : m[1]) : "browser"; } catch { /* ok */ }
    return { pid: p.pid, type, state: p.state, ticks: p.ticks, rssKb };
  });
}

/** Processos NÃO renderizadores (rede, GPU, zigoto...) que surgiram ou sumiram desde a foto de partida: sinal de que um serviço do Chrome caiu e foi recriado. Renderizadores nascem e morrem normalmente. */
export function processChanges(baseline, now) {
  const keep = (l) => (l ?? []).filter((p) => p.type !== "renderer");
  const before = new Map(keep(baseline).map((p) => [p.pid, p.type])); const after = new Map(keep(now).map((p) => [p.pid, p.type]));
  return { surgiram: [...after].filter(([pid]) => !before.has(pid)).map(([pid, type]) => ({ pid, type })), sumiram: [...before].filter(([pid]) => !after.has(pid)).map(([pid, type]) => ({ pid, type })) };
}

/** CPU (% de um núcleo) por processo entre duas fotos tiradas com `dtMs` de intervalo (100 ticks/s no Linux). */
export function cpuBetween(a, b, dtMs, hz = 100) {
  const before = new Map(a.map((p) => [p.pid, p]));
  return b.map((p) => { const o = before.get(p.pid); return { pid: p.pid, type: p.type, state: p.state, rssMb: p.rssKb == null ? null : Math.round(p.rssKb / 1024), cpuPct: o ? Math.round(((p.ticks - o.ticks) / hz / (dtMs / 1000)) * 100) : null }; });
}

// ---------- CDP de uma conversa curta ----------
/** Abre um WebSocket com prazo. `WS` é injetável. */
export function openWs(WS, url, ms) {
  return new Promise((res, rej) => {
    let ws; const t = setTimeout(() => { try { ws?.close(); } catch { /* ok */ } rej(new Error(`websocket não abriu em ${ms} ms`)); }, ms);
    try { ws = new WS(url); } catch (e) { clearTimeout(t); rej(e); return; }
    ws.onopen = () => { clearTimeout(t); res(ws); };
    ws.onerror = () => { clearTimeout(t); rej(new Error("falha ao conectar no CDP")); };
  });
}

/** Uma chamada CDP numa conexão NOVA, com prazo total; fecha a conexão sempre. `makeCdp(ws)` devolve o cliente. */
async function oneShot({ WS, url, makeCdp, ms, calls }) {
  let ws;
  try {
    ws = await openWs(WS, url, ms);
    const cdp = makeCdp(ws); const out = [];
    for (const [method, params] of calls) out.push(await cdp.send(method, params ?? {}, ms, { probe: false }));
    return out;
  } finally { try { ws?.close(); } catch { /* ok */ } }
}

/**
 * Veredito a partir das evidências (puro, testado). `lost` = a sessão não é recuperável SEM mascarar a falha; o resto é diagnóstico.
 * Ordem: processo → endpoint do navegador → página numa conexão nova → aba nova.
 */
export function classifyStall(ev) {
  const stackKnown = !!ev.stack; const stackDown = stackKnown && (ev.stack.web?.ok === false || ev.stack.api?.ok === false);
  const busy = (ev.browserWs?.processos ?? []).filter((p) => p.tipo === "renderer" && p.cpuPct >= 80).length + (Array.isArray(ev.processosOs) ? ev.processosOs.filter((p) => p.type === "renderer" && p.cpuPct >= 80).length : 0);
  const base = { stackDown, stackKnown, rendererOcupado: busy > 0 };
  const stackTxt = stackDown ? "a API/Vite não responde" : stackKnown ? "a pilha responde" : "a pilha não foi consultada";
  if (ev.process?.alive === false) return { ...base, lost: true, kind: "chrome-encerrado", causa: "infraestrutura (o processo do Chrome não existe mais)" };
  if (ev.browserHttp?.ok === false && ev.browserWs?.ok === false) return { ...base, lost: true, kind: "chrome-sem-resposta", causa: "infraestrutura ou Chrome (processo vivo, mas nem o endpoint de depuração nem o alvo browser respondem)" };
  if (ev.pageSecondConn?.ok === true) return { ...base, lost: false, kind: "timeout-isolado", causa: "a página responde numa conexão nova: só o comando (ou a conexão da harness) estagnou" };
  if (ev.pageSecondConn?.ok === false) {
    const cpu = busy > 0 ? `, com ${busy} renderizador(es) consumindo CPU (laço ocupado)` : ", sem renderizador consumindo CPU (preso sem ocupar CPU: espera/bloqueio)";
    if (ev.freshTarget?.ok === true) return { ...base, lost: true, kind: stackDown ? "pagina-travada-pilha-indisponivel" : "pagina-travada", causa: `a aba não responde${cpu}; o navegador e uma aba nova funcionam; ${stackTxt}: causa indeterminada (página, renderizador ou harness)` };
    return { ...base, lost: true, kind: "navegador-degradado", causa: `a aba não responde e uma aba nova também não; ${stackTxt}: navegador degradado` };
  }
  return { ...base, lost: false, kind: "inconclusivo", causa: "diagnóstico sem dados suficientes" };
}

/**
 * Coleta as evidências (cada passo com prazo próprio; teto `budgetMs` no conjunto). Nunca lança.
 * Entradas: child (processo do Chrome), port (depuração), stderr (TailBuffer), stackUrls {web, api}, cdpHealth (snapshot do cliente), cell (última célula).
 */
export async function diagnoseChrome({ child, port, stderr, stackUrls, cdpHealth, cell, eventsSummary, baseline, fetchImpl = fetch, WS = WebSocket, makeCdp, platform = process.platform, snapshotFn = procSnapshot, stepMs = 3000, budgetMs = 12000 }) {
  const t0 = Date.now(); const ev = { quando: new Date().toISOString(), plataforma: `${platform}/${process.arch}`, celula: cell ?? null, cdp: cdpHealth ?? null };
  const body = async () => {
    const pid = child?.pid;
    let alive = null; if (pid) { try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === "EPERM"; } }
    ev.process = { pid: pid ?? null, alive, exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null };
    ev.host = { loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100), freeMemMb: Math.round(os.freemem() / 1048576), totalMemMb: Math.round(os.totalmem() / 1048576), uptimeS: Math.round(os.uptime()), harnessRssMb: Math.round(process.memoryUsage().rss / 1048576) };
    ev.stderr = stderr ? { ...stderr.info(), cauda: stderr.text() } : null;
    if (eventsSummary) ev.celulaAtual = eventsSummary;
    const get = (p) => fetchImpl(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(stepMs) }).then((r) => r.json());
    // passos independentes em paralelo
    const [version, list, osA, stackWeb, stackApi] = await Promise.all([
      step(stepMs, () => get("/json/version")),
      step(stepMs, () => get("/json/list")),
      step(stepMs, async () => (platform === "linux" && pid ? snapshotFn(pid) : null)),
      stackUrls?.web ? step(stepMs, () => fetchImpl(stackUrls.web, { signal: AbortSignal.timeout(stepMs) }).then((r) => r.status)) : null,
      stackUrls?.api ? step(stepMs, () => fetchImpl(stackUrls.api, { signal: AbortSignal.timeout(stepMs) }).then((r) => r.status)) : null,
    ]);
    ev.browserHttp = { ok: version.ok, ms: version.ms, ...(version.ok ? { versao: version.value.Browser } : { error: version.error }) };
    const targets = list.ok ? list.value : [];
    ev.alvos = list.ok ? targets.map((t) => ({ tipo: t.type, url: cleanUrl(t.url).slice(0, 120), titulo: redact(t.title ?? "").slice(0, 60) })) : { error: list.error };
    if (stackWeb || stackApi) ev.stack = { web: stackWeb && { ok: stackWeb.ok && stackWeb.value < 500, ms: stackWeb.ms, status: stackWeb.value, error: stackWeb.error }, api: stackApi && { ok: stackApi.ok && stackApi.value < 500, ms: stackApi.ms, status: stackApi.value, error: stackApi.error } };
    const page = targets.find((t) => t.type === "page");
    // segunda conexão à MESMA página (a da harness pode estar presa; esta é nova)
    const pageSecond = page ? step(stepMs, async () => (await oneShot({ WS, url: page.webSocketDebuggerUrl, makeCdp, ms: stepMs, calls: [["Runtime.evaluate", { expression: "1+1", returnByValue: true }]] }))[0].result.value) : Promise.resolve({ ok: false, ms: 0, error: "nenhuma aba encontrada em /json/list" });
    // alvo browser: processos do Chrome (CPU por tipo) e aba nova
    const browserUrl = version.ok ? version.value.webSocketDebuggerUrl : null;
    const browserSide = browserUrl ? step(stepMs * 2 + 1500, async () => { // 2 conversas + 1 s de amostragem de CPU
      const ws = await openWs(WS, browserUrl, stepMs); const cdp = makeCdp(ws);
      try {
        const out = {};
        const p1 = await cdp.send("SystemInfo.getProcessInfo", {}, stepMs, { probe: false }).catch(() => null);
        out.tg = (await cdp.send("Target.getTargets", {}, stepMs, { probe: false })).targetInfos.length;
        let fresh = { ok: false };
        try {
          const created = await cdp.send("Target.createTarget", { url: "about:blank" }, stepMs, { probe: false });
          try { fresh = { ok: (await oneShot({ WS, url: `ws://127.0.0.1:${port}/devtools/page/${created.targetId}`, makeCdp, ms: stepMs, calls: [["Runtime.evaluate", { expression: "1+1", returnByValue: true }]] }))[0].result.value === 2 }; } catch (e) { fresh = { ok: false, error: String(e.message).slice(0, 100) }; }
          finally { await cdp.send("Target.closeTarget", { targetId: created.targetId }, stepMs, { probe: false }).catch(() => {}); }
        } catch (e) { fresh = { ok: false, error: String(e.message).slice(0, 100) }; }
        out.fresh = fresh;
        await sleep(1000);
        const p2 = p1 ? await cdp.send("SystemInfo.getProcessInfo", {}, stepMs, { probe: false }).catch(() => null) : null;
        if (p1 && p2) { const m = new Map(p1.processInfo.map((p) => [p.id, p])); out.processos = p2.processInfo.map((p) => ({ tipo: p.type, id: p.id, cpuPct: m.has(p.id) ? Math.round((p.cpuTime - m.get(p.id).cpuTime) * 100) : null })); }
        return out;
      } finally { try { ws.close(); } catch { /* ok */ } }
    }) : Promise.resolve({ ok: false, ms: 0, error: "sem URL do alvo browser (/json/version falhou)" });
    const [ps, bs] = await Promise.all([pageSecond, browserSide]);
    ev.pageSecondConn = ps;
    ev.browserWs = { ok: bs.ok, ms: bs.ms, ...(bs.ok ? { alvos: bs.value.tg, processos: bs.value.processos } : { error: bs.error }) };
    ev.freshTarget = bs.ok ? bs.value.fresh : { ok: false, error: bs.error };
    if (osA.ok && osA.value && baseline) ev.mudancaDeProcessos = processChanges(baseline, osA.value);
    if (osA.ok && osA.value) { const second = await step(stepMs, async () => { await sleep(1000); return snapshotFn(pid); }); ev.processosOs = second.ok ? cpuBetween(osA.value, second.value, 1000) : { error: second.error }; }
  };
  let timer;
  const done = await Promise.race([body().then(() => true), new Promise((r) => { timer = setTimeout(() => r(false), budgetMs); })]);
  clearTimeout(timer);
  ev.incompleto = !done; ev.duracaoMs = Date.now() - t0;
  return { ...classifyStall(ev), evidence: ev };
}

// ---------- batimento periódico de saúde (G4) ----------
/**
 * Leitura barata (≈ 2 GETs + /proc) do que se perde sem aviso quando algo cai no meio da matriz: processo do Chrome, serviços auxiliares (rede/GPU), memória, carga do runner, API e Vite.
 * Nunca lança e cada passo tem prazo curto. Só números e nomes de processo.
 */
export async function quickHealth({ child, stackUrls, baseline, platform = process.platform, fetchImpl = fetch, snapshotFn = procSnapshot, stepMs = 2000 }) {
  const out = { carga: os.loadavg().map((n) => Math.round(n * 100) / 100), livreMb: Math.round(os.freemem() / 1048576), harnessRssMb: Math.round(process.memoryUsage().rss / 1048576) };
  let alive = null; if (child?.pid) { try { process.kill(child.pid, 0); alive = true; } catch (e) { alive = e.code === "EPERM"; } }
  out.chromeVivo = alive;
  const ping = async (url) => { const r = await step(stepMs, () => fetchImpl(url, { signal: AbortSignal.timeout(stepMs) }).then((x) => x.status)); return r.ok ? { status: r.value, ms: r.ms } : { erro: r.error, ms: r.ms }; };
  const [web, api, procs] = await Promise.all([stackUrls?.web ? ping(stackUrls.web) : null, stackUrls?.api ? ping(stackUrls.api) : null, step(stepMs, async () => (platform === "linux" && child?.pid ? snapshotFn(child.pid) : null))]);
  if (web) out.web = web; if (api) out.api = api;
  if (procs.ok && procs.value) {
    const l = procs.value; out.processos = l.length; out.renderizadores = l.filter((p) => p.type === "renderer").length; out.chromeRssMb = Math.round(l.reduce((a, p) => a + (p.rssKb ?? 0), 0) / 1024);
    if (baseline) out.mudancaDeProcessos = processChanges(baseline, l);
  }
  return out;
}
export const healthLine = (h) => `saúde: chrome ${h.chromeVivo === false ? "MORTO" : "vivo"}${h.processos !== undefined ? ` · ${h.processos} proc (${h.renderizadores} renderizadores) · ${h.chromeRssMb} MB` : ""}${h.mudancaDeProcessos && (h.mudancaDeProcessos.surgiram.length || h.mudancaDeProcessos.sumiram.length) ? ` · SERVIÇOS ALTERADOS +${h.mudancaDeProcessos.surgiram.map((p) => p.type).join(",")} −${h.mudancaDeProcessos.sumiram.map((p) => p.type).join(",")}` : ""} · web ${h.web ? (h.web.status ?? `ERRO ${h.web.erro}`) : "-"}${h.web?.ms !== undefined ? ` ${h.web.ms}ms` : ""} · api ${h.api ? (h.api.status ?? `ERRO ${h.api.erro}`) : "-"}${h.api?.ms !== undefined ? ` ${h.api.ms}ms` : ""} · carga ${h.carga[0]} · livre ${h.livreMb} MB · harness ${h.harnessRssMb} MB`;

/** Liga o batimento a cada `everyMs` (sem sobreposição; o temporizador não segura o processo). `onBeat(health)` recebe cada leitura. */
export function startHeartbeat({ everyMs = 60000, collect, onBeat, setTimer = setInterval, clearTimer = clearInterval }) {
  let busy = false;
  const t = setTimer(async () => { if (busy) return; busy = true; try { onBeat(await collect()); } catch { /* o batimento nunca derruba a execução */ } finally { busy = false; } }, everyMs);
  t?.unref?.();
  return { stop() { clearTimer(t); } };
}
