/**
 * M08–M10 — testes UNITÁRIOS dos MECANISMOS de captura do QA visual (PR A: infraestrutura): passos do executor (setFile/dragFile/holdRequest/fulfillHeld/…), portão de estabilidade com requisição
 * esperada, asserções funcionais (texto, elementos, evalTrue), sondas de geometria/interação e a interceptação de terceiros (D6 do autoteste). Sem navegador e sem banco; independente das
 * matrizes da dropzone (essas ficam em test/qaVisualDropzone.test.ts, PR B). QA_VISUAL_ROOT (opcional) aponta para uma cópia sabotada.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.env.QA_VISUAL_ROOT ?? path.resolve(__dirname, "../scripts/qa-visual");
const load = (rel: string) => import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href);
const runner = await load("lib/runner.mjs");
const cap = await load("lib/capture.mjs");
const pr = await load("lib/probes.mjs");
const pngm = await load("lib/png.mjs");

const KNOWN_STEPS = ["click", "setFile", "select", "type", "waitFor", "scrollEnd", "network", "block", "dragFile", "holdRequest", "fulfillHeld", "releaseHold"];


describe("passos novos do executor (M08/M09)", () => {
  const made: string[] = []; afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); }); // só os diretórios criados por ESTE teste
  const mk = () => { const calls: any[] = []; const evals: string[] = []; const filesDir = mkdtempSync(path.join(tmpdir(), "levora-qa-test-dropzone-")); made.push(filesDir);
    const cdp = { async send(method: string, params: any) { calls.push([method, params]); if (method === "DOM.getDocument") return { root: { nodeId: 1 } }; if (method === "DOM.querySelector") return { nodeId: 2 }; return {}; }, async eval(expr: string) { evals.push(expr); if (/scrollHeight/.test(expr)) return 2; return true; } };
    return { ctx: { cdp, filesDir, report: { rows: [] as any[], add(r: any) { this.rows.push(r); } } } as any, calls, evals, filesDir }; };
  const sc = { id: "t", path: "/x", target: { css: "x" }, variant: "v" };
  it("setFile com contentBase64 grava os BYTES reais (PNG) e envia ao <input type=file>", async () => {
    const { ctx, calls, filesDir } = mk(); try {
      const ok = await runner.runStep(ctx, sc, { setFile: { css: 'input[type="file"]', within: '[role="dialog"]', fileName: "a.png", contentBase64: "iVBORw0KGgo=" } });
      expect(ok).toBe(true); expect(readFileSync(path.join(filesDir, "a.png")).subarray(0, 4).toString("hex")).toBe("89504e47"); expect(calls.some((c) => c[0] === "DOM.setFileInputFiles")).toBe(true);
    } finally { rmSync(filesDir, { recursive: true, force: true }); }
  });
  it("setFile com padBytes grava um arquivo sintético com exatamente N bytes", async () => {
    const { ctx, filesDir } = mk(); try {
      await runner.runStep(ctx, sc, { setFile: { css: 'input[type="file"]', fileName: "g.png", padBytes: 12345 } });
      expect(statSync(path.join(filesDir, "g.png")).size).toBe(12345);
    } finally { rmSync(filesDir, { recursive: true, force: true }); }
  });
  it("scrollEnd rola todo contêiner rolável do diálogo ao fim; network emula latência; block define as URLs bloqueadas; waitFor espera o elemento", async () => {
    const { ctx, calls, evals } = mk();
    expect(await runner.runStep(ctx, sc, { scrollEnd: { css: '[role="dialog"]' } })).toBe(true); expect(evals.some((e) => /scrollTop = e\.scrollHeight/.test(e))).toBe(true);
    expect(await runner.runStep(ctx, sc, { network: { latencyMs: 5000 } })).toBe(true); expect(calls.find((c) => c[0] === "Network.emulateNetworkConditions")[1]).toMatchObject({ offline: false, latency: 5000 });
    expect(await runner.runStep(ctx, sc, { block: ["*files-upload*"] })).toBe(true); expect(calls.find((c) => c[0] === "Network.setBlockedURLs")[1]).toEqual({ urls: ["*files-upload*"] });
    expect(await runner.runStep(ctx, sc, { waitFor: { css: "[role=alert]" } })).toBe(true);
  });
  it("M09 dragFile: usa o arrasto REAL do navegador (Input.dispatchDragEvent: dragEnter + dragOver; drop só quando pedido; leave = dragCancel) com o arquivo sintético no disco", async () => {
    const { ctx, calls, filesDir } = mk(); try {
      ctx.cdp.eval = async (e: string) => (/getBoundingClientRect/.test(e) ? "[100,200]" : true);
      expect(await runner.runStep(ctx, sc, { dragFile: { css: "label", fileName: "d.png", contentBase64: "iVBORw0KGgo=", phase: "enter" } })).toBe(true);
      const t = calls.filter((c) => c[0] === "Input.dispatchDragEvent").map((c) => c[1].type); expect(t).toEqual(["dragEnter", "dragOver"]);
      expect(calls.find((c) => c[0] === "Input.dispatchDragEvent")[1].data.files).toEqual([path.join(filesDir, "d.png")]); expect(readFileSync(path.join(filesDir, "d.png")).subarray(0, 4).toString("hex")).toBe("89504e47");
      calls.length = 0; await runner.runStep(ctx, sc, { dragFile: { css: "label", fileName: "d.png", contentBase64: "iVBORw0KGgo=", phase: "drop" } });
      expect(calls.filter((c) => c[0] === "Input.dispatchDragEvent").map((c) => c[1].type)).toEqual(["dragEnter", "dragOver", "drop"]);
      calls.length = 0; await runner.runStep(ctx, sc, { dragFile: { css: "label", fileName: "d.png", contentBase64: "iVBORw0KGgo=", phase: "leave" } });
      expect(calls.filter((c) => c[0] === "Input.dispatchDragEvent").map((c) => c[1].type)).toEqual(["dragOver", "dragCancel"]);
    } finally { rmSync(filesDir, { recursive: true, force: true }); }
  });
  it("M09 fulfillHeld: responde a requisição SEGURADA com o HTTP de teste (fulfillRequest, corpo em base64) e não a repete; sem requisição segurada NÃO é medido", async () => {
    const { ctx, calls } = mk();
    ctx.cdp.events = [{ method: "Fetch.requestPaused", params: { requestId: "i-1", networkId: "n1" } }];
    expect(await runner.runStep(ctx, sc, { fulfillHeld: { status: 500, body: "{\"json\":{\"message\":\"x\"}}" } })).toBe(true);
    const f = calls.filter((c) => c[0] === "Fetch.fulfillRequest"); expect(f).toHaveLength(1);
    expect(f[0][1]).toMatchObject({ requestId: "i-1", responseCode: 500 }); expect(Buffer.from(f[0][1].body, "base64").toString()).toContain("message");
    expect(calls.some((c) => c[0] === "Fetch.continueRequest")).toBe(false);
  });
  it("M09 releaseHold: desliga a interceptação (volta ao backend real)", async () => {
    const { ctx, calls } = mk(); expect(await runner.runStep(ctx, sc, { releaseHold: true })).toBe(true); expect(calls.some((c) => c[0] === "Fetch.disable")).toBe(true);
  });
  it("M09 holdRequest: liga a interceptação SÓ para o padrão pedido, no estágio da requisição (a requisição não chega ao servidor)", async () => {
    const { ctx, calls } = mk();
    expect(await runner.runStep(ctx, sc, { holdRequest: { urlPattern: "*files-upload*" } })).toBe(true);
    expect(calls.find((c) => c[0] === "Fetch.enable")[1]).toEqual({ patterns: [{ urlPattern: "*files-upload*", requestStage: "Request" }] });
  });
  it("passo desconhecido continua NÃO medido (não vira sucesso silencioso)", async () => {
    const { ctx } = mk(); expect(await runner.runStep(ctx, sc, { inventado: true })).toBe(false); expect(ctx.report.rows[0].status).toBe("UNMEASURABLE"); expect(ctx.report.rows[0].detail).toMatch(/passo desconhecido/);
  });
  it("a rede é reposta (latência 0, sem bloqueio) no início de TODA célula, tanto no runner funcional quanto na captura visual", () => {
    for (const f of ["lib/runner.mjs", "lib/capture.mjs"]) expect(readFileSync(path.join(ROOT, f), "utf8")).toMatch(/emulateNetworkConditions", \{ offline: false, latency: 0/);
  });
});

// ---- M09: portão de estabilidade — só a requisição de envio IDENTIFICADA e comprovadamente SEGURADA é tolerada ----
describe("portão de estabilidade com requisição esperada (R5 'enviando')", () => {
  const EXP = { urlIncludes: "files-upload", method: "POST" };
  const sent = (id: string, url: string, method = "POST") => ({ method: "Network.requestWillBeSent", params: { requestId: id, request: { url, method } } });
  const paused = (id: string) => ({ method: "Fetch.requestPaused", params: { requestId: "i-" + id, networkId: id } });
  const done = (id: string) => ({ method: "Network.loadingFinished", params: { requestId: id } });
  it("sem expectativa o portão é o ESTRITO de sempre: qualquer pendente conta", () => {
    expect(cap.pendingRequests([sent("1", "http://x/_api/v1/files-upload")])).toBe(1);
    expect(cap.pendingRequests([])).toBe(0);
  });
  it("com expectativa: o envio segurado (Fetch.requestPaused) não conta; o resto conta", () => {
    const ev = [sent("1", "http://x/_api/v1/files-upload"), paused("1")];
    expect(cap.pendingRequests(ev, EXP)).toBe(0); expect(cap.heldRequests(ev, EXP)).toHaveLength(1);
  });
  it("o mesmo padrão de URL SEM estar segurado continua reprovando (não basta casar a URL)", () => {
    const ev = [sent("1", "http://x/_api/v1/files-upload")];
    expect(cap.pendingRequests(ev, EXP)).toBe(1); expect(cap.heldRequests(ev, EXP)).toHaveLength(0);
  });
  it("outra requisição pendente junto do envio segurado reprova (a tolerância não é indiscriminada)", () => {
    const ev = [sent("1", "http://x/_api/v1/files-upload"), paused("1"), sent("2", "http://x/_api/v1/inventory-list", "GET")];
    expect(cap.pendingRequests(ev, EXP)).toBe(1);
  });
  it("método diferente (GET no mesmo caminho) não é o envio esperado", () => {
    const ev = [sent("1", "http://x/_api/v1/files-upload", "GET"), paused("1")];
    expect(cap.pendingRequests(ev, EXP)).toBe(1); expect(cap.heldRequests(ev, EXP)).toHaveLength(0);
  });
  it("requisição que terminou deixa de contar e deixa de estar 'segurada' (sem estado enviando comprovado)", () => {
    const ev = [sent("1", "http://x/_api/v1/files-upload"), paused("1"), done("1")];
    expect(cap.pendingRequests(ev, EXP)).toBe(0); expect(cap.heldRequests(ev, EXP)).toHaveLength(0);
  });
});

// ---- M09: asserções funcionais (um estado funcionalmente errado NUNCA vira "sucesso visual") e garantias estáticas do mecanismo "enviando" ----
describe("asserções funcionais da captura (R9) e garantias do estado 'enviando'", () => {
  const mkCdp = (text: string, present: string[] = []) => ({ async eval(e: string) { if (e.includes("innerText")) return text; const k = e.indexOf("querySelector(") + 14; return present.includes(JSON.parse(e.slice(k, e.lastIndexOf(")")))); } });
  it("texto esperado presente e nenhum texto proibido: ok", async () => {
    const r = await cap.checkAssertions(mkCdp("O arquivo excede o limite de 8 MB."), { includes: ["O arquivo excede o limite de 8 MB."], excludes: ["File size exceeds"] });
    expect(r.ok).toBe(true); expect(r.record.ok).toBe(true);
  });
  it("INGLÊS RESIDUAL reprova (texto proibido presente) — mesmo com o texto em português também na tela", async () => {
    const r = await cap.checkAssertions(mkCdp("O arquivo excede o limite de 8 MB. File size exceeds 8MB limit"), { includes: ["O arquivo excede o limite de 8 MB."], excludes: ["File size exceeds"] });
    expect(r.ok).toBe(false); expect(r.detail).toContain('proibido presente: ["File size exceeds"]');
  });
  it("texto esperado AUSENTE reprova (a tela mostra outra coisa)", async () => {
    const r = await cap.checkAssertions(mkCdp("Failed to fetch"), { includes: ["Não foi possível enviar o arquivo. Verifique sua conexão e tente novamente."], excludes: ["Failed to fetch"] });
    expect(r.ok).toBe(false); expect(r.detail).toMatch(/texto ausente/); expect(r.detail).toMatch(/Failed to fetch/);
  });
  it("SÓ o texto esperado ausente (nada proibido na tela) já reprova", async () => {
    const r = await cap.checkAssertions(mkCdp("tela com outro texto"), { includes: ["Não foi possível concluir o envio. Tente novamente mais tarde."] });
    expect(r.ok).toBe(false); expect(r.detail).toContain("texto ausente: [\"Não foi possível concluir o envio");
    expect((await cap.checkAssertions(mkCdp("Não foi possível concluir o envio. Tente novamente mais tarde."), { includes: ["Não foi possível concluir o envio. Tente novamente mais tarde."] })).ok).toBe(true);
  });
  it("proibição é sem diferença de caixa e aceita expressão regular (ex.: 'Maximum [0-9]+ file')", async () => {
    expect((await cap.checkAssertions(mkCdp("maximum 3 files allowed"), { excludes: ["Maximum [0-9]+ file"] })).ok).toBe(false);
    expect((await cap.checkAssertions(mkCdp("Selecione no máximo 3 arquivos."), { excludes: ["Maximum [0-9]+ file"] })).ok).toBe(true);
  });
  it("elemento exigido ausente e elemento proibido presente reprovam", async () => {
    expect((await cap.checkAssertions(mkCdp("x", []), { present: ['[role="alert"]'] })).ok).toBe(false);
    expect((await cap.checkAssertions(mkCdp("x", ['[role="alert"]']), { absent: ['[role="alert"]'] })).ok).toBe(false);
    expect((await cap.checkAssertions(mkCdp("x", ['[role="alert"]']), { present: ['[role="alert"]'] })).ok).toBe(true);
  });
  it("a captura trata asserção reprovada como FUNCTIONAL_FAIL (sem imagem), DEPOIS do portão de estabilidade, e exige a requisição segurada no 'enviando'", () => {
    const src = readFileSync(path.join(ROOT, "lib/capture.mjs"), "utf8");
    expect(src).toContain("checkAssertions(cdp, page.assert)"); expect(src).toContain('stop(CAPTURE.FUNCTIONAL_FAIL, "assertion-failed"');
    expect(src.indexOf('if (!settled) return stop(')).toBeGreaterThan(-1); expect(src.indexOf('if (!settled) return stop(')).toBeLessThan(src.indexOf("checkAssertions(cdp, page.assert)"));
    expect(src).toContain("held >= 1"); // sem a requisição segurada o estado "enviando" não está provado
    expect(src).toContain("await releaseHeld(cdp)"); // a interceptação é desligada e a requisição abortada ao fim de TODA célula
    expect(src).toContain("Fetch.failRequest"); expect(src).toContain('errorReason: "Aborted"'); // nunca "continua" a requisição segurada (nada é enviado ao servidor)
    expect(src).not.toContain("Fetch.continueRequest");
  });
  it("o portão ESTRITO continua valendo para as demais páginas: sem expectPending a captura usa a contagem total de pendentes", () => {
    const src = readFileSync(path.join(ROOT, "lib/capture.mjs"), "utf8");
    expect(src).toContain("pendingRequests(cdp.events, cfg.expectPending)"); expect(src).toContain("if (!expect) return open.size");
  });
  it("a interceptação só é ligada por passo explícito e para o padrão pedido (nenhuma outra requisição é segurada)", () => {
    const src = readFileSync(path.join(ROOT, "lib/runner.mjs"), "utf8");
    expect(src).toContain('requestStage: "Request"');
    expect(src.split('send("Fetch.enable"').length - 1).toBe(1);
  });
});

describe("sondas e condições da página — mecanismos (R10/R12)", () => {
  it("evalTrue: condição verdadeira aprova; falsa REPROVA e nomeia a condição; exceção na condição = falsa (nunca aprovada)", async () => {
    const cdp = (v: any) => ({ async eval(e: string) { if (e.includes("innerText")) return "ok"; if (v === "throw") throw new Error("x"); return v; } });
    expect((await cap.checkAssertions(cdp(true), { evalTrue: [{ name: "c1", js: "1" }] })).ok).toBe(true);
    const f = await cap.checkAssertions(cdp(false), { evalTrue: [{ name: "toast cobre botão", js: "0" }] }); expect(f.ok).toBe(false); expect(f.detail).toContain("toast cobre botão");
    expect((await cap.checkAssertions(cdp("throw"), { evalTrue: [{ name: "c3", js: "1" }] })).ok).toBe(false);
  });
  it("runProbe: sonda desconhecida vira registro de erro; amostras repetidas registram se a geometria variou", async () => {
    expect((await pr.runProbe({ eval: async () => "{}" }, "inexistente")).erro).toContain("desconhecida");
    let k = 0; const r = await pr.runProbe({ eval: async () => JSON.stringify({ t: ++k, a: 1 }) }, "dropzone", { n: 3, gapMs: 1 }); expect(r.amostras).toHaveLength(3); expect(r.geometriaEstavelEntreAmostras).toBe(true); // só o tempo difere
    let j = 0; const v = await pr.runProbe({ eval: async () => JSON.stringify({ t: 1, a: ++j }) }, "dropzone", { n: 3, gapMs: 1 }); expect(v.geometriaEstavelEntreAmostras).toBe(false); // a geometria variou
  });
  it("sonda de interação: clique REAL no botão (CDP) com ouvinte que cancela o evento; relata se o toast interceptou", async () => {
    const calls: string[] = []; let clicks: any[] = [];
    const cdp: any = { async eval(e: string) {
        if (e.includes("buttonLabel")) return JSON.stringify({ button: { x: 200, y: 740, inView: true }, toast: { x: 180, y: 650, inView: true }, buttonLabel: "Confirmar recebimento" });
        if (e.includes("__qaClickHandler = ")) { calls.push("instala"); return undefined; }
        if (e.includes("JSON.stringify(window.__qaClicks)")) return JSON.stringify(clicks);
        if (e.includes("removeEventListener")) { calls.push("remove"); return "[]"; } return undefined; },
      async click(x: number, y: number) { calls.push("click:" + x + "," + y); clicks = y === 740 ? [{ tag: "button", label: "Confirmar", insideToast: false, insideFooter: true, isButton: true }] : [...clicks, { tag: "form", label: "", insideToast: false, insideFooter: false, isButton: false }]; },
      async mouseMove() { calls.push("move"); } };
    const installed: string[] = []; const cdp0 = { ...cdp, async eval(e: string) { if (e.includes("__qaClickHandler = ")) installed.push(e); return cdp.eval(e); } };
    const r = await pr.runInteractionProbe(cdp0); expect(installed[0]).toContain("e.preventDefault()"); expect(installed[0]).toContain("e.stopPropagation()"); expect(installed[0]).toContain("addEventListener('click', window.__qaClickHandler, true)"); // fase de captura + cancela: nenhuma ação do produto dispara
    expect(r.botao.recebidoPeloBotao).toBe(true); expect(r.botao.interceptadoPeloToast).toBe(false); expect(r.toast.cliqueNoToast.tag).toBe("form");
    expect(calls[0]).toBe("instala"); expect(calls).toContain("remove"); expect(calls[calls.length - 1]).toBe("move");
    clicks = []; const cdp2 = { ...cdp, async click() { clicks = [{ tag: "div", label: "aviso", insideToast: true, insideFooter: false, isButton: false }]; } }; const r2 = await pr.runInteractionProbe(cdp2);
    expect(r2.botao.interceptadoPeloToast).toBe(true); expect(r2.botao.recebidoPeloBotao).toBe(false);
  });
  it("a captura registra a sonda em preconditions.probe, só com a página declarando 'probe' (sem sonda, nada muda)", () => {
    const src = readFileSync(path.join(ROOT, "lib/capture.mjs"), "utf8"); expect(src).toContain("if (page.probe) pre.probe = await runProbe(cdp, page.probe);");
  });
});

// ---- M10: a interceptação do navegador só é desligada por quem a ligou (regressão achada pelo autoteste visual: o D6 injeta a falha por Fetch.enable e a captura o desligava) ----
describe("interceptação de terceiros preservada (D6 do autoteste visual)", () => {
  it("a captura NÃO desliga o Fetch no início da célula e só o faz no fim se a célula ligou a interceptação (holdUsed)", () => {
    const src = readFileSync(path.join(ROOT, "lib/capture.mjs"), "utf8");
    expect(src.split('send("Fetch.disable"').length - 1).toBe(1); // só dentro de releaseHeld
    expect(src).toContain("if (holdCtx?.holdUsed) await releaseHeld(cdp);"); expect(src).toContain("holdCtx = sctx;");
  });
  it("o passo holdRequest marca a célula (holdUsed) antes de ligar a interceptação", async () => {
    const calls: any[] = []; const ctx: any = { cdp: { async send(m: string, p: any) { calls.push([m, p]); return {}; }, async eval() { return true; } }, report: { rows: [], add() {} } };
    expect(await runner.runStep(ctx, { id: "t", path: "/x", target: { css: "x" }, variant: "v" }, { holdRequest: { urlPattern: "*x*" } })).toBe(true);
    expect(ctx.holdUsed).toBe(true); expect(calls.some((c) => c[0] === "Fetch.enable")).toBe(true);
  });
});

describe("assentamento da captura (M11 / R14)", () => {
  const img = (v: number, noise = 0) => { const w = 20, h = 20, d = new Uint8ClampedArray(w * h * 4).fill(255); for (let i = 0; i < noise; i++) { d[i * 4] = v; } for (let i = 3; i < d.length; i += 4) d[i] = 255; return pngm.encodePng({ width: w, height: h, data: d }); };
  const A = img(255), B = img(254, 17), C = img(254, 30); // B e C diferem de A por ruído imperceptível (1 nível); D difere de verdade
  const D = (() => { const w = 20, h = 20, d = new Uint8ClampedArray(w * h * 4).fill(255); for (let i = 0; i < 50; i++) { d[i * 4 + 1] = 0; d[i * 4 + 2] = 0; } return pngm.encodePng({ width: w, height: h, data: d }); })();
  const seq = (list: Buffer[]) => { let i = 0; return async () => ({ png: list[Math.min(i++, list.length - 1)], n: i }); };
  it("duas capturas idênticas seguidas: assentou em 2", async () => { const r = await cap.settleCapture(seq([A, A])); expect(r.mode).toBe("identical"); expect(r.captures).toBe(2); expect(r.shot.png.equals(A)).toBe(true); });
  it("a 1ª difere perceptivelmente, depois idênticas: guarda o estado assentado (3 capturas)", async () => { const r = await cap.settleCapture(seq([D, A, A])); expect(r.mode).toBe("identical"); expect(r.captures).toBe(3); expect(r.shot.png.equals(A)).toBe(true); });
  it("ruído imperceptível entre a 1ª e a 2ª, depois idênticas: NÃO guarda a 2ª (ruidosa) e sim o estado assentado; registra o ruído", async () => {
    const r = await cap.settleCapture(seq([A, B, B])); expect(r.mode).toBe("identical"); expect(r.captures).toBe(3); expect(r.shot.png.equals(B)).toBe(true); expect(r.settledAfterNoise).toBe(true); expect(r.noisePixels).toBeGreaterThan(0);
    expect(r.sequence[0]).toBeGreaterThan(0); expect(r.sequence[1]).toBe(0);
  });
  it("alternância sem nunca repetir (A,B,A,B…): usa o limite de capturas e guarda a última que passou no portão perceptual, registrando o modo 'imperceptible'", async () => {
    const r = await cap.settleCapture(seq([A, B, A, B, A, B]), { max: 6 }); expect(r.mode).toBe("imperceptible"); expect(r.captures).toBe(6); expect(r.sequence).toHaveLength(5); expect(r.noisePixels).toBeGreaterThan(0);
  });
  it("nunca estabiliza (diferença perceptível sempre): sem captura guardada (a célula vira INCONCLUSIVE)", async () => { const r = await cap.settleCapture(seq([A, D, A, D]), { max: 4 }); expect(r.shot).toBeNull(); expect(r.mode).toBeNull(); expect(r.captures).toBe(4); });
  it("a captura usa settleCapture e a política perceptual antiga só no portão de estabilidade", () => {
    const src = readFileSync(path.join(ROOT, "lib/capture.mjs"), "utf8");
    expect(src).toContain("await settleCapture("); expect(src).toContain("LEGACY_PERCEPTUAL_TOLERANCE"); expect(src).not.toMatch(/for \(let i = 0; i < 5; i\+\+\)\s*\{\s*await rafTwice/);
  });
});

describe("renderização determinística (M11 / R14)", () => {
  it("os sinalizadores de renderização fazem parte do lançamento do navegador E da configuração de captura (mudar invalida as baselines)", async () => {
    const br = await load("lib/browser.mjs");
    expect([...br.RENDER_FLAGS]).toEqual(["--disable-lcd-text", "--font-render-hinting=none", "--force-color-profile=srgb"]);
    const src = readFileSync(path.join(ROOT, "lib/browser.mjs"), "utf8");
    expect(src).toContain("...RENDER_FLAGS"); expect(src).not.toContain("QA_BROWSER_EXTRA_ARGS"); // sem botão escondido que enfraqueça a renderização
    expect([...cap.configFor(null).renderFlags]).toEqual([...br.RENDER_FLAGS]);
    expect(cap.captureConfigVersion({ ...cap.configFor(null), renderFlags: [] })).not.toBe(cap.captureConfigVersion(cap.configFor(null)));
  });
});

describe("login do executor (M11)", () => {
  it("o tempo limite do login tem folga para o primeiro login de um navegador com perfil novo (12–15 s medidos) e o login que não conclui continua sendo UNMEASURABLE", () => {
    expect(runner.LOGIN_TIMEOUT_MS).toBeGreaterThanOrEqual(30000);
    const src = readFileSync(path.join(ROOT, "lib/runner.mjs"), "utf8");
    expect(src).toContain("LOGIN_TIMEOUT_MS)"); expect(src).not.toMatch(/location\.pathname !== '\/login'"\), 15000\)/);
    expect(src).toContain("não concluiu");
  });
});
