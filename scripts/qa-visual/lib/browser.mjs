// Lançador mínimo de Edge/Chrome (headless) + cliente CDP, SEM dependências: usa o WebSocket global (Node >= 22, a versão declarada em package.json),
// `fetch` e `child_process`. O navegador roda com perfil temporário e porta de depuração escolhida pelo SO (--remote-debugging-port=0); tudo é
// encerrado e apagado em `close()`.
import { spawn } from "node:child_process";
import { killTree } from "./procowner.mjs";
import { TailBuffer, diagnoseChrome, procSnapshot } from "./chromeprobe.mjs";
import { summarizeEvents } from "./diagnostics.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Caminhos candidatos por navegador/plataforma (puro, testado). Se QA_EDGE_PATH / QA_CHROME_PATH estiver definida, ela é o ÚNICO candidato. */
export function candidatePaths(name, env = process.env, platform = process.platform) {
  const override = env[name === "edge" ? "QA_EDGE_PATH" : "QA_CHROME_PATH"];
  if (override) return [override]; // caminho explícito: se não existir, é ambiente indisponível (não cai nos caminhos padrão)
  const list = [];
  if (platform === "win32") {
    const roots = [env["PROGRAMFILES(X86)"], env.PROGRAMFILES, env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) list.push(name === "edge" ? path.join(r, "Microsoft", "Edge", "Application", "msedge.exe") : path.join(r, "Google", "Chrome", "Application", "chrome.exe"));
  } else if (platform === "darwin") {
    list.push(name === "edge" ? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    list.push(...(name === "edge" ? ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"] : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]));
  }
  return list;
}

export function findBrowser(name, exists = existsSync, env = process.env, platform = process.platform) {
  return candidatePaths(name, env, platform).find((p) => exists(p));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** M06: encerramento SÓ por propriedade explícita (ver lib/procowner.mjs). Sem taskkill, sem PID solto, sem filtro por nome/linha de comando. */
export { killTree };

/** Um comando ficou sem resposta dentro do prazo. A sessão pode continuar útil (timeout isolado) — quem decide é o diagnóstico independente. */
export class CdpTimeoutError extends Error {
  constructor(method, timeoutMs, verdict = null) { super(`${method}: tempo esgotado (${timeoutMs}ms)`); this.name = "CdpTimeoutError"; this.method = method; this.timeoutMs = timeoutMs; this.verdict = verdict; }
}
/** A sessão CDP está comprovadamente inutilizável (WebSocket fechado/com erro, Chrome encerrado ou sem resposta, timeouts consecutivos). `fatal`: nenhuma espera pode engolir este erro. */
export class CdpSessionLost extends Error {
  constructor(reason, detail, evidence = null) { super(`sessão CDP perdida (${reason}): ${detail}`); this.name = "CdpSessionLost"; this.fatal = true; this.reason = reason; this.detail = detail; this.evidence = evidence; }
}

/**
 * Cliente CDP. G4: saúde da sessão centralizada. (1) WebSocket fechado/com erro → todos os comandos pendentes são rejeitados na hora e os novos recusados sem esperar;
 * (2) no 1º timeout de uma sequência roda o diagnóstico independente (`stallProbe`, com teto próprio) — se provar a perda, a sessão é encerrada AGORA, em vez de 30 s por comando;
 * (3) `maxConsecutiveTimeouts` timeouts sem nenhuma resposta no meio também encerram; (4) pendentes limitados. Sem reconexão automática, sem tentar de novo, sem mascarar.
 */
export class Cdp {
  constructor(ws, { maxConsecutiveTimeouts = 2, maxPending = 500, probeBudgetMs = 15000, now = Date.now } = {}) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; this.lost = null; this.context = {}; this.stallProbe = null;
    this.maxConsecutiveTimeouts = maxConsecutiveTimeouts; this.maxPending = maxPending; this.probeBudgetMs = probeBudgetMs; this.now = now;
    this.sent = 0; this.responses = 0; this.timeouts = 0; this.consecutiveTimeouts = 0; this.lastCommand = null; this.lastOkAt = now(); this.crashed = null; this._probing = null;
    ws.onmessage = (m) => {
      let d; try { d = JSON.parse(m.data); } catch { return; } // mensagem ilegível: ignora (nunca derruba a harness)
      if (d.id !== undefined) {
        this.lastOkAt = this.now(); this.consecutiveTimeouts = 0; this.responses++; // qualquer resposta (inclusive erro do CDP) prova que a sessão está viva
        if (this.pending.has(d.id)) { const { res, rej, method } = this.pending.get(d.id); this.pending.delete(d.id); d.error ? rej(new Error(`${method}: ${d.error.message}`)) : res(d.result); }
      } else if (d.method) {
        if (d.method === "Inspector.targetCrashed" || d.method === "Inspector.detached") {
          // G4 (causa observada na execução remota 44004874634): o processo de renderização da aba MORREU ("Inspector.detached: Render process gone."). Depois disso o Chrome não responde mais a
          // NENHUM comando desta sessão, em silêncio — era o que a G3 viu como "30 s por comando". Agora o evento encerra a sessão NA HORA, com a causa nomeada, sem esperar timeout.
          this.crashed = { evento: d.method, motivo: String(d.params?.reason ?? "").slice(0, 80), at: new Date(this.now()).toISOString() };
          this._lose("renderizador-encerrado", `o processo de renderização da aba terminou (${d.method}${this.crashed.motivo ? `: ${this.crashed.motivo}` : ""}); o CDP não responde mais neste alvo`);
        }
        this.events.push(d);
      }
    };
    ws.onclose = (ev) => this._lose("websocket-fechado", `o WebSocket fechou (código ${ev?.code ?? "?"})`);
    ws.onerror = () => this._lose("websocket-erro", "erro no WebSocket");
  }
  /** Encerra a sessão: rejeita TODOS os pendentes com o mesmo erro e passa a recusar comandos novos sem esperar. Idempotente. */
  _lose(reason, detail, evidence = null) {
    if (this.lost) return this.lost;
    this.lost = new CdpSessionLost(reason, detail, evidence);
    this.lostAt = new Date(this.now()).toISOString();
    for (const p of this.pending.values()) p.rej(this.lost);
    this.pending.clear();
    return this.lost;
  }
  /** Estado da sessão, sem segredos: serve ao diagnóstico e ao relatório. */
  health() {
    return { perdida: this.lost ? { motivo: this.lost.reason, detalhe: this.lost.detail, em: this.lostAt } : null, pendentes: this.pending.size, enviados: this.sent, respostas: this.responses, timeouts: this.timeouts, timeoutsConsecutivos: this.consecutiveTimeouts,
      ultimoComando: this.lastCommand ? { metodo: this.lastCommand.method, haMs: this.now() - this.lastCommand.at } : null, msDesdeUltimaResposta: this.now() - this.lastOkAt, readyState: this.ws.readyState ?? null, alvoCaiu: this.crashed };
  }
  _probeOnce(info) { // um diagnóstico por vez; os demais timeouts simultâneos esperam o mesmo
    if (!this._probing) {
      let timer; const cap = new Promise((r) => { timer = setTimeout(() => r({ lost: false, kind: "diagnostico-sem-prazo" }), this.probeBudgetMs); });
      this._probing = Promise.race([this.stallProbe(info), cap]).catch((e) => ({ lost: false, kind: "diagnostico-falhou", error: String(e?.message ?? e).slice(0, 160) })).finally(() => { clearTimeout(timer); this._probing = null; });
    }
    return this._probing;
  }
  send(method, params = {}, timeoutMs = 30000, { probe = true } = {}) {
    if (this.lost) return Promise.reject(this.lost);
    if (this.pending.size >= this.maxPending) return Promise.reject(this._lose("pendentes-acumulados", `${this.pending.size} comandos pendentes sem resposta`));
    return new Promise((res, rej) => {
      const id = ++this.id;
      const t = setTimeout(async () => {
        if (!this.pending.delete(id)) return;
        this.timeouts++; this.consecutiveTimeouts++;
        let verdict = null;
        if (probe && this.stallProbe && !this.lost) verdict = await this._probeOnce({ method, timeoutMs, health: this.health() });
        if (this.lost) return rej(this.lost);
        if (verdict?.lost) return rej(this._lose(verdict.kind, `${method} sem resposta em ${timeoutMs}ms; ${verdict.causa ?? ""}`.trim(), verdict));
        if (probe && this.consecutiveTimeouts >= this.maxConsecutiveTimeouts) return rej(this._lose("timeouts-consecutivos", `${this.consecutiveTimeouts} comandos seguidos sem resposta (último: ${method})`, verdict));
        rej(new CdpTimeoutError(method, timeoutMs, verdict));
      }, timeoutMs);
      this.pending.set(id, { method, res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.lastCommand = { method, id, at: this.now() }; this.sent++;
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(t); this.pending.delete(id); rej(this._lose("websocket-fechado", `não foi possível enviar ${method}: ${String(e.message).slice(0, 80)}`)); }
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`erro na página: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  mouseMove(x, y) { return this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); }
  mouseDown(x, y) { return this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }); }
  mouseUp(x, y) { return this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }); }
  async click(x, y) { await this.mouseMove(x, y); await this.mouseDown(x, y); await this.mouseUp(x, y); }
  /** Tecla real. Ex.: key("Shift") só para o navegador entrar em modalidade teclado (:focus-visible). */
  async key(name) {
    const map = { Shift: [16, "ShiftLeft", ""], Tab: [9, "Tab", ""], Enter: [13, "Enter", "\r"], Escape: [27, "Escape", ""], Space: [32, "Space", " "] };
    const [vk, code, text] = map[name];
    const base = { key: name === "Space" ? " " : name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await this.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, text });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
}

/**
 * M11 / R14 — sinalizadores de RENDERIZAÇÃO determinística. Medido (m11-evidence/r14): sem eles, o Chrome produziu em 2 de 6 execuções independentes um texto rasterizado de outro modo (Δ até 131 em
 * glifos de TODAS as 24 imagens Chrome); com eles, 4 execuções independentes só variaram em Δ ≤ 2 (ruído de borda). `--disable-lcd-text` (antialiasing em tons de cinza, sem subpixel),
 * `--font-render-hinting=none` (sem hinting dependente do sistema) e `--force-color-profile=srgb` (sem perfil de cor do monitor). Fazem parte da configuração de captura (versão das baselines).
 */
export const RENDER_FLAGS = Object.freeze(["--disable-lcd-text", "--font-render-hinting=none", "--force-color-profile=srgb"]);

/** Abre o navegador e devolve { cdp, version, close }. Lança se não conseguir (o chamador classifica como ENV). */
async function launchOnce(exe, { onSpawn, onProfile, onProfileGone, extraArgs = [] } = {}) {
  const profile = mkdtempSync(path.join(tmpdir(), "levora-qa-profile-"));
  onProfile?.(profile);
  // `QA_BROWSER_NO_SANDBOX=1`: SÓ para runners descartáveis cujo kernel proíbe o sandbox de usuário (ex.: AppArmor no Ubuntu). Nunca é o padrão.
  const noSandbox = process.env.QA_BROWSER_NO_SANDBOX === "1" ? ["--no-sandbox"] : [];
  // G5: o Chrome NÃO lê `--crash-dumps-dir` (verificado no código do Chromium: o diretório do crashpad é fixo no perfil PADRÃO e só se desvia por BREAKPAD_DUMP_LOCATION ou --breakpad-dump-location).
  // Diretório exclusivo, criado aqui (permissão do próprio usuário) dentro do perfil descartável: some junto com ele. O crashpad GRAVA despejos sempre; CHROME_HEADLESS=1 NÃO é necessário para isso,
  // só impede o ENVIO (uploads exigem consentimento e ficam desligados em modo "unattended"): é uma garantia extra de que nada sai da máquina.
  const crashDir = path.join(profile, "g5-crashes"); try { mkdirSync(crashDir, { recursive: true }); } catch { /* sem diretório: o diagnóstico acusa "ilegível", o navegador sobe igual */ }
  const args = [...noSandbox, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions", "--disable-background-networking", "--window-size=1280,900", "--enable-logging=stderr", "--log-level=2", ...extraArgs, ...RENDER_FLAGS, "about:blank"];
  const child = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, detached: process.platform !== "win32", env: { ...process.env, BREAKPAD_DUMP_LOCATION: crashDir, CHROME_HEADLESS: "1" } }); // G4: stderr em cauda limitada (era "ignore"); sempre drenado
  const stderr = new TailBuffer(8192); child.stderr.on("data", (b) => stderr.push(b)); child.stderr.on("error", () => {});
  let exitInfo = null; child.on("exit", (code, signal) => { exitInfo = { code, signal, at: new Date().toISOString() }; });
  onSpawn?.(child.pid, "browser", { profile }); // perfil EXCLUSIVO desta execução: é parte da identidade do processo
  const cleanup = async () => {
    killTree(child);
    for (let i = 0; i < 8; i++) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); onProfileGone?.(profile); return; } catch { await sleep(300); } }
  };
  try {
    let port; let tries = 0;
    while (!port) {
      if (child.exitCode !== null) throw startupError(`o navegador encerrou ao iniciar (código ${child.exitCode})`);
      try { port = Number(readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]); } catch { /* ainda não escreveu */ }
      if (!port) { if (++tries > 100) throw startupError("o navegador não abriu a porta de depuração a tempo"); await sleep(150); }
    }
    const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    let page; for (let i = 0; i < 40 && !page; i++) { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); page = list.find((t) => t.type === "page"); if (!page) await sleep(150); }
    if (!page) throw startupError("o navegador não expôs uma aba");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("falha ao conectar no CDP")); });
    const cdp = new Cdp(ws);
    cdp.stallProbe = async (info) => { // diagnóstico independente do 1º timeout (ver lib/chromeprobe.mjs); contexto (célula, pilha) é preenchido pelo runner/run.mjs
      let eventsSummary; try { const s = summarizeEvents(cdp.events); eventsSummary = { requisicoes: s.requests, falhas: s.failed, pendentes: s.pending.slice(0, 8), errosConsole: s.consoleErrors.slice(0, 5), excecoes: s.exceptions.slice(0, 3) }; } catch { /* opcional */ }
      const v = await diagnoseChrome({ child, port, stderr, baseline: procBaseline, stackUrls: cdp.context.stackUrls, cdpHealth: { ...info.health, comando: info.method, prazoMs: info.timeoutMs }, cell: cdp.context.cell, eventsSummary, makeCdp: (w) => new Cdp(w, { maxConsecutiveTimeouts: Infinity }), crashDir });
      if (exitInfo) v.evidence.process = { ...v.evidence.process, saiu: exitInfo };
      return v;
    };
    const diagnose = (info) => cdp.stallProbe(info); // também usado DEPOIS de uma perda comprovada pelo evento (sem esperar timeout)
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Network.enable"); await cdp.send("Inspector.enable"); // G4: Inspector.targetCrashed/detached entram na saúde da sessão
    let procBaseline = null; if (process.platform === "linux") { try { procBaseline = procSnapshot(child.pid); } catch { /* sem /proc */ } }
    return {
      cdp, version: info.Browser, child, stderr, port, baseline: procBaseline, profile, diagnose, crashDir,
      async close() { try { await cdp.send("Browser.close", {}, 3000, { probe: false }); } catch { /* o kill abaixo garante */ } try { ws.close(); } catch { /* ok */ } await sleep(200); await cleanup(); },
    };
  } catch (e) {
    // G6: a falha de ARRANQUE passava sem nenhuma pista (run 44181731270: "não abriu a porta" e nada mais). Anexa o estado do processo e a cauda higienizada do stderr do Chrome.
    if (e.startup) { const t = (() => { try { return stderr.text(12); } catch { return []; } })(); e.message += ` [pid ${child.pid}; ${child.exitCode === null ? "ainda vivo" : `saiu com ${child.exitCode}${child.signalCode ? `/${child.signalCode}` : ""}`}; stderr ${stderr.total} bytes${t.length ? `: ${t.join(" | ")}` : ""}]`; }
    await cleanup();
    throw e;
  }
}

const startupError = (msg) => Object.assign(new Error(msg), { startup: true });

/** Abre o navegador. Falha de ARRANQUE (antes de existir sessão CDP: sem porta, saída precoce, sem aba) tem UMA nova tentativa com perfil novo: ainda não há célula, teste nem
 *  estado a perder, e nada é reduzido ou aprovado por isso. Qualquer outra falha (incluindo perda de sessão depois) NÃO é repetida. */
export async function launchBrowser(exe, opts = {}) {
  try { return await launchOnce(exe, opts); } catch (e) {
    if (!e.startup) throw e;
    console.log(`qa:visual: falha de arranque do navegador (tentativa 1 de 2): ${e.message}`);
    try { return await launchOnce(exe, opts); } catch (e2) { e2.message = `${e2.message} (após 1 nova tentativa; 1ª falha: ${e.message.slice(0, 400)})`; throw e2; }
  }
}
