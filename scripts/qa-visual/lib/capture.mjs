// Captura REAL de uma célula (página × navegador × viewport × tema) via CDP: só captura uma página que está em condições válidas, e diz por que não capturou.
//
// Pré-condições OBSERVÁVEIS (nenhuma é "esperar N segundos"): navegação concluída; app montado (#root com filhos, mesma rota esperada); elemento-âncora da página presente;
// fontes carregadas (document.fonts.ready); rede ociosa (nenhuma requisição pendente em duas leituras seguidas); sem esqueletos/aria-busy; animações e transições
// desligadas (CSS injetado só no navegador + prefers-reduced-motion) e nenhuma animação em curso; viewport e tema conferidos pelo que a página enxerga; foco/mouse neutros;
// e ESTABILIDADE DE PIXELS: duas capturas consecutivas idênticas (senão: INCONCLUSIVE "render instável", nunca uma captura "provavelmente boa").
// Se a página não está em condições válidas, o resultado é um motivo (loadhealth classifica FAIL funcional × não medível), nunca uma imagem de página quebrada.
import { createHash } from "node:crypto";
import { Report } from "./report.mjs";
import { emulationParams, viewportKey, viewportMatches } from "./viewport.mjs";
import { FINGERPRINT_SOURCE } from "./fingerprint.mjs";
import { assessLoad, LOAD } from "./loadhealth.mjs";
import { navigate, applyViewport, setTheme, runStep, waitUntil } from "./runner.mjs";
import { decodePng, encodePng } from "./png.mjs";
import { compareImages, LEGACY_PERCEPTUAL_TOLERANCE } from "./imagediff.mjs";
import { runProbe } from "./probes.mjs";
import { RENDER_FLAGS } from "./browser.mjs";

/** Duas capturas consecutivas são "a mesma imagem"? Idênticas (bytes) ou só diferem abaixo do limiar perceptual (tolerância 0/0: qualquer diferença perceptível é instabilidade). */
export function stableBetween(a, b) {
  if (a.equals(b)) return { stable: true, mode: "identical" };
  let ia, ib; try { ia = decodePng(a); ib = decodePng(b); } catch { return { stable: false, mode: "unreadable" }; }
  if (ia.width !== ib.width || ia.height !== ib.height) return { stable: false, mode: "dimensions" };
  const r = compareImages(ia, ib, { tolerance: LEGACY_PERCEPTUAL_TOLERANCE }); // portão de ESTABILIDADE (a página terminou de renderizar?), não comparação com baseline
  return r.verdict === "IDENTICAL" || r.verdict === "WITHIN_TOLERANCE" ? { stable: true, mode: "imperceptible", exact: r.metrics.exactDiffPixels } : { stable: false, mode: "different", diffPixels: r.metrics.diffPixels };
}

/**
 * M11 / R14 — ASSENTAMENTO da captura. Medido (m11-evidence/r14): em 18 das 48 células o 1º e o 2º screenshot da MESMA página no MESMO processo diferem sempre pelos mesmos pixels (ex.: 17 px
 * em org-inicio/375), e a captura guardava o 2º ("imperceptível"): a imagem gravada dependia de em que estado de rasterização o 2º screenshot caía, e rodadas independentes divergiam.
 * Agora a captura continua até DUAS capturas consecutivas IDÊNTICAS em bytes (o estado assentado). Se isso nunca acontecer em `max` capturas, guarda a última que passou no portão perceptual
 * (modo "imperceptible") e registra a sequência; se nenhuma passou, é instável (INCONCLUSIVE). Função pura: `shoot()` devolve { png, ... }.
 */
