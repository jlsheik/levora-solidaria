// Executa cenários num navegador já aberto: viewport emulado e CONFERIDO pelo que a página enxerga, login real pela interface, navegação, tema,
// estados reais (hover/ativo/foco por eventos de entrada do navegador) e medição dos elementos RENDERIZADOS. Cada medição vira linhas no Report
// (PASS/FAIL/MISSING/UNMEASURABLE), sempre identificadas por navegador × cenário × viewport × tema × estado.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { PROBE_SOURCE } from "./probe.mjs";
import { STATUS, evaluateContrast, round2 } from "./contrast.mjs";
import { emulationParams, viewportKey, viewportMatches } from "./viewport.mjs";
import { THEMES, USERS, QA_PASSWORD } from "../scenarios.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (v) => JSON.stringify(v);

/** Registra a sonda em toda navegação (e, opcionalmente, um CSS extra para experimentos de regressão — nunca toca o CSS de produção). */
export async function installProbe(cdp, { injectCss, injectJs } = {}) {
  const ids = [];
  ids.push((await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE_SOURCE })).identifier);
  if (injectCss) {
    const src = `document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.setAttribute('data-qa-injected','1');s.textContent=${q(injectCss)};document.head.appendChild(s)})`;
    ids.push((await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: src })).identifier);
  }
  if (injectJs) ids.push((await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `setInterval(() => { try { ${injectJs} } catch (e) {} }, 40);` })).identifier); // experimento de regressão em JS (só no navegador)
  return async () => { for (const identifier of ids) await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }); };
}

async function waitUntil(fn, ms, every = 120) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* a página pode estar navegando */ } await sleep(every); }
  return null;
}

async function navigate(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await waitUntil(() => cdp.eval("document.readyState === 'complete' && !!window.__qa"), 15000);
}

async function login(cdp, baseUrl, user) {
  await navigate(cdp, `${baseUrl}/login`);
  const filled = await cdp.eval(`(() => {
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    const e = document.querySelector('input[type="email"]'), p = document.querySelector('input[type="password"]'), b = document.querySelector('button[type="submit"]');
    if (!e || !p || !b) return false; set(e, ${q(USERS[user].email)}); set(p, ${q(QA_PASSWORD)}); b.click(); return true; })()`);
  if (!filled) return false;
  return !!(await waitUntil(() => cdp.eval("location.pathname !== '/login'"), 15000));
}

const describe = (cdp) => cdp.eval("JSON.stringify(window.__qa.describe())").then((s) => JSON.parse(s));

/** Espera o estilo/retângulo do alvo estabilizar (transições terminarem): duas leituras iguais seguidas. */
async function settle(cdp) {
  let prev = null; let same = 0; let last = null;
  for (let i = 0; i < 25; i++) {
    last = await describe(cdp);
    const key = JSON.stringify([last?.fg, last?.bg, last?.border, last?.ring, last?.rect, last?.thumb]);
    if (key === prev) { if (++same >= 2) return last; } else same = 0;
    prev = key; await sleep(90);
  }
  return last;
}

const found = (cdp, spec) => cdp.eval(`!!window.__qa.find(${q(spec)})`);

async function setTheme(cdp, theme) {
  await cdp.eval(`document.body.classList.toggle('dark', ${theme === "dark"})`);
  await sleep(150);
}

/** Aplica o viewport (emulação do navegador) e CONFERE o que a página enxerga. Retorna { ok, metrics }. */
async function applyViewport(cdp, vp) {
  await cdp.send("Emulation.setDeviceMetricsOverride", emulationParams(vp));
  await sleep(120);
  const metrics = await cdp.eval("JSON.stringify(window.__qa ? window.__qa.pageMetrics() : { innerWidth, innerHeight })").then(JSON.parse);
  return { ok: viewportMatches(vp, metrics), metrics };
}

