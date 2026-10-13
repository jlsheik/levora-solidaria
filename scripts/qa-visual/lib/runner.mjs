// Executa cenários num navegador já aberto: login real pela interface, navegação, tema, estados reais (hover/ativo/foco por eventos de entrada do
// navegador) e medição dos elementos RENDERIZADOS. Cada medição vira linhas no Report (PASS/FAIL/MISSING/UNMEASURABLE).
import { PROBE_SOURCE } from "./probe.mjs";
import { STATUS, evaluateContrast, round2 } from "./contrast.mjs";
import { THEMES, USERS, QA_PASSWORD } from "../scenarios.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (v) => JSON.stringify(v);

/** Registra a sonda em toda navegação (e, opcionalmente, um CSS extra para experimentos de regressão — nunca toca o CSS de produção). */
export async function installProbe(cdp, { injectCss } = {}) {
  const ids = [];
  ids.push((await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE_SOURCE })).identifier);
  if (injectCss) {
    const src = `document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.setAttribute('data-qa-injected','1');s.textContent=${q(injectCss)};document.head.appendChild(s)})`;
    ids.push((await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: src })).identifier);
  }
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
  return { browser: ctx.name, version: ctx.version, scenario: sc.id, target: extra.target ?? sc.target.css, variant: sc.variant, theme: ctx.theme, state, kind, ...extra };
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
  ctx.report.add(rowBase(ctx, sc, "normal", "layout", { target: "largura", status: over <= 0.5 ? STATUS.PASS : STATUS.FAIL, detail: `excesso sobre o contêiner = ${over}px (limite 0,5)` }));
  ctx.report.add(rowBase(ctx, sc, "normal", "layout", { target: "box-sizing", status: d.boxSizing === "border-box" ? STATUS.PASS : STATUS.FAIL, detail: `box-sizing=${d.boxSizing}` }));
  if (sc.expect?.height !== undefined) ctx.report.add(rowBase(ctx, sc, "normal", "layout", { target: "altura", status: Math.abs(d.rect.h - sc.expect.height) <= 0.5 ? STATUS.PASS : STATUS.FAIL, detail: `altura=${round2(d.rect.h)}px (esperado ${sc.expect.height}px)` }));
  if (sc.expect?.minHeight !== undefined) ctx.report.add(rowBase(ctx, sc, "normal", "layout", { target: "altura mínima", status: d.rect.h >= sc.expect.minHeight - 0.5 ? STATUS.PASS : STATUS.FAIL, detail: `altura=${round2(d.rect.h)}px (mínimo ${sc.expect.minHeight}px)` }));
}

async function measureErrorText(ctx, sc) {
  const d = await settle(ctx.cdp);
  if (!d) { addMissing(ctx, sc, "erro visível", "o texto de erro não apareceu"); return; }
  addContrast(ctx, sc, d, "erro visível", "text", d.fg, d.bg, d.label || sc.variant);
}

const MEASURES = { button: measureButton, switch: measureSwitch, field: measureField, errorText: measureErrorText };

async function runOne(ctx, sc) {
  await navigate(ctx.cdp, `${ctx.baseUrl}${sc.path}`);
  await setTheme(ctx.cdp, ctx.theme);
  for (const step of sc.steps) {
    const spec = step.click;
    if (!(await waitUntil(() => found(ctx.cdp, spec), 8000))) { addMissing(ctx, sc, "passo", `passo não achou o elemento: ${spec.css}${spec.text ? ` /${spec.text}/` : ""}`); return; }
    const c = await ctx.cdp.eval("window.__qa.center()");
    await ctx.cdp.click(c[0], c[1]);
    await sleep(250);
  }
  if (!(await waitUntil(() => found(ctx.cdp, sc.target), 8000))) { addMissing(ctx, sc, "presença", `elemento não encontrado: ${sc.target.css}${sc.target.text ? ` /${sc.target.text}/` : ""}`); return; }
  await setTheme(ctx.cdp, ctx.theme); // a página pode ter recriado o <body> ao carregar dados
  const dark = await ctx.cdp.eval("document.body.classList.contains('dark')");
  if (dark !== (ctx.theme === "dark")) { addUnmeasurable(ctx, sc, "tema", `não consegui aplicar o tema ${ctx.theme}`); return; }
  await MEASURES[sc.measure](ctx, sc);
}

/** Roda os cenários (agrupados por usuário) e acumula as linhas em `report`. */
export async function runScenarios({ cdp, browserName, version, baseUrl, scenarios, report }) {
  for (const user of ["guest", "owner", "volunteer"]) {
    const list = scenarios.filter((s) => s.user === user);
    if (!list.length) continue;
    await cdp.send("Network.clearBrowserCookies");
    if (user !== "guest") {
      const ok = await login(cdp, baseUrl, user);
      if (!ok) { for (const sc of list) report.add({ browser: browserName, version, scenario: sc.id, target: sc.target.css, variant: sc.variant, theme: "-", state: "login", kind: "ambiente", status: STATUS.UNMEASURABLE, detail: `login como ${user} não concluiu` }); continue; }
    }
    for (const sc of list) for (const theme of THEMES) {
      const ctx = { cdp, name: browserName, version, baseUrl, report, theme };
      try { await runOne(ctx, sc); } catch (e) { addUnmeasurable(ctx, sc, "execução", `erro inesperado: ${String(e.message).slice(0, 200)}`); }
    }
  }
}