export async function settleCapture(shoot, { max = 6, between = stableBetween } = {}) {
  let last = null; let fallback = null; const seq = []; let n = 0;
  for (let i = 0; i < max; i++) {
    const s = await shoot(); n++;
    if (last) {
      const st = between(last, s.png); seq.push(st.stable ? (st.mode === "identical" ? 0 : st.exact ?? 0) : null);
      if (st.stable && st.mode === "identical") return { shot: s, mode: "identical", captures: n, sequence: seq, noisePixels: fallback ? fallback.noise : 0, settledAfterNoise: !!fallback };
      if (st.stable) fallback = { shot: s, noise: st.exact ?? 0 };
    }
    last = s.png;
  }
  if (fallback) return { shot: fallback.shot, mode: "imperceptible", captures: n, sequence: seq, noisePixels: fallback.noise, settledAfterNoise: false };
  return { shot: null, mode: null, captures: n, sequence: seq, noisePixels: 0, settledAfterNoise: false };
}

/**
 * Texto DINÂMICO (data/hora). A semente do QA e o produto exibem o relógio (criação, prazos, "aberto em"): sem tratamento, duas capturas do MESMO conjunto diferem (medido no produto
 * real: 44 de 112 células). Só os NÓS DE TEXTO que casam com datas/horas têm os dígitos trocados por 0: a largura, os separadores e o formato continuam visíveis (um formato de data
 * quebrado ainda aparece); os VALORES de data/hora não são verificados visualmente. Cada captura registra quais nós foram normalizados (quantidade e retângulos exatos).
 */
export const DYNAMIC_TEXT = Object.freeze({
  version: "v1",
  source: String.raw`\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b|\b\d{2}/\d{2}/\d{4}(?:,? \d{2}:\d{2}(?::\d{2})?)?\b|\b\d{2}:\d{2}(?::\d{2})?\b`,
  skipTags: ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"],
});
/** O mesmo critério da página, no Node (testável): { text, matches: ["data"|"hora"|"iso"] }. */
export function normalizeDynamicText(text) {
  const matches = []; const out = String(text).replace(new RegExp(DYNAMIC_TEXT.source, "g"), (m) => { matches.push(m.includes("-") ? "iso" : m.includes("/") ? "data" : "hora"); return m.replace(/\d/g, "0"); });
  return { text: out, matches };
}
const NORMALIZE_SOURCE = `(() => { const re = new RegExp(${JSON.stringify(DYNAMIC_TEXT.source)}, "g"); const skip = new Set(${JSON.stringify(DYNAMIC_TEXT.skipTags)}); const sx = window.scrollX, sy = window.scrollY; const nodes = []; let count = 0;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.parentElement && skip.has(n.parentElement.tagName)) continue; const kinds = []; const d = n.data.replace(re, (m) => { kinds.push(m.includes('-') ? 'iso' : m.includes('/') ? 'data' : 'hora'); return m.replace(/\\d/g, '0'); });
    if (kinds.length) { count += kinds.length; n.data = d; if (nodes.length < 300) { const r = document.createRange(); r.selectNodeContents(n); const b = r.getBoundingClientRect(); nodes.push({ kinds, x: Math.round(b.x + sx), y: Math.round(b.y + sy), w: Math.round(b.width), h: Math.round(b.height) }); } } }
  return JSON.stringify({ version: ${JSON.stringify(DYNAMIC_TEXT.version)}, count, nodeCount: nodes.length, nodes }); })()`;

/** Parte da identidade da configuração de captura: qualquer mudança aqui invalida (STALE) as baselines aprovadas. */
export const CAPTURE_CONFIG = Object.freeze({
  method: "Page.captureScreenshot/png/fromSurface", deviceScaleFactor: 1, fullPage: true, maxHeight: 40000, segmentHeight: 6000, segmentOverlap: 8, reducedMotion: true,
  freezeCss: "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}",
  stableCaptures: 2, readiness: "v3", renderFlags: RENDER_FLAGS, settle: "identical-pair-max6", dynamicText: DYNAMIC_TEXT,
});
/** M04: com o relógio de teste congelado a normalização de texto NÃO é aplicada (os valores de data/hora aparecem como são) e o instante entra na identidade da configuração. */
export function configFor(clock) { return clock ? Object.freeze({ ...CAPTURE_CONFIG, dynamicText: null, clock: { iso: clock.iso, timezone: clock.timezone, locale: clock.locale, version: clock.version } }) : CAPTURE_CONFIG; }
export const captureConfigVersion = (cfg = CAPTURE_CONFIG) => `cc-${createHash("sha256").update(JSON.stringify(cfg)).digest("hex").slice(0, 10)}`;