/** Aplica o estado real. Retorna { ok, reason, release? } — ok=false vira UNMEASURABLE. */
async function applyState(cdp, state) {
  const reset = async () => { await cdp.mouseMove(1, 1); await cdp.eval("document.activeElement && document.activeElement.blur && document.activeElement.blur()"); };
  if (state === "normal" || state === "off" || state === "on" || state === "disabled") { await reset(); return { ok: true }; }
  if (state === "hover" || state === "active") {
    await reset();
    const c = await cdp.eval("window.__qa.center()");
    if (!c) return { ok: false, reason: "elemento sem posição" };
    if (!(await cdp.eval(`window.__qa.hitsTarget(${c[0]}, ${c[1]})`))) return { ok: false, reason: "o centro do elemento está coberto por outro elemento" };
    await cdp.mouseMove(c[0], c[1]);
    if (state === "active") await cdp.mouseDown(c[0], c[1]);
    await sleep(80);
    const d = await describe(cdp);
    if (state === "hover" && !d.hover) return { ok: false, reason: ":hover não foi aplicado ao elemento (ponteiro não alcançou ou pointer-events: none)" };
    if (state === "active" && !d.active) { await cdp.mouseMove(1, 1); await cdp.mouseUp(1, 1); return { ok: false, reason: ":active não foi aplicado ao elemento" }; }
    return { ok: true, release: async () => { await cdp.mouseMove(1, 1); await cdp.mouseUp(1, 1); } }; // solta FORA do botão: sem clique
  }
  if (state === "focus" || state === "off-focus" || state === "on-focus") {
    await reset();
    await cdp.key("Shift"); // modalidade teclado => :focus-visible
    await cdp.eval("window.__qa.target().focus()");
    await sleep(80);
    const d = await describe(cdp);
    if (!d.focusVisible) return { ok: false, reason: ":focus-visible não foi aplicado (o foco programático não entrou em modalidade teclado)" };
    return { ok: true };
  }
  return { ok: false, reason: `estado desconhecido: ${state}` };
}

function rowBase(ctx, sc, state, kind, extra = {}) {
  return { browser: ctx.name, version: ctx.version, scenario: sc.id, target: extra.target ?? sc.target.css, variant: sc.variant, viewport: ctx.vpKey, viewportInner: ctx.vpInner, theme: ctx.theme, state, kind, ...extra };
}

function addContrast(ctx, sc, d, state, kind, fg, bg, label, extraDetail = "") {
  const ev = evaluateContrast({ fg, bg, kind, fontSizePx: d.fontSizePx, fontWeight: d.fontWeight });
  ctx.report.add(rowBase(ctx, sc, state, kind, { target: label ?? d.label, status: ev.status, ratio: ev.ratio, required: ev.required, detail: `fg=${ev.fgEffective} bg=${ev.bg} ${extraDetail}`.trim() }));
}
function addInfo(ctx, sc, d, state, label, fg, bg) {
  const ev = evaluateContrast({ fg, bg, kind: "text" });
  ctx.report.add(rowBase(ctx, sc, state, "info", { target: label ?? d.label, status: STATUS.PASS, ratio: ev.ratio, required: 0, detail: "informativo (componente desabilitado: isento de limite)" }));
}
function addMissing(ctx, sc, state, why) { ctx.report.add(rowBase(ctx, sc, state, "presença", { status: STATUS.MISSING, detail: why })); }
function addUnmeasurable(ctx, sc, state, why) { ctx.report.add(rowBase(ctx, sc, state, "estado", { status: STATUS.UNMEASURABLE, detail: why })); }
function addLayout(ctx, sc, state, target, ok, detail) { ctx.report.add(rowBase(ctx, sc, state, "layout", { target, status: ok ? STATUS.PASS : STATUS.FAIL, detail })); }

