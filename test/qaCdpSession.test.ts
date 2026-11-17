/**
 * G4 — saúde da sessão CDP, diagnóstico independente do Chrome e fail-fast do `qa:visual`. Lógica pura e sessões sintéticas (WebSocket falso, processos falsos);
 * nada aqui abre o Chrome. O experimento com Chrome de verdade (aba presa por um laço infinito) é opt-in: QA_CDP_REAL_BROWSER=1 (e QA_CHROME_PATH se preciso).
 */
import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
// @ts-expect-error módulos .mjs sem tipos
import { Cdp, CdpSessionLost, CdpTimeoutError, findBrowser } from "../scripts/qa-visual/lib/browser.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { TailBuffer, step, parseStat, descendants, cpuBetween, procSnapshot, classifyStall, diagnoseChrome, processChanges, quickHealth, healthLine, startHeartbeat, dmesgTail } from "../scripts/qa-visual/lib/chromeprobe.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { waitUntil } from "../scripts/qa-visual/lib/wait.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { runScenarios } from "../scripts/qa-visual/lib/runner.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { Report, EXIT, expectedCombos, coverageGaps } from "../scripts/qa-visual/lib/report.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { Progress } from "../scripts/qa-visual/lib/progress.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { SCENARIOS } from "../scripts/qa-visual/scenarios.mjs";