const q = JSON.stringify;
const sha = (b) => createHash("sha256").update(b).digest("hex");

export const CAPTURE = Object.freeze({ OK: "OK", INCONCLUSIVE: "INCONCLUSIVE", FUNCTIONAL_FAIL: "FUNCTIONAL_FAIL" });

/** Requisições em andamento (id → URL/método). */
function pendingMap(events) {
  const open = new Map();
  for (const e of events) {
    const id = e.params?.requestId;
    if (e.method === "Network.requestWillBeSent") open.set(id, { url: e.params.request?.url ?? "", method: e.params.request?.method ?? "" }); else if (e.method === "Network.loadingFinished" || e.method === "Network.loadingFailed") open.delete(id);
  }
  return open;
}
/**
 * Pendentes INESPERADOS. Sem `expect`, qualquer requisição pendente conta (portão estrito, igual a antes). Com `expect` ({ urlIncludes, method }) — usado SÓ por cenários que declaram
 * o estado "enviando" — a(s) requisição(ões) de envio explicitamente identificada(s) e SEGURADAS pela interceptação do navegador (Fetch.requestPaused) não contam; qualquer outra pendente conta.
 */
export function pendingRequests(events, expect = null) {
  const open = pendingMap(events);
  if (!expect) return open.size;
  const paused = new Set(events.filter((e) => e.method === "Fetch.requestPaused").map((e) => e.params?.networkId));
  let other = 0;
  for (const [id, r] of open) if (!(r.url.includes(expect.urlIncludes) && (!expect.method || r.method === expect.method) && paused.has(id))) other++;
  return other;
}
/** Quantas requisições do envio esperado estão de fato seguradas agora (prova de que o estado "enviando" é real). */
export function heldRequests(events, expect) {
  const open = pendingMap(events); const paused = new Set(events.filter((e) => e.method === "Fetch.requestPaused").map((e) => e.params?.networkId));
  return [...open].filter(([id, r]) => r.url.includes(expect.urlIncludes) && (!expect.method || r.method === expect.method) && paused.has(id)).map(([, r]) => ({ url: r.url.split("?")[0], method: r.method }));
}
/** Libera o que a interceptação segurou: a requisição é ABORTADA (nunca enviada ao servidor) e a interceptação é desligada. */
async function releaseHeld(cdp) {
  const ids = [...new Set(cdp.events.filter((e) => e.method === "Fetch.requestPaused").map((e) => e.params?.requestId))];
  for (const id of ids) { try { await cdp.send("Fetch.failRequest", { requestId: id, errorReason: "Aborted" }, 5000); } catch { /* já liberada */ } }
  try { await cdp.send("Fetch.disable", {}, 5000); } catch { /* sem interceptação ativa */ }
}

/** M09: asserções funcionais de uma página (texto visível incluído/proibido; seletores presentes/ausentes). Pura sobre `cdp.eval`: testável sem navegador. */
export async function checkAssertions(cdp, A) {
  const txt = await cdp.eval("document.body.innerText");
  const missingText = (A.includes ?? []).filter((t) => !String(txt).includes(t)); const forbiddenText = (A.excludes ?? []).filter((r) => new RegExp(r, "i").test(String(txt)));
  const missingEl = []; for (const c of A.present ?? []) if (!(await cdp.eval(`!!document.querySelector(${q(c)})`))) missingEl.push(c);
  const forbiddenEl = []; for (const c of A.absent ?? []) if (await cdp.eval(`!!document.querySelector(${q(c)})`)) forbiddenEl.push(c);
  const failedEval = []; for (const e of A.evalTrue ?? []) { let v = false; try { v = !!(await cdp.eval(e.js)); } catch { v = false; } if (!v) failedEval.push(e.name); } // M10: condições arbitrárias da PÁGINA (ex.: geometria do toast × controles)
  const ok = !(missingText.length || forbiddenText.length || missingEl.length || forbiddenEl.length || failedEval.length);
  return { ok, record: { includes: A.includes ?? [], excludes: A.excludes ?? [], present: A.present ?? [], absent: A.absent ?? [], evalTrue: (A.evalTrue ?? []).map((e) => e.name), ok },
    detail: `texto ausente: ${JSON.stringify(missingText)}; texto proibido presente: ${JSON.stringify(forbiddenText)}; elementos ausentes: ${JSON.stringify(missingEl)}; elementos proibidos presentes: ${JSON.stringify(forbiddenEl)}; condições da página que falharam: ${JSON.stringify(failedEval)}` };
}