async function measureButton(ctx, sc) {
  for (const state of sc.states) {
    const st = await applyState(ctx.cdp, state);
    if (!st.ok) { addUnmeasurable(ctx, sc, state, st.reason); continue; }
    const d = await settle(ctx.cdp);
    if (st.release) await st.release();
    if (!d) { addMissing(ctx, sc, state, "o elemento sumiu durante a medição"); continue; }
    if (sc.info) { if (!d.disabled) addUnmeasurable(ctx, sc, state, "esperava um componente desabilitado"); else addInfo(ctx, sc, d, state, d.label, d.fg, d.bg); continue; }
    addContrast(ctx, sc, d, state, d.iconOnly ? "icon" : "text", d.fg, d.bg);
    if (state === "focus") {
      if (!d.ring) ctx.report.add(rowBase(ctx, sc, state, "ring", { target: d.label, status: STATUS.FAIL, detail: "sem indicador de foco (nem box-shadow nem outline)" }));
      else addContrast(ctx, sc, d, state, "ring", d.ring.color, d.outsideBg, d.label + " (anel de foco)");
    }
  }
}

async function measureSwitch(ctx, sc) {
  const trackAndThumb = (d, state) => {
    addContrast(ctx, sc, d, state, "boundary", [...d.bg, 1], d.outsideBg, "trilho × superfície");
    if (d.thumb) addContrast(ctx, sc, d, state, "boundary", [...d.thumb.bg, 1], d.bg, "polegar × trilho");
  };
  for (const state of sc.states) {
    let st = await applyState(ctx.cdp, state);
    if (!st.ok) { addUnmeasurable(ctx, sc, state, st.reason); continue; }
    let d = await settle(ctx.cdp);
    if (!d) { addMissing(ctx, sc, state, "o elemento sumiu"); continue; }
    if (state === "disabled") { if (!d.disabled) addUnmeasurable(ctx, sc, state, "esperava um Switch desabilitado"); else { addInfo(ctx, sc, d, state, "trilho × superfície", [...d.bg, 1], d.outsideBg); } continue; }
    if (state === "on" || state === "on-focus") {
      if (d.checked !== "true") { // alterna por teclado real (Espaço) com foco visível
        await applyState(ctx.cdp, "off-focus"); await ctx.cdp.key("Space"); await sleep(120);
        if (state === "on") { await ctx.cdp.eval("document.activeElement.blur()"); }
        d = await settle(ctx.cdp);
        if (d.checked !== "true") { addUnmeasurable(ctx, sc, state, "o Espaço não ligou o Switch"); continue; }
      } else if (state === "on-focus") { st = await applyState(ctx.cdp, "on-focus"); if (!st.ok) { addUnmeasurable(ctx, sc, state, st.reason); continue; } d = await settle(ctx.cdp); }
    } else if ((state === "off" || state === "off-focus") && d.checked !== "false") { addUnmeasurable(ctx, sc, state, `esperava Switch desligado (aria-checked=${d.checked})`); continue; }
    if (state === "off-focus" || state === "on-focus") {
      if (!d.ring) ctx.report.add(rowBase(ctx, sc, state, "ring", { target: "Switch", status: STATUS.FAIL, detail: "sem indicador de foco" }));
      else addContrast(ctx, sc, d, state, "ring", d.ring.color, d.outsideBg, "anel de foco");
    } else trackAndThumb(d, state);
  }
}

async function measureField(ctx, sc) {
  const st = await applyState(ctx.cdp, "normal");
  const d = await settle(ctx.cdp);
  if (!st.ok || !d) { addMissing(ctx, sc, "normal", "elemento ausente"); return; }
  if (d.borderWidth < 1) ctx.report.add(rowBase(ctx, sc, "normal", "boundary", { target: d.label || sc.target.css, status: STATUS.FAIL, detail: "campo sem borda" }));
  else addContrast(ctx, sc, d, "normal", "boundary", d.border, d.outsideBg, "borda × superfície");
  const over = round2(d.rect.right - d.parentContentRight);
  addLayout(ctx, sc, "normal", "largura", over <= 0.5, `excesso sobre o contêiner = ${over}px (limite 0,5)`);
  const inside = d.rect.x >= -0.5 && d.rect.right <= d.viewport + 0.5;
  addLayout(ctx, sc, "normal", "dentro do viewport", inside, `x=${round2(d.rect.x)} direita=${round2(d.rect.right)} viewport=${d.viewport}`);
  addLayout(ctx, sc, "normal", "box-sizing", d.boxSizing === "border-box", `box-sizing=${d.boxSizing}`);
  if (sc.expect?.height !== undefined) addLayout(ctx, sc, "normal", "altura", Math.abs(d.rect.h - sc.expect.height) <= 0.5, `altura=${round2(d.rect.h)}px (esperado ${sc.expect.height}px)`);
  if (sc.expect?.minHeight !== undefined) addLayout(ctx, sc, "normal", "altura mínima", d.rect.h >= sc.expect.minHeight - 0.5, `altura=${round2(d.rect.h)}px (mínimo ${sc.expect.minHeight}px)`);
}

