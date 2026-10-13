// Lançador mínimo de Edge/Chrome (headless) + cliente CDP, SEM dependências: usa o WebSocket global (Node >= 22, a versão declarada em package.json),
// `fetch` e `child_process`. O navegador roda com perfil temporário e porta de depuração escolhida pelo SO (--remote-debugging-port=0); tudo é
// encerrado e apagado em `close()`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/** Encerra um processo e seus filhos (no Windows, `taskkill /T`). */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* já encerrado */ }
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id !== undefined && this.pending.has(d.id)) { const { res, rej, method } = this.pending.get(d.id); this.pending.delete(d.id); d.error ? rej(new Error(`${method}: ${d.error.message}`)) : res(d.result); }
      else if (d.method) this.events.push(d);
    };
  }
  send(method, params = {}, timeoutMs = 30000) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`${method}: tempo esgotado (${timeoutMs}ms)`)); }, timeoutMs);
      this.pending.set(id, { method, res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
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

/** Abre o navegador e devolve { cdp, version, close }. Lança se não conseguir (o chamador classifica como ENV). */
export async function launchBrowser(exe) {
  const profile = mkdtempSync(path.join(tmpdir(), "levora-qa-profile-"));
  const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions", "--disable-background-networking", "--window-size=1280,900", "about:blank"];
  const child = spawn(exe, args, { stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" });
  const cleanup = async () => {
    killTree(child);
    for (let i = 0; i < 8; i++) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); return; } catch { await sleep(300); } }
  };
  try {
    let port; let tries = 0;
    while (!port) {
      if (child.exitCode !== null) throw new Error(`o navegador encerrou ao iniciar (código ${child.exitCode})`);
      try { port = Number(readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]); } catch { /* ainda não escreveu */ }
      if (!port) { if (++tries > 100) throw new Error("o navegador não abriu a porta de depuração a tempo"); await sleep(150); }
    }
    const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    let page; for (let i = 0; i < 40 && !page; i++) { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); page = list.find((t) => t.type === "page"); if (!page) await sleep(150); }
    if (!page) throw new Error("o navegador não expôs uma aba");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("falha ao conectar no CDP")); });
    const cdp = new Cdp(ws);
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Network.enable");
    return {
      cdp, version: info.Browser,
      async close() { try { await cdp.send("Browser.close", {}, 3000); } catch { /* o kill abaixo garante */ } try { ws.close(); } catch { /* ok */ } await sleep(200); await cleanup(); },
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