async function rafTwice(cdp) { await cdp.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))"); }

export async function shoot(cdp, cfg) {
  const m = await cdp.send("Page.getLayoutMetrics");
  const w = Math.ceil(m.cssContentSize?.width ?? m.contentSize.width), fullH = Math.ceil(m.cssContentSize?.height ?? m.contentSize.height);
  const h = cfg.fullPage ? Math.min(fullH, cfg.maxHeight) : undefined;
  const clipShot = async (y, hh) => Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y, width: w, height: hh, scale: 1 } }, 60000)).data, "base64");
  if (!cfg.fullPage) { const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, 60000); return { png: Buffer.from(shot.data, "base64"), docHeight: fullH, truncated: false, segments: null }; }
  if (h <= cfg.segmentHeight) return { png: await clipShot(0, h), docHeight: fullH, truncated: fullH > cfg.maxHeight, segments: null };
  // M04: página longa = captura SEGMENTADA por faixas (clip) com sobreposição de ${cfg.segmentOverlap} px entre faixas vizinhas; a continuidade é VERIFICADA (as linhas sobrepostas têm de ser idênticas)
  // e as faixas são costuradas sem duplicar linhas. Elementos fixed aparecem uma vez, no lugar em que o navegador os desenha na captura de página inteira (nada duplicado por rolagem).
  const ov = cfg.segmentOverlap; const segs = []; let width = 0;
  for (let y = 0; y < h; y += cfg.segmentHeight) {
    const top = y === 0 ? 0 : y - ov; const hh = Math.min(h, y + cfg.segmentHeight) - top; const png = await clipShot(top, hh); const img = decodePng(png);
    if (img.height !== hh) throw new Error(`segmento em y=${top}: altura ${img.height} != esperada ${hh} (região não capturada)`);
    width = img.width; segs.push({ y: top, h: hh, sha256: createHash("sha256").update(png).digest("hex"), img });
  }
  const rowBytes = width * 4; let continuity = 0;
  for (let i = 1; i < segs.length; i++) {
    const prev = segs[i - 1].img, cur = segs[i].img; const a1 = prev.data.subarray((prev.height - ov) * rowBytes, prev.height * rowBytes), b1 = cur.data.subarray(0, ov * rowBytes);
    if (Buffer.compare(Buffer.from(a1), Buffer.from(b1)) !== 0) throw new Error(`continuidade quebrada entre os segmentos ${i - 1} e ${i} (y≈${segs[i].y}): o conteúdo mudou durante a captura`);
    continuity++;
  }
  const out = Buffer.alloc(width * h * 4); let off = 0;
  segs.forEach((sg, i) => { const skip = i === 0 ? 0 : ov; const src = sg.img.data.subarray(skip * rowBytes, sg.img.height * rowBytes); Buffer.from(src).copy(out, off); off += src.length; });
  if (off !== out.length) throw new Error(`costura incompleta: ${off} bytes de ${out.length}`);
  return { png: encodePng({ width, height: h, data: out }), docHeight: fullH, truncated: fullH > cfg.maxHeight, segments: { count: segs.length, segmentHeight: cfg.segmentHeight, overlap: ov, continuityChecked: continuity, list: segs.map((q) => ({ y: q.y, h: q.h, sha256: q.sha256 })) } };
}