async function measureErrorText(ctx, sc) {
  const d = await settle(ctx.cdp);
  if (!d) { addMissing(ctx, sc, "erro visível", "o texto de erro não apareceu"); return; }
  addContrast(ctx, sc, d, "erro visível", "text", d.fg, d.bg, d.label || sc.variant);
  addLayout(ctx, sc, "erro visível", "mensagem dentro do viewport", d.rect.x >= -0.5 && d.rect.right <= d.viewport + 0.5, `x=${round2(d.rect.x)} direita=${round2(d.rect.right)} viewport=${d.viewport}`);
}

/** Texto ou ícone (kind), contra o fundo efetivo (ou contra um token quando o fundo é gradiente), mais contenção e, se pedido, sinal textual. */
async function measureText(ctx, sc) {
  await applyState(ctx.cdp, "normal");
  const d = await settle(ctx.cdp);
  if (!d) { addMissing(ctx, sc, "normal", "o elemento sumiu durante a medição"); return; }
  let bg = d.bg; let note = "";
  if (sc.bgToken) { const t = await ctx.cdp.eval(`JSON.stringify(window.__qa.tokenColor(${q(sc.bgToken)}))`).then(JSON.parse); if (!t) { addUnmeasurable(ctx, sc, "normal", `token ${sc.bgToken} sem valor`); return; } bg = t; note = `fundo=${sc.bgToken}`; }
  addContrast(ctx, sc, d, "normal", sc.kind ?? "text", d.fg, bg, d.label || sc.variant, note);
  addLayout(ctx, sc, "normal", "dentro do viewport", d.rect.x >= -0.5 && d.rect.right <= d.viewport + 0.5, `x=${round2(d.rect.x)} direita=${round2(d.rect.right)} viewport=${d.viewport}`);
  if (sc.sign) ctx.report.add(rowBase(ctx, sc, "normal", "sinal", { target: d.label, status: new RegExp(sc.sign).test(d.label) ? STATUS.PASS : STATUS.FAIL, detail: `texto "${d.label}" ${new RegExp(sc.sign).test(d.label) ? "traz" : "NÃO traz"} o sinal esperado (/${sc.sign}/): o indicador não depende só da cor` }));
}

async function measureBoundary(ctx, sc) {
  await applyState(ctx.cdp, "normal");
  const d = await settle(ctx.cdp);
  if (!d) { addMissing(ctx, sc, "normal", "o elemento sumiu durante a medição"); return; }
  if (d.borderWidth < 1) { ctx.report.add(rowBase(ctx, sc, "normal", "boundary", { target: sc.variant, status: STATUS.FAIL, detail: "sem borda" })); return; }
  addContrast(ctx, sc, d, "normal", "boundary", d.border, d.outsideBg, "borda × superfície");
  addLayout(ctx, sc, "normal", "dentro do viewport", d.rect.x >= -0.5 && d.rect.right <= d.viewport + 0.5, `x=${round2(d.rect.x)} direita=${round2(d.rect.right)} viewport=${d.viewport}`);
}