/** WebSocket falso: guarda o que foi enviado; o teste responde/fecha como quiser. */
class FakeWs {
  sent: any[] = []; readyState = 1; onmessage: any; onclose: any; onerror: any; throwOnSend = false;
  send(data: string) { if (this.throwOnSend) throw new Error("socket fechado"); this.sent.push(JSON.parse(data)); }
  reply(id: number, result: any = {}) { this.onmessage({ data: JSON.stringify({ id, result }) }); }
  replyError(id: number, message: string) { this.onmessage({ data: JSON.stringify({ id, error: { message } }) }); }
  event(method: string, params: any = {}) { this.onmessage({ data: JSON.stringify({ method, params }) }); }
  close(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("Cdp — WebSocket e comandos pendentes", () => {
  it("fechamento inesperado do WebSocket rejeita TODOS os pendentes com o mesmo erro e recusa comandos novos sem esperar", async () => {
    const ws = new FakeWs(); const cdp = new Cdp(ws);
    const a = cdp.send("Runtime.evaluate", {}, 30000).catch((e: any) => e);
    const b = cdp.send("Page.navigate", {}, 30000).catch((e: any) => e);
    expect(cdp.pending.size).toBe(2);
    ws.close(1006);
    const [ea, eb] = await Promise.all([a, b]);
    expect(ea).toBeInstanceOf(CdpSessionLost); expect(eb).toBe(ea);
    expect(ea.reason).toBe("websocket-fechado"); expect(ea.fatal).toBe(true);
    expect(cdp.pending.size).toBe(0);
    const t0 = Date.now(); const c = await cdp.send("Network.enable").catch((e: any) => e);
    expect(c).toBe(ea); expect(Date.now() - t0).toBeLessThan(50); // sem esperar 30 s
    expect(cdp.health().perdida.motivo).toBe("websocket-fechado");
  });
  it("erro do WebSocket também encerra a sessão", async () => {
    const ws = new FakeWs(); const cdp = new Cdp(ws);
    const p = cdp.send("Runtime.evaluate", {}, 30000).catch((e: any) => e);
    ws.onerror({});
    expect((await p).reason).toBe("websocket-erro");
  });
  it("falha ao enviar (socket já fechado) vira sessão perdida, não timeout de 30 s", async () => {
    const ws = new FakeWs(); ws.throwOnSend = true; const cdp = new Cdp(ws);
    const e = await cdp.send("Page.enable").catch((x: any) => x);
    expect(e).toBeInstanceOf(CdpSessionLost); expect(e.reason).toBe("websocket-fechado"); expect(cdp.pending.size).toBe(0);
  });
  it("impede acumulação de comandos pendentes (limite) e a resposta de erro do CDP não é perda de sessão", async () => {
    const ws = new FakeWs(); const cdp = new Cdp(ws, { maxPending: 3 });
    const first = cdp.send("A", {}, 30000).catch((e: any) => e);
    cdp.send("B", {}, 30000).catch(() => {}); cdp.send("C", {}, 30000).catch(() => {});
    const over = await cdp.send("D").catch((e: any) => e);
    expect(over.reason).toBe("pendentes-acumulados"); expect((await first).reason).toBe("pendentes-acumulados");
    const ws2 = new FakeWs(); const ok = new Cdp(ws2); const p = ok.send("X").catch((e: any) => e); ws2.replyError(1, "método inexistente");
    const err = await p; expect(err).not.toBeInstanceOf(CdpSessionLost); expect(String(err.message)).toContain("método inexistente"); expect(ok.consecutiveTimeouts).toBe(0);
  });
  it("mensagem ilegível é ignorada; evento de aba derrubada fica registrado na saúde", () => {
    const ws = new FakeWs(); const cdp = new Cdp(ws);
    ws.onmessage({ data: "{não é json" });
    ws.event("Inspector.targetCrashed", { reason: "oom" });
    expect(cdp.health().alvoCaiu.evento).toBe("Inspector.targetCrashed");
  });
});

describe("Cdp — timeouts, diagnóstico e fail-fast", () => {
  it("timeout isolado (diagnóstico diz que a página responde): vira CdpTimeoutError e a sessão continua; uma resposta zera a sequência", async () => {
    const ws = new FakeWs(); const cdp = new Cdp(ws); cdp.stallProbe = async () => ({ lost: false, kind: "timeout-isolado" });
    const e = await cdp.send("Runtime.evaluate", {}, 20).catch((x: any) => x);
    expect(e).toBeInstanceOf(CdpTimeoutError); expect(e.message).toContain("tempo esgotado (20ms)"); expect(e.verdict.kind).toBe("timeout-isolado");
    expect(cdp.lost).toBeNull(); expect(cdp.consecutiveTimeouts).toBe(1);
    const p = cdp.send("Page.enable"); ws.reply(2); await p;
    expect(cdp.consecutiveTimeouts).toBe(0);
  });
  it("o 1º timeout dispara o diagnóstico; se ele prova a perda, a sessão acaba NA HORA (sem esperar o 2º timeout) e preserva último comando e evidência", async () => {
    const ws = new FakeWs(); const cdp = new Cdp(ws); let probes = 0; let seen: any;
    cdp.stallProbe = async (info: any) => { probes++; seen = info; return { lost: true, kind: "pagina-travada", causa: "aba presa", evidence: { x: 1 } }; };
    const t0 = Date.now(); const e = await cdp.send("Runtime.evaluate", {}, 30).catch((x: any) => x);
    expect(e).toBeInstanceOf(CdpSessionLost); expect(e.reason).toBe("pagina-travada"); expect(e.evidence.evidence.x).toBe(1);
    expect(probes).toBe(1); expect(seen.method).toBe("Runtime.evaluate"); expect(seen.health.ultimoComando.metodo).toBe("Runtime.evaluate");
    expect(Date.now() - t0).toBeLessThan(500);
    expect((await cdp.send("Network.emulateNetworkConditions").catch((x: any) => x))).toBe(e); // os seguintes: recusa imediata
  });
  it("timeouts consecutivos sem resposta no meio encerram a sessão mesmo se o diagnóstico não prova nada (falha no diagnóstico NÃO esconde)", async () => {
    const ws = new FakeWs(); const cdp = new Cdp(ws); cdp.stallProbe = async () => { throw new Error("diagnóstico quebrou"); };
    const e1 = await cdp.send("A", {}, 15).catch((x: any) => x);
    expect(e1).toBeInstanceOf(CdpTimeoutError); expect(e1.verdict.kind).toBe("diagnostico-falhou");
    const e2 = await cdp.send("B", {}, 15).catch((x: any) => x);
    expect(e2).toBeInstanceOf(CdpSessionLost); expect(e2.reason).toBe("timeouts-consecutivos");
  });
  it("diagnóstico que não termina no prazo é abandonado (não vira outro travamento)", async () => {
    const ws = new FakeWs(); const cdp = new Cdp(ws, { probeBudgetMs: 40 }); cdp.stallProbe = () => new Promise(() => {});
    const t0 = Date.now(); const e = await cdp.send("A", {}, 10).catch((x: any) => x);
    expect(e).toBeInstanceOf(CdpTimeoutError); expect(e.verdict.kind).toBe("diagnostico-sem-prazo"); expect(Date.now() - t0).toBeLessThan(1000);
  });
  it("vários comandos expirando juntos compartilham UM diagnóstico", async () => {
    const ws = new FakeWs(); const cdp = new Cdp(ws); let n = 0;
    cdp.stallProbe = async () => { n++; await tick(30); return { lost: true, kind: "chrome-sem-resposta", causa: "x" }; };
    const r = await Promise.all([cdp.send("A", {}, 10).catch((x: any) => x), cdp.send("B", {}, 10).catch((x: any) => x), cdp.send("C", {}, 10).catch((x: any) => x)]);
    expect(n).toBe(1); for (const e of r) expect(e).toBeInstanceOf(CdpSessionLost);
  });
  it("comandos de encerramento (probe:false) não disparam diagnóstico nem contam como sequência", async () => {
    const ws = new FakeWs(); const cdp = new Cdp(ws); let n = 0; cdp.stallProbe = async () => { n++; return { lost: true, kind: "x" }; };
    const e = await cdp.send("Browser.close", {}, 10, { probe: false }).catch((x: any) => x);
    expect(e).toBeInstanceOf(CdpTimeoutError); expect(n).toBe(0); expect(cdp.lost).toBeNull();
  });
});

describe("waitUntil e runner — nada engole a sessão perdida nem fabrica aprovação", () => {
  it("waitUntil propaga erro fatal (sessão CDP perdida) em vez de tratá-lo como 'a página está navegando'", async () => {
    const lost = new CdpSessionLost("pagina-travada", "x");
    await expect(waitUntil(() => { throw lost; }, 5000, { every: 5 })).rejects.toBe(lost);
    let n = 0; // erro comum continua sendo "ainda não"
    expect(await waitUntil(() => { if (++n < 3) throw new Error("navegando"); return "ok"; }, 5000, { every: 5 })).toBe("ok");
  });
  it("runScenarios registra a célula como UNMEASURABLE, conta o progresso e PROPAGA a perda; nenhuma célula seguinte é tentada", async () => {
    const lost = new CdpSessionLost("pagina-travada", "Runtime.evaluate sem resposta");
    let calls = 0; const cdp = { context: {} as any, events: [] as any[], lost: null as any, send: async () => { if (++calls === 1) return {}; throw lost; }, eval: async () => { throw lost; } }; // 1º comando (limpar cookies) passa; a célula perde a sessão
    const sc = SCENARIOS.find((s: any) => s.user === "guest"); const report = new Report(); const progress = new Progress({ total: 99, log: () => {} });
    await expect(runScenarios({ cdp, browserName: "chrome", version: "x", baseUrl: "http://127.0.0.1:1", scenarios: [sc, sc], viewports: [{ w: 375, h: 812 }, { w: 1280, h: 900 }], report, progress })).rejects.toBe(lost);
    expect(report.rows).toHaveLength(1); expect(report.rows[0].status).toBe("UNMEASURABLE"); expect(report.rows[0].detail).toContain("sessão CDP perdida (pagina-travada)");
    expect(progress.snapshot().done).toBe(1); expect(calls).toBeLessThan(5); // parou na 1ª célula
    expect(cdp.context.cell).toContain(sc.id);
  });
  it("perda de sessão = código de saída 3, cobertura incompleta explícita (UNMEASURABLE) e nenhum PASS fabricado", () => {
    const report = new Report();
    report.add({ browser: "chrome", scenario: "a", viewport: "375x812", theme: "light", state: "normal", kind: "text", status: "PASS", target: "t", variant: "v" });
    report.addEnv("sessão CDP do chrome perdida (pagina-travada) após 1 de 4 células");
    const expected = expectedCombos({ browsers: ["chrome"], scenarios: [{ id: "a" }, { id: "b" }], viewports: ["375x812"], themes: ["light", "dark"] });
    const gaps = coverageGaps(report.rows, expected);
    expect(gaps).toHaveLength(3); // 4 esperadas − 1 executada
    for (const k of gaps) { const [browser, scenario, viewport, theme] = k.split("|"); report.add({ browser, scenario, viewport, theme, state: "cobertura", kind: "cobertura", status: "UNMEASURABLE", target: "-", variant: "-" }); }
    expect(report.exitCode()).toBe(EXIT.ENV); expect(report.counts().PASS).toBe(1); expect(report.counts().UNMEASURABLE).toBe(3);
  });
});

describe("chromeprobe — stderr limitado e higienizado, /proc, veredito e diagnóstico que nunca trava", () => {
  it("TailBuffer guarda só o fim, higieniza URL com query/segredo/controle e informa quanto recebeu (falha na captura não derruba nada)", () => {
    const t = new TailBuffer(200);
    for (let i = 0; i < 50; i++) t.push(`linha ${i} sem segredo\n`);
    t.push("erro em https://x.test/a/b?token=abc123&u=1#frag Authorization: Bearer abc.def.ghi password=hunter2 \u0007fim\n");
    const out = t.text().join("\n");
    expect(out).toContain("https://x.test/a/b"); expect(out).not.toMatch(/token=|abc123|hunter2|abc\.def|\u0007/);
    expect(t.info().bytesRecebidos).toBeGreaterThan(200); expect(t.info().retidos).toBeLessThanOrEqual(200);
    expect(new TailBuffer().text()).toEqual([]); expect(() => new TailBuffer().push(undefined)).not.toThrow();
  });
  it("parseStat entende nome com espaços/parênteses; descendants e cpuBetween fazem a conta", () => {
    const st = parseStat("123 (Web Content (x)) S 100 1 1 0 -1 0 0 0 0 0 250 50 0 0 20 0 1 0 1 1 1");
    expect(st).toMatchObject({ pid: 123, comm: "Web Content (x)", state: "S", ppid: 100, ticks: 300 });
    expect(parseStat("lixo")).toBeNull();
    const procs = new Map([[1, { pid: 1, ppid: 0 }], [2, { pid: 2, ppid: 1 }], [3, { pid: 3, ppid: 2 }], [9, { pid: 9, ppid: 0 }]]);
    expect(descendants(procs, 1).map((p: any) => p.pid).sort()).toEqual([1, 2, 3]);
    const a = [{ pid: 2, type: "renderer", state: "R", ticks: 100, rssKb: 40960 }]; const b = [{ pid: 2, type: "renderer", state: "R", ticks: 200, rssKb: 40960 }, { pid: 7, type: "gpu", state: "S", ticks: 5, rssKb: null }];
    expect(cpuBetween(a, b, 1000)).toEqual([{ pid: 2, type: "renderer", state: "R", rssMb: 40, cpuPct: 100 }, { pid: 7, type: "gpu", state: "S", rssMb: null, cpuPct: null }]);
  });
  it("procSnapshot lê /proc por um leitor injetado e ignora processo que sumiu", () => {
    const files: Record<string, string> = { "/proc/10/stat": "10 (chrome) S 1 1 1 0 -1 0 0 0 0 0 10 5 0 0 20 0 1 0 1 1 1", "/proc/10/statm": "1 2560 0", "/proc/10/cmdline": "chrome\0--headless\0", "/proc/11/stat": "11 (chrome) R 10 1 1 0 -1 0 0 0 0 0 900 100 0 0 20 0 1 0 1 1 1", "/proc/11/statm": "1 5120 0", "/proc/11/cmdline": "chrome\0--type=renderer\0" };
    const fsx = { readdirSync: () => ["10", "11", "12", "self"], readFileSync: (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; } };
    const snap = procSnapshot(10, fsx); expect(snap.map((p: any) => [p.pid, p.type, p.ticks, p.rssKb])).toEqual(expect.arrayContaining([[10, "browser", 15, 10240], [11, "renderer", 1000, 20480]]));
  });
  it("classifyStall: cada situação tem seu veredito; só 'lost' quando há prova", () => {
    const ok = { ok: true }, bad = { ok: false };
    expect(classifyStall({ process: { alive: false } })).toMatchObject({ lost: true, kind: "chrome-encerrado" });
    expect(classifyStall({ process: { alive: true }, browserHttp: bad, browserWs: bad })).toMatchObject({ lost: true, kind: "chrome-sem-resposta" });
    expect(classifyStall({ process: { alive: true }, browserHttp: ok, browserWs: ok, pageSecondConn: ok })).toMatchObject({ lost: false, kind: "timeout-isolado" });
    const stuck = { process: { alive: true }, browserHttp: ok, browserWs: { ok: true, processos: [{ tipo: "renderer", cpuPct: 99 }] }, pageSecondConn: bad, freshTarget: ok };
    expect(classifyStall({ ...stuck, stack: { web: ok, api: ok } })).toMatchObject({ lost: true, kind: "pagina-travada", rendererOcupado: true, stackDown: false });
    expect(classifyStall({ ...stuck, stack: { web: ok, api: bad } })).toMatchObject({ lost: true, kind: "pagina-travada-pilha-indisponivel", stackDown: true });
    expect(classifyStall({ ...stuck, freshTarget: bad })).toMatchObject({ lost: true, kind: "navegador-degradado" });
    expect(classifyStall({})).toMatchObject({ lost: false, kind: "inconclusivo" });
  });
  it("step respeita o prazo e nunca lança", async () => {
    expect((await step(20, () => new Promise(() => {}))).ok).toBe(false);
    expect((await step(50, () => { throw new Error("x"); })).error).toContain("x");
    expect(await step(50, async () => 7)).toMatchObject({ ok: true, value: 7 });
  });
  it("diagnoseChrome: processo inexistente → chrome-encerrado, mesmo com tudo o mais falhando (dependências que lançam ou nunca respondem)", async () => {
    const dead = spawn(process.execPath, ["-e", ""]); await new Promise((r) => dead.on("exit", r)); // pid de um processo que já saiu
    const never = () => new Promise(() => {});
    const t0 = Date.now();
    const v = await diagnoseChrome({ child: { pid: dead.pid, exitCode: 0, signalCode: null }, port: 1, stderr: new TailBuffer(), stackUrls: { web: "http://127.0.0.1:1/x", api: "http://127.0.0.1:1/y" }, cdpHealth: { pendentes: 0 }, cell: "c @1x1 light", fetchImpl: never, WS: function () { throw new Error("sem ws"); }, makeCdp: () => { throw new Error("x"); }, platform: "linux", snapshotFn: () => { throw new Error("sem /proc"); }, stepMs: 60, budgetMs: 800 });
    expect(v).toMatchObject({ lost: true, kind: "chrome-encerrado" }); expect(v.evidence.celula).toBe("c @1x1 light"); expect(v.evidence.process.alive).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000); // prazo do conjunto respeitado
  });
  it("diagnoseChrome com endpoint do navegador respondendo mas página muda e aba nova funcionando → pagina-travada; stderr e saúde do CDP entram na evidência", async () => {
    const stderr = new TailBuffer(); stderr.push("[1:2:ERROR] algo https://a.test/p?s=segredo\n");
    const fetchImpl = async (url: string) => ({ status: 200, json: async () => (url.endsWith("/json/version") ? { Browser: "Chrome/1", webSocketDebuggerUrl: "ws://fake/browser" } : [{ type: "page", url: "http://127.0.0.1:1/p?x=1", title: "t", webSocketDebuggerUrl: "ws://fake/page" }]) });
    // WS falso: o alvo "page" nunca responde; o "browser" e a aba nova respondem
    const answers: Record<string, any> = { "SystemInfo.getProcessInfo": { processInfo: [{ type: "renderer", id: 5, cpuTime: 1 }] }, "Target.getTargets": { targetInfos: [{}, {}] }, "Target.createTarget": { targetId: "T1" }, "Target.closeTarget": {} };
    class W { url: string; onopen: any; onmessage: any; onclose: any; onerror: any; readyState = 1; constructor(url: string) { this.url = url; setTimeout(() => this.onopen?.(), 1); } send(d: string) { const m = JSON.parse(d); if (this.url.includes("/page") && !this.url.includes("devtools")) return; /* página presa */ const r = m.method === "Runtime.evaluate" ? { result: { value: 2 } } : answers[m.method]; setTimeout(() => this.onmessage({ data: JSON.stringify({ id: m.id, result: r ?? {} }) }), 1); } close() {} }
    const v = await diagnoseChrome({ child: { pid: process.pid, exitCode: null, signalCode: null }, port: 9, stderr, stackUrls: undefined, cdpHealth: { comando: "Runtime.evaluate" }, cell: "x", fetchImpl, WS: W, makeCdp: (ws: any) => new Cdp(ws, { maxConsecutiveTimeouts: Infinity }), platform: "win32", stepMs: 150, budgetMs: 6000 });
    expect(v).toMatchObject({ lost: true, kind: "pagina-travada", rendererOcupado: false });
    expect(v.evidence.freshTarget.ok).toBe(true); expect(v.evidence.pageSecondConn.ok).toBe(false);
    expect(JSON.stringify(v.evidence)).not.toContain("segredo"); expect(JSON.stringify(v.evidence)).not.toContain("x=1"); expect(v.evidence.cdp.comando).toBe("Runtime.evaluate");
  });
});

describe("término do renderizador (causa observada na execução remota 44004874634)", () => {
  it("Inspector.detached ('Render process gone.') encerra a sessão NA HORA, rejeita os pendentes com a causa nomeada e recusa os próximos sem esperar timeout", async () => {
    const ws = new FakeWs(); const cdp = new Cdp(ws);
    const p = cdp.send("Runtime.evaluate", {}, 30000).catch((e: any) => e);
    const t0 = Date.now(); ws.event("Inspector.detached", { reason: "Render process gone." });
    const e = await p;
    expect(e).toBeInstanceOf(CdpSessionLost); expect(e.reason).toBe("renderizador-encerrado"); expect(e.detail).toContain("Render process gone."); expect(Date.now() - t0).toBeLessThan(100);
    expect(cdp.health().alvoCaiu).toMatchObject({ evento: "Inspector.detached", motivo: "Render process gone." });
    expect(await cdp.send("Network.enable").catch((x: any) => x)).toBe(e);
  });
  it("Inspector.targetCrashed também; o veredito nomeia o término do renderizador e diferencia com/sem despejo de falha", () => {
    const ws = new FakeWs(); const cdp = new Cdp(ws); ws.event("Inspector.targetCrashed", {});
    expect(cdp.lost?.reason).toBe("renderizador-encerrado");
    const base = { process: { alive: true }, browserHttp: { ok: true }, browserWs: { ok: true }, pageSecondConn: { ok: false }, freshTarget: { ok: true }, cdp: { alvoCaiu: { evento: "Inspector.detached", motivo: "Render process gone." } }, stack: { web: { ok: true }, api: { ok: true } } };
    const semDump = classifyStall({ ...base, crashDumps: [] }); expect(semDump).toMatchObject({ lost: true, kind: "renderizador-encerrado" }); expect(semDump.causa).toContain("nenhum despejo"); expect(semDump.causa).toContain("não prova");
    const comDump = classifyStall({ ...base, crashDumps: ["abc.dmp"] }); expect(comDump.causa).toContain("FALHOU");
    expect(classifyStall({ ...base, process: { alive: false } }).kind).toBe("chrome-encerrado"); // processo do navegador morto continua tendo prioridade
  });
  it("dmesgTail devolve só linhas relevantes e higienizadas; sem permissão, só o motivo (nunca lança)", async () => {
    const ok = await dmesgTail((cb: any) => cb(null, "[x] foo\n[y] Out of memory: Killed process 4559 (chrome) total-vm:1kB token=abc\n[z] bar\n"));
    expect(ok.linhas).toHaveLength(1); expect(ok.linhas[0]).toContain("Killed process 4559"); expect(ok.linhas[0]).not.toContain("abc");
    expect(await dmesgTail((cb: any) => cb(new Error("dmesg: read kernel buffer failed: Operation not permitted")))).toEqual({ indisponivel: expect.stringContaining("not permitted") });
  });
});

describe("batimento de saúde e mudança de serviços do Chrome", () => {
  it("processChanges ignora renderizadores (nascem e morrem) e acusa serviço de rede/GPU que sumiu ou foi recriado", () => {
    const base = [{ pid: 1, type: "browser" }, { pid: 2, type: "gpu-process" }, { pid: 3, type: "utility:network.mojom.NetworkService" }, { pid: 4, type: "renderer" }];
    const now = [{ pid: 1, type: "browser" }, { pid: 2, type: "gpu-process" }, { pid: 30, type: "utility:network.mojom.NetworkService" }, { pid: 40, type: "renderer" }];
    expect(processChanges(base, now)).toEqual({ surgiram: [{ pid: 30, type: "utility:network.mojom.NetworkService" }], sumiram: [{ pid: 3, type: "utility:network.mojom.NetworkService" }] });
    expect(processChanges(base, base)).toEqual({ surgiram: [], sumiram: [] });
  });
  it("quickHealth nunca lança (pilha fora do ar, /proc ilegível), traz só números e a linha impressa avisa serviços alterados", async () => {
    const fetchImpl = async (url: string) => { if (url.includes("api")) throw new Error("ECONNREFUSED"); return { status: 200 }; };
    const h = await quickHealth({ child: { pid: process.pid }, stackUrls: { web: "http://w/login", api: "http://a/_api/__health" }, baseline: [{ pid: 3, type: "utility:network.mojom.NetworkService" }], platform: "linux", fetchImpl, snapshotFn: () => [{ pid: 9, type: "browser", rssKb: 2048 }, { pid: 30, type: "utility:network.mojom.NetworkService", rssKb: 1024 }, { pid: 31, type: "renderer", rssKb: 1024 }] });
    expect(h).toMatchObject({ chromeVivo: true, web: { status: 200 }, processos: 3, renderizadores: 1, chromeRssMb: 4 }); expect(h.api.erro).toContain("ECONNREFUSED");
    const line = healthLine(h); expect(line).toContain("SERVIÇOS ALTERADOS"); expect(line).toContain("api ERRO"); expect(line).not.toMatch(/token|senha|cookie/i);
    const bad = await quickHealth({ child: { pid: process.pid }, platform: "linux", snapshotFn: () => { throw new Error("sem /proc"); } });
    expect(bad.chromeVivo).toBe(true); expect(bad.processos).toBeUndefined();
    expect(healthLine({ ...bad, carga: [0, 0, 0], livreMb: 1, harnessRssMb: 1, chromeVivo: false })).toContain("MORTO");
  });
  it("startHeartbeat não sobrepõe leituras, não segura o processo e engole falhas da leitura", async () => {
    let fire: any; let unrefd = false; let cleared = false; const beats: any[] = []; let running = 0; let maxRunning = 0;
    const hb = startHeartbeat({ everyMs: 1, collect: async () => { running++; maxRunning = Math.max(maxRunning, running); await tick(15); running--; if (beats.length === 1) throw new Error("falhou"); return { n: beats.length }; }, onBeat: (h: any) => beats.push(h), setTimer: (f: any) => { fire = f; return { unref() { unrefd = true; } }; }, clearTimer: () => { cleared = true; } });
    fire(); fire(); fire(); await tick(60); fire(); await tick(40); // 2º e 3º disparos caem durante a leitura em curso
    expect(maxRunning).toBe(1); expect(unrefd).toBe(true); expect(beats.length).toBeGreaterThanOrEqual(1);
    hb.stop(); expect(cleared).toBe(true);
  });
});

describe("limpeza e integração do arquivo (estático)", () => {
  it("o navegador é encerrado só por propriedade (killTree) e o stderr é sempre drenado; o diagnóstico não usa a sessão presa", async () => {
    const { readFileSync } = await import("node:fs");
    const b = readFileSync("scripts/qa-visual/lib/browser.mjs", "utf8"); const p = readFileSync("scripts/qa-visual/lib/chromeprobe.mjs", "utf8");
    expect(b).toContain('stdio: ["ignore", "ignore", "pipe"]'); expect(b).toContain('child.stderr.on("data"'); expect(b).toContain("killTree(child)");
    expect(b).not.toMatch(/(spawn|exec)\w*\(["'`](taskkill|pkill|killall)/); expect(p).not.toMatch(/(spawn|exec)\w*\(["'`](taskkill|pkill|killall)|process\.kill\([^,)]+,\s*["']SIG/); // process.kill(pid, 0) é só sondagem de existência
    expect(p).toContain("process.kill(pid, 0)");
  });
  it("o gancho de falha simulada (aba presa) só liga por variável de ambiente explícita e o relatório da perda de sessão sai com código ENV", async () => {
    const { readFileSync } = await import("node:fs");
    const r = readFileSync("scripts/qa-visual/run.mjs", "utf8");
    expect(r).toContain('process.env.QA_VISUAL_FAULT === "hang-page-regularization"');
    expect(r).toContain("report.addEnv(`sessão CDP do ${browserName} perdida"); // ENV → código 3 (Report.exitCode)
    expect(r).toContain("catch (e) { if (!(e instanceof CdpSessionLost)) throw e; await reportSessionLost(");
    const wf = readFileSync(".github/workflows/ci.yml", "utf8"); expect(wf).not.toContain("QA_VISUAL_FAULT"); // o CI nunca liga ganchos de falha
  });
  it("a matriz continua com 568 células no perfil ci, e o relatório não inventa aprovação (contagem a partir das linhas reais)", async () => {
    // @ts-expect-error mjs
    const { CI_PROFILE_IDS, THEMES } = await import("../scripts/qa-visual/scenarios.mjs");
    // @ts-expect-error mjs
    const { VIEWPORTS } = await import("../scripts/qa-visual/lib/viewport.mjs");
    // @ts-expect-error mjs
    const { countCells } = await import("../scripts/qa-visual/lib/progress.mjs");
    expect(countCells(SCENARIOS.filter((s: any) => CI_PROFILE_IDS.includes(s.id)), VIEWPORTS, THEMES, 1)).toBe(568);
  });
});

// ---- experimento real, opt-in (Chrome de verdade, aba presa por laço infinito) ----
const REAL = process.env.QA_CDP_REAL_BROWSER === "1";
describe.skipIf(!REAL)("experimento real: aba presa por laço infinito (QA_CDP_REAL_BROWSER=1)", () => {
  it("falha rápido (≪ 30 s por comando), classifica pagina-travada com CPU do renderizador, recusa o seguinte e encerra o Chrome sem deixar processo", () => {
    const exe = findBrowser("chrome"); expect(exe && existsSync(exe)).toBeTruthy();
    const r = spawnSync(process.execPath, ["scripts/qa-visual/experiments/hung-page.mjs", "--timeout-ms", "3000"], { encoding: "utf8", timeout: 90000 });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.primeiroErro.reason).toBe("pagina-travada"); expect(out.primeiroErro.msAteErro).toBeLessThan(15000);
    expect(out.segundoComando.msParaRecusar).toBeLessThan(100); expect(out.veredito.lost).toBe(true);
    expect(out.processoEncerradoAposClose).toBe(true);
  }, 100000);
  it("Page.crash (renderizador derrubado pelo próprio CDP): a perda sai em < 5 s, pelo evento, com a causa nomeada", () => {
    const r = spawnSync(process.execPath, ["scripts/qa-visual/experiments/crashed-page.mjs"], { encoding: "utf8", timeout: 90000 });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.pendente.reason).toBe("renderizador-encerrado"); expect(out.pendente.msAteErro).toBeLessThan(5000); expect(out.seguinte.msParaRecusar).toBeLessThan(100);
    expect(out.veredito.kind).toBe("renderizador-encerrado"); expect(out.processoEncerradoAposClose).toBe(true);
  }, 100000);
});