/**
 * Captura uma célula. ctx: { cdp, browserName, version, baseUrl, filesDir? }; page: { id, path, steps, target, user, viewports? }; vp: VIEWPORTS[i]; theme: "light"|"dark".
 * Retorna { status: OK|INCONCLUSIVE|FUNCTIONAL_FAIL, cause, detail, png?, fingerprint?, meta, preconditions }.
 */
export async function captureCell(ctx, page, vp, theme, baseCfg = configFor(ctx.clock)) {
  const cfg = { ...baseCfg, ...(page.capture ?? {}) }; // a página pode declarar um modo próprio (ex.: diálogo = só o viewport); entra na versão da configuração
  const { cdp } = ctx; const t0 = Date.now(); const vpKey = viewportKey(vp);
  const meta = { pageId: page.id, route: page.path, browser: ctx.browserName, browserVersion: ctx.version, viewport: vpKey, theme, capturedAt: new Date().toISOString(), captureConfigVersion: captureConfigVersion(cfg), captureMode: cfg.fullPage ? "full-page" : "viewport", auth: { user: page.user, sessionCookie: page.user !== "guest" } };
  let holdCtx = null; // M10: só a célula que LIGOU a interceptação (passo holdRequest) a desliga; interceptações de terceiros (ex.: D6 do autoteste visual) não são tocadas
  const pre = {}; const stop = (status, cause, detail) => ({ status, cause, detail, meta, preconditions: pre, ms: Date.now() - t0 });
  try {
    cdp.events.length = 0;
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await cdp.send("Network.setBlockedURLs", { urls: [] }); // M08: rede reposta a cada célula
    await cdp.send("Emulation.setDeviceMetricsOverride", emulationParams(vp));
    if (cfg.reducedMotion) await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    const nav = await navigate(cdp, `${ctx.baseUrl}${page.path}`);
    pre.navigation = { ok: !nav.errorText && nav.ready, error: nav.errorText ?? null };
    if (nav.errorText || !nav.ready) return stop(CAPTURE.INCONCLUSIVE, "navigation-failed", nav.errorText ? `a navegação falhou: ${nav.errorText}` : "a página não ficou pronta (readyState=complete + sonda)");
    const v1 = await applyViewport(cdp, vp); pre.viewport = { ok: v1.ok, inner: `${v1.metrics.innerWidth}x${v1.metrics.innerHeight}` };
    if (!v1.ok) return stop(CAPTURE.INCONCLUSIVE, "viewport-not-applied", `a página enxerga ${pre.viewport.inner}, esperado ${vpKey}`);
    await setTheme(cdp, theme);
    const rep = new Report(); const sc = { id: page.id, path: page.path, user: page.user, target: page.target, steps: page.steps ?? [], variant: "visual", viewports: [vp] };
    const sctx = { cdp, name: ctx.browserName, version: ctx.version, baseUrl: ctx.baseUrl, report: rep, theme, vp, vpKey, vpInner: "-", filesDir: ctx.filesDir };
    holdCtx = sctx;
    for (const step of sc.steps) if (!(await runStep(sctx, sc, step))) {
      const load = await assessLoad(cdp, { baseUrl: ctx.baseUrl, expectedPath: page.path });
      return stop(load.verdict === LOAD.FAIL ? CAPTURE.FUNCTIONAL_FAIL : CAPTURE.INCONCLUSIVE, `step-failed:${load.cause}`, `passo da página falhou (${rep.rows.map((r) => r.detail).join("; ").slice(0, 200)}); ${load.detail}`);
    }
    const anchored = await waitUntil(() => cdp.eval(`!!window.__qa.find(${q(page.target)})`), 8000);
    pre.anchor = !!anchored;
    if (!anchored) {
      const load = await assessLoad(cdp, { baseUrl: ctx.baseUrl, expectedPath: page.path });
      pre.load = { verdict: load.verdict, cause: load.cause };
      const kind = load.verdict === LOAD.FAIL ? CAPTURE.FUNCTIONAL_FAIL : CAPTURE.INCONCLUSIVE;
      return stop(kind, load.verdict === LOAD.MEASURABLE ? "anchor-missing" : load.cause, load.verdict === LOAD.MEASURABLE ? `página montada, mas o elemento-âncora ${page.target.css} não existe (MISSING funcional): sem captura` : load.detail);
    }
    const loadOk = await assessLoad(cdp, { baseUrl: ctx.baseUrl, expectedPath: page.path }); pre.load = { verdict: loadOk.verdict, cause: loadOk.cause };
    if (loadOk.verdict !== LOAD.MEASURABLE) return stop(loadOk.verdict === LOAD.FAIL ? CAPTURE.FUNCTIONAL_FAIL : CAPTURE.INCONCLUSIVE, loadOk.cause, loadOk.detail);
    await cdp.eval("document.querySelectorAll('[data-qa-target]').forEach((n) => n.removeAttribute('data-qa-target'))"); // marca interna da sonda: não pode ficar na página capturada
    if (cfg.freezeCss) await cdp.eval(`(() => { let s = document.getElementById('qa-visual-freeze'); if (!s) { s = document.createElement('style'); s.id = 'qa-visual-freeze'; document.head.appendChild(s); } s.textContent = ${q(cfg.freezeCss)}; })()`);
    await setTheme(cdp, theme);
    const dark = await cdp.eval("document.body.classList.contains('dark')"); pre.theme = { ok: dark === (theme === "dark") };
    if (!pre.theme.ok) return stop(CAPTURE.INCONCLUSIVE, "theme-not-applied", `não consegui aplicar o tema ${theme}`);
    const again = await applyViewport(cdp, vp); pre.viewport2 = { ok: again.ok };
    if (!again.ok) return stop(CAPTURE.INCONCLUSIVE, "viewport-lost", "o viewport deixou de valer depois da navegação e dos passos");
    if (!cfg.keepPointer) await cdp.mouseMove(1, 1); // keepPointer: cenário de ARRASTO — mexer o mouse encerraria o gesto em curso (a captura mostra o estado real do arrasto)
    await cdp.eval("document.activeElement && document.activeElement.blur && document.activeElement.blur(); window.scrollTo(0, 0)");
    // fontes, rede ociosa, sem carregamento visível, sem animações em curso — tudo observado
    pre.fonts = await cdp.eval("Promise.race([document.fonts.ready.then(() => document.fonts.status), new Promise((r) => setTimeout(() => r(document.fonts.status), 4000))])"); // limite: fonte pendente não pendura a captura
    if (pre.fonts !== "loaded") return stop(CAPTURE.INCONCLUSIVE, "fonts-not-loaded", `document.fonts.status=${pre.fonts}`);
    const settled = await waitUntil(async () => { const a = pendingRequests(cdp.events, cfg.expectPending); await rafTwice(cdp); const b = pendingRequests(cdp.events, cfg.expectPending); const busy = await cdp.eval("document.querySelectorAll('[class*=\"keleton\"],[aria-busy=\"true\"]').length + document.getAnimations().filter((x) => x.playState === 'running' && x.effect && x.effect.getComputedTiming().iterations !== Infinity).length"); const held = cfg.expectPending ? heldRequests(cdp.events, cfg.expectPending).length : 0; return a === 0 && b === 0 && busy === 0 && (!cfg.expectPending || held >= 1); }, 8000, 150);
    pre.settled = !!settled;
    if (!settled) return stop(CAPTURE.INCONCLUSIVE, "not-settled", `requisições pendentes=${pendingRequests(cdp.events)} ou esqueleto/animação em curso: a interface não estabilizou`);
    // M09: asserções FUNCIONAIS da página (texto visível, elementos presentes/ausentes) avaliadas com a interface estável e ANTES de capturar: uma interface com o texto errado (ou com inglês residual)
    // é FUNCTIONAL_FAIL, nunca "sucesso visual". O resultado entra no metadado da imagem.
    if (page.assert) {
      const r = await checkAssertions(cdp, page.assert); meta.assertions = r.record;
      if (!r.ok) return stop(CAPTURE.FUNCTIONAL_FAIL, "assertion-failed", r.detail);
    }
    if (cfg.expectPending) pre.expectedPending = { rule: cfg.expectPending, held: heldRequests(cdp.events, cfg.expectPending), unexpectedPending: pendingRequests(cdp.events, cfg.expectPending), forwardedToServer: "não: requisição interceptada no estágio Request e abortada ao fim da célula" };
    // texto dinâmico (data/hora): normalizado e REGISTRADO (nós e retângulos exatos) antes das capturas e da impressão de layout
    if (cfg.clock) { meta.dynamicText = { version: "off", count: 0, nodeCount: 0, nodes: [], disabled: "relogio-congelado" }; meta.clock = cfg.clock; pre.dynamicTextNormalized = 0; pre.clock = await cdp.eval("JSON.stringify({ now: new Date().toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone })"); }
    else { const dyn = JSON.parse(await cdp.eval(NORMALIZE_SOURCE)); meta.dynamicText = dyn; pre.dynamicTextNormalized = dyn.count; }
    // M10: sonda de geometria/estilo (só registra; não participa do critério de estabilidade): 3 amostras espaçadas mostram se a GEOMETRIA varia com o tempo
    if (page.probe) pre.probe = await runProbe(cdp, page.probe);
    // estabilidade de pixels: duas capturas consecutivas idênticas OU que só diferem abaixo do limiar perceptual (ruído de rasterização de ±1 nível); qualquer diferença perceptível = instável
    let png = null; let truncated = false; let docHeight = 0; let segments = null; pre.captures = 0; pre.stableMode = null;
    // M11: continua até duas capturas consecutivas IDÊNTICAS (estado assentado); ver settleCapture
    const pixelSettle = await settleCapture(async () => { await rafTwice(cdp); return shoot(cdp, cfg); });
    pre.captures = pixelSettle.captures; pre.captureNoiseSequence = pixelSettle.sequence;
    if (pixelSettle.shot) { const s = pixelSettle.shot; png = s.png; truncated = s.truncated; docHeight = s.docHeight; segments = s.segments; pre.stableMode = pixelSettle.mode; if (pixelSettle.noisePixels) pre.noisePixels = pixelSettle.noisePixels; pre.settledAfterNoise = pixelSettle.settledAfterNoise; }
    pre.pixelStable = !!png;
    if (!png) return stop(CAPTURE.INCONCLUSIVE, "unstable-render", `${pre.captures} capturas consecutivas diferentes: o render não estabilizou`);
    const dec = decodePng(png); meta.width = dec.width; meta.height = dec.height; meta.docHeight = docHeight; meta.truncatedHeight = truncated; meta.segments = segments; meta.complete = !truncated && (!cfg.fullPage || dec.height >= docHeight); // completa = nenhuma região do documento ficou de fora da imagem
    await cdp.eval(FINGERPRINT_SOURCE); const fingerprint = JSON.parse(await cdp.eval("JSON.stringify(window.__qaFingerprint())"));
    meta.imageSha256 = sha(png);
    return { status: CAPTURE.OK, cause: "captured", detail: "captura real em condições válidas", png, fingerprint, meta, preconditions: pre, ms: Date.now() - t0 };
  } catch (e) {
    return stop(CAPTURE.INCONCLUSIVE, "capture-error", `erro inesperado: ${String(e.message).slice(0, 200)}`);
  } finally {
    if (holdCtx?.holdUsed) await releaseHeld(cdp);
    try { await cdp.send("Emulation.setEmulatedMedia", { features: [] }); } catch { /* sessão pode ter fechado */ }
  }
}