/** Foco por teclado no <input type=file> escondido: o contêiner visível precisa mostrar um indicador de foco (anel ≥ 3:1). */
async function measureDropzoneFocus(ctx, sc) {
  await applyState(ctx.cdp, "normal");
  const before = await settle(ctx.cdp);
  await ctx.cdp.key("Shift");
  const ok = await ctx.cdp.eval("window.__qa.focusInner('input[type=\"file\"]')");
  if (!ok) { addUnmeasurable(ctx, sc, "foco", "não consegui focar o campo de arquivo"); return; }
  await sleep(120);
  const d = await settle(ctx.cdp);
  if (!d || !before) { addMissing(ctx, sc, "foco", "o elemento sumiu"); return; }
  if (!d.focusWithin) { addUnmeasurable(ctx, sc, "foco", ":focus-within não foi aplicado ao contêiner"); return; }
  const hadRing = before.ring && JSON.stringify(before.ring) === JSON.stringify(d.ring);
  if (!d.ring || hadRing) ctx.report.add(rowBase(ctx, sc, "foco", "ring", { target: sc.variant, status: STATUS.FAIL, detail: "o foco entrou no campo de arquivo, mas o contêiner visível não mostra nenhum indicador de foco (nem box-shadow nem outline novos)" }));
  else addContrast(ctx, sc, d, "foco", "ring", d.ring.color, d.outsideBg, "anel de foco do contêiner");
}

const MEASURES = { button: measureButton, switch: measureSwitch, field: measureField, errorText: measureErrorText, text: measureText, boundary: measureBoundary, dropzoneFocus: measureDropzoneFocus };

/** Contenção de página e diálogo no viewport efetivo (toda combinação recebe estas verificações). */
async function measureContainment(ctx, sc) {
  const m = await ctx.cdp.eval("JSON.stringify(window.__qa.pageMetrics())").then(JSON.parse);
  addLayout(ctx, sc, "contenção", "página sem rolagem horizontal", m.scrollWidth <= m.innerWidth + 1, `scrollWidth=${m.scrollWidth} innerWidth=${m.innerWidth}`);
  if (m.dialog) {
    addLayout(ctx, sc, "contenção", "diálogo dentro do viewport", m.dialog.left >= -0.5 && m.dialog.right <= m.innerWidth + 0.5, `esquerda=${round2(m.dialog.left)} direita=${round2(m.dialog.right)} innerWidth=${m.innerWidth}`);
    addLayout(ctx, sc, "contenção", "diálogo sem rolagem horizontal interna", m.dialog.scrollWidth <= m.dialog.clientWidth + 1, `scrollWidth=${m.dialog.scrollWidth} clientWidth=${m.dialog.clientWidth}`);
  }
}

async function runStep(ctx, sc, step) {
  if (step.click) {
    const spec = step.click;
    if (!(await waitUntil(() => found(ctx.cdp, spec), 8000))) { addMissing(ctx, sc, "passo", `passo não achou o elemento: ${spec.css}${spec.text ? ` /${spec.text}/` : ""}`); return false; }
    const c = await ctx.cdp.eval("window.__qa.center()");
    await ctx.cdp.click(c[0], c[1]);
    await sleep(250);
    return true;
  }
  if (step.setFile) {
    const { css, within, fileName, content } = step.setFile;
    if (!ctx.filesDir) { addUnmeasurable(ctx, sc, "passo", "sem diretório temporário para o arquivo sintético"); return false; }
    const selector = `${within ? `${within} ` : ""}${css}`;
    if (!(await waitUntil(() => ctx.cdp.eval(`!!document.querySelector(${q(selector)})`), 8000))) { addMissing(ctx, sc, "passo", `campo de arquivo não encontrado: ${selector}`); return false; }
    const file = path.join(ctx.filesDir, fileName);
    writeFileSync(file, content);
    const doc = await ctx.cdp.send("DOM.getDocument", { depth: 0 });
    const node = await ctx.cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    await ctx.cdp.send("DOM.setFileInputFiles", { files: [file], nodeId: node.nodeId });
    await sleep(500);
    return true;
  }
  addUnmeasurable(ctx, sc, "passo", `passo desconhecido: ${Object.keys(step).join(",")}`);
  return false;
}

/** Dimensões úteis diferentes do pedido: se o CONTEÚDO é mais largo que o viewport (o navegador móvel reduz a página), é violação de layout; senão, não medido. */
function viewportProblem(ctx, sc, m, when) {
  const seen = `${m.innerWidth}x${m.innerHeight}`;
  if (m.scrollWidth > ctx.vp.w + 1) addLayout(ctx, sc, "viewport", "conteúdo mais largo que o viewport", false, `scrollWidth=${m.scrollWidth} > ${ctx.vp.w}; a página passou a ocupar ${seen} (${when})`);
  else addUnmeasurable(ctx, sc, "viewport", `a página enxerga ${seen}, esperado ${ctx.vpKey} (${when})`);
}

async function runOne(ctx, sc) {
  await ctx.cdp.send("Emulation.setDeviceMetricsOverride", emulationParams(ctx.vp)); // aplica ANTES de navegar; a conferência é feita com a página da aplicação carregada
  await navigate(ctx.cdp, `${ctx.baseUrl}${sc.path}`);
  const vp = await applyViewport(ctx.cdp, ctx.vp);
  ctx.vpInner = `${vp.metrics.innerWidth}x${vp.metrics.innerHeight}`;
  if (!vp.ok) { viewportProblem(ctx, sc, vp.metrics, "a emulação não se confirmou"); return; }
  await setTheme(ctx.cdp, ctx.theme);
  for (const step of sc.steps) if (!(await runStep(ctx, sc, step))) return;
  if (!(await waitUntil(() => found(ctx.cdp, sc.target), 8000))) { addMissing(ctx, sc, "presença", `elemento não encontrado: ${sc.target.css}${sc.target.text ? ` /${sc.target.text}/` : ""}`); return; }
  await setTheme(ctx.cdp, ctx.theme); // a página pode ter recriado o <body> ao carregar dados
  const dark = await ctx.cdp.eval("document.body.classList.contains('dark')");
  if (dark !== (ctx.theme === "dark")) { addUnmeasurable(ctx, sc, "tema", `não consegui aplicar o tema ${ctx.theme}`); return; }
  const again = await applyViewport(ctx.cdp, ctx.vp); // o viewport precisa continuar valendo depois da navegação e dos passos
  if (!again.ok) { viewportProblem(ctx, sc, again.metrics, "depois da navegação e dos passos"); return; }
  await MEASURES[sc.measure](ctx, sc);
  await measureContainment(ctx, sc);
  if (ctx.screenshotsDir) { // opcional (--screenshots): captura da tela depois das medições, para inspeção humana
    try { await applyState(ctx.cdp, "normal"); const shot = await ctx.cdp.send("Page.captureScreenshot", { format: "png" }); writeFileSync(path.join(ctx.screenshotsDir, `${ctx.name}-${sc.id}-${ctx.vpKey}-${ctx.theme}.png`), Buffer.from(shot.data, "base64")); } catch { /* captura é só um auxílio */ }
  }
}

/** Roda os cenários (agrupados por usuário) em cada viewport e tema e acumula as linhas em `report`. */
export async function runScenarios({ cdp, browserName, version, baseUrl, scenarios, viewports, report, filesDir, screenshotsDir, auth = { current: null } }) {
  for (const user of ["guest", "owner", "volunteer"]) {
    const list = scenarios.filter((s) => s.user === user);
    if (!list.length) continue;
    let ok = true;
    if (auth.current !== user) { // só troca de sessão quando o usuário muda (login real; cookies limpos entre usuários)
      await cdp.send("Network.clearBrowserCookies");
      ok = user === "guest" ? true : await login(cdp, baseUrl, user);
      auth.current = ok ? user : null;
    }
    for (const sc of list) for (const vp of (sc.viewports ?? viewports)) for (const theme of THEMES) {
      const ctx = { cdp, name: browserName, version, baseUrl, report, theme, vp, vpKey: viewportKey(vp), vpInner: "-", filesDir, screenshotsDir };
      if (!ok) { addUnmeasurable(ctx, sc, "login", `login como ${user} não concluiu`); continue; }
      try { await runOne(ctx, sc); } catch (e) { addUnmeasurable(ctx, sc, "execução", `erro inesperado: ${String(e.message).slice(0, 200)}`); }
    }
  }
}
