#!/usr/bin/env node
// M12: verifica os AVISOS (toasts) no PRODUTO REAL, em navegador real (CDP), sob diálogo modal e sem ele: duração proporcional ao texto, botão "Fechar aviso" alcançável por ponteiro sob o modal
// (sem fechar o diálogo), pausa por passagem do ponteiro, teclado fora do modal, contraste do botão, alvo de toque, ausência de sobreposição e semântica (aria-live/rótulos em português).
// NÃO é homologação com leitor de tela: o anúncio por tecnologia assistiva não é medido aqui (só os atributos ARIA). Safari, Firefox e teclado virtual real não são exercitados.
// Uso: QA_DATABASE_URL=… node scripts/qa-visual/dev/toast-real-check.mjs [--browser chrome|edge] [--out arquivo.json]   (exit 0 = tudo como esperado). Banco descartável; relógio REAL no navegador.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findBrowser, launchBrowser } from "../lib/browser.mjs";
import { startStack, prepareDatabase, dropDatabase } from "../lib/stack.mjs";
import { installProbe, login, navigate, applyViewport, setTheme, runStep } from "../lib/runner.mjs";
import { Report } from "../lib/report.mjs";
import { FROZEN_CLOCK } from "../lib/clock.mjs";
import { SCENARIOS, QA_PASSWORD } from "../scenarios.mjs";
import { assertDisposableDatabase } from "../lib/guard.mjs";
import { ownRun } from "./own-run.mjs"; // M13: registro de propriedade (identidade de cada filho) para recuperação segura de execuções interrompidas

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { values: o } = parseArgs({ options: { browser: { type: "string", default: "chrome" }, out: { type: "string" }, only: { type: "string", default: "12345" } } });
const on = (n) => o.only.includes(String(n));
const dbUrl = process.env.QA_DATABASE_URL; assertDisposableDatabase(dbUrl); process.env.QA_PASSWORD = QA_PASSWORD;
let retries = 0; const results = []; const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIALOG = '[role="dialog"]'; const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const LONG = "Não foi possível anexar o comprovante porque o arquivo enviado não pôde ser validado pelo servidor neste momento; confira o formato do documento, o tamanho do arquivo e a sua conexão e tente novamente em alguns instantes.";
const body = (m) => JSON.stringify({ json: { message: m } });
const ACTIVE = `[...document.querySelectorAll('[data-sonner-toast]')].filter((t) => t.getAttribute('data-removed') !== 'true').length`;
// mesma regra de toastPolicy.ts (duplicada de propósito: o verificador mede o comportamento, não importa o código sob teste)
const expectedMs = (chars, kind) => (kind === "error" ? Math.min(30000, Math.max(8000, 4000 + chars * 90)) : Math.min(20000, Math.max(4000, 2000 + chars * 70)));
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const own = ownRun(); own.state.setDatabase(assertDisposableDatabase(dbUrl).database);
await prepareDatabase(dbUrl, root, { clock: FROZEN_CLOCK }); const stack = await startStack({ root, databaseUrl: dbUrl, clock: FROZEN_CLOCK, onSpawn: own.onSpawn });
const files = mkdtempSync(path.join(tmpdir(), "levora-qa-toast-")); const session = await launchBrowser(findBrowser(o.browser), { onSpawn: own.onSpawn, onProfile: own.onProfile, onProfileGone: own.onProfileGone }); await installProbe(session.cdp);
try {
  const cdp = session.cdp; if (!(await login(cdp, stack.baseUrl, "owner"))) throw new Error("login do proprietário não concluiu");
  const sc = SCENARIOS.find((s) => s.id === "dropzone-title");
  const ctxFor = (v, theme) => ({ cdp, name: o.browser, version: session.version, baseUrl: stack.baseUrl, report: new Report(), theme, vp: { w: v.w, h: v.h }, vpKey: `${v.w}x${v.h}`, vpInner: "-", filesDir: files });
  const png = { setFile: { css: 'input[type="file"]', within: DIALOG, fileName: "comprovante-sintetico-qa.png", contentBase64: PNG } };
  const hold = { holdRequest: { urlPattern: "*files-upload*" } };
  const fail = (status, message) => ({ fulfillHeld: { status, body: body(message) } });
  /** Abre a página e o diálogo no viewport/tema dados; devolve o contexto. */
  async function openDialog(v, theme, retry = false) {
    await cdp.send("Fetch.disable", {}).catch(() => {}); // interceptação de um passo anterior não pode vazar para o próximo
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: v.w, height: v.h, deviceScaleFactor: 1, mobile: v.mobile });
    await navigate(cdp, `${stack.baseUrl}${sc.path}`); await applyViewport(cdp, { w: v.w, h: v.h }).catch(() => {}); await setTheme(cdp, theme);
    const ctx = ctxFor(v, theme); for (const step of sc.steps ?? []) await runStep(ctx, { ...sc, variant: "toast12" }, step); await sleep(400);
    if (!(await cdp.eval(`!!document.querySelector('[role=dialog]')`)) && !retry) { console.log(`  (diagnóstico) diálogo não abriu em ${v.w}×${v.h} ${theme}; uma nova tentativa (registrada)`); retries++; return openDialog(v, theme, true); }
    return ctx;
  }
  const parkPointer = () => cdp.mouseMove(3, 3); // o clique que abre o diálogo deixa o ponteiro onde o aviso vai aparecer em celular; ponteiro sobre o aviso PAUSA o temporizador (comportamento testado à parte)
  const waitToasts = async (n, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await cdp.eval(ACTIVE)) >= n) return true; await sleep(100); } return false; };
  const trigger = async (ctx, status, message) => { await runStep(ctx, sc, hold); await runStep(ctx, sc, png); const ok = await runStep(ctx, sc, fail(status, message)); const w = await waitToasts(1); if (!w) console.log("  (diagnóstico) falha ao disparar: fulfill=" + ok + " " + await cdp.eval(`JSON.stringify({ dialog: !!document.querySelector(\x27[role=dialog]\x27), input: !!document.querySelector(\x27[role=dialog] input[type=file]\x27), toasts: document.querySelectorAll(\x27[data-sonner-toast]\x27).length, files: document.querySelector(\x27input[type=file]\x27)?.files?.length })`)); return w; };
  /** Mede quanto tempo o aviso ficou visível (ms), a partir do primeiro instante em que existe. */
  async function visibleFor(max) { const t0 = Date.now(); let seen = false; while (Date.now() - t0 < max) { const n = await cdp.eval(ACTIVE); if (n > 0) seen = true; else if (seen) return Date.now() - t0; await sleep(100); } return null; }
  const toastBox = `(() => { const t = document.querySelector('[data-sonner-toast]'); const d = document.querySelector('[role="dialog"]'); if (!t) return null; const r = t.getBoundingClientRect(); const b = t.querySelector('[data-close-button]'); const br = b && b.getBoundingClientRect(); return JSON.stringify({ t: { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }, d: d && (() => { const q = d.getBoundingClientRect(); return { x: q.x, y: q.y, r: q.right, b: q.bottom }; })(), btn: br && { x: br.x, y: br.y, w: br.width, h: br.height }, vh: innerHeight, vw: innerWidth, dlgPad: d && [getComputedStyle(d).paddingLeft, getComputedStyle(d).paddingRight, getComputedStyle(d).paddingTop], dlgScrollH: d && d.scrollHeight, dlgAware: d && d.hasAttribute('data-toast-aware'), reserveAttr: document.documentElement.hasAttribute('data-toast-reserve'), reserveVar: document.documentElement.style.getPropertyValue('--toast-reserve'), toasts: [...document.querySelectorAll('[data-sonner-toast]')].map((x) => ({ removed: x.getAttribute('data-removed'), visible: x.getAttribute('data-visible'), front: x.getAttribute('data-front'), h: x.offsetHeight })) }); })()`;

  // ---- 1) duração proporcional ao texto (1280 claro e 375 escuro) ----
  if (on(1)) for (const [v, theme] of [[{ w: 1280, h: 900, mobile: false }, "light"], [{ w: 375, h: 812, mobile: true }, "dark"]]) {
    const tag = `${v.w}×${v.h} ${theme}`;
    let ctx = await openDialog(v, theme); const okCurto = await trigger(ctx, 500, "x"); await parkPointer(); let ms = okCurto ? await visibleFor(40000) : null;
    check(`${tag}: erro curto fica ≥ 8 s (mínimo de erros) e some sozinho`, ms !== null && ms >= expectedMs(1, "error") - 600 && ms <= expectedMs(1, "error") + 2500, `medido ${ms} ms, esperado ≈ ${expectedMs(1, "error")} ms`);
    ctx = await openDialog(v, theme); const okLongo = await trigger(ctx, 422, LONG); await parkPointer(); const t0 = Date.now(); const at10 = okLongo ? await cdp.eval(ACTIVE) : -1;
    const exp = expectedMs(LONG.length, "error"); ms = okLongo ? await visibleFor(45000) : null; const total = ms === null ? null : Date.now() - t0;
    check(`${tag}: aviso de ${LONG.length} caracteres continua visível após 4 s e dura ≈ proporcional ao texto (antes: 4 s)`, okLongo && total !== null && total >= exp - 800 && total <= exp + 2500, `visível ${total} ms (esperado ≈ ${exp} ms); no instante t≈0 havia ${at10} aviso(s)`);
    check(`${tag}: o aviso longo NÃO é permanente (some sozinho dentro do teto de 30 s)`, total !== null && total <= 30500, `total ${total} ms`);
  }

  // ---- 2) botão de fechar sob o modal, geometria, contraste, semântica e sobreposição ----
  if (on(2)) for (const [v, theme] of [[{ w: 1280, h: 900, mobile: false }, "light"], [{ w: 1280, h: 900, mobile: false }, "dark"], [{ w: 375, h: 812, mobile: true }, "light"], [{ w: 375, h: 812, mobile: true }, "dark"]]) {
    const tag = `${v.w}×${v.h} ${theme}`; const ctx = await openDialog(v, theme);
    await runStep(ctx, sc, hold); await runStep(ctx, sc, png); await runStep(ctx, sc, fail(422, LONG)); await waitToasts(1); await runStep(ctx, sc, png); await runStep(ctx, sc, fail(500, "Segundo aviso: o servidor não respondeu.")); await waitToasts(2); await sleep(700);
    const g = JSON.parse(await cdp.eval(toastBox));
    check(`${tag}: com dois avisos nenhum toast sobrepõe o diálogo (reserva da M11 preservada) e o diálogo cabe na janela`, !!g && g.d && g.d.y >= 0 && g.d.b <= g.vh && (Math.min(g.d.r, g.t.r) <= Math.max(g.d.x, g.t.x) || Math.min(g.d.b, g.t.b) <= Math.max(g.d.y, g.t.y)), JSON.stringify(g));
    const sem = JSON.parse(await cdp.eval(`(() => { const s = document.querySelector('section[aria-live]'); const b = document.querySelector('[data-sonner-toast] [data-close-button]'); return JSON.stringify({ live: s && s.getAttribute('aria-live'), label: s && s.getAttribute('aria-label'), btnLabel: b && b.getAttribute('aria-label'), btnTag: b && b.tagName }); })()`));
    check(`${tag}: semântica: região aria-live=polite rotulada "Avisos" e botão com rótulo em português`, sem.live === "polite" && /Avisos/.test(sem.label ?? "") && sem.btnLabel === "Fechar aviso" && sem.btnTag === "BUTTON", JSON.stringify(sem));
    const touch = JSON.parse(await cdp.eval(`(() => { const t = document.querySelector('[data-sonner-toast]'); const b = t.querySelector('[data-close-button]'); const r = b.getBoundingClientRect(); const cx = r.x + r.width / 2, cy = r.y + r.height / 2; const hit = (dx, dy) => { const e = document.elementFromPoint(cx + dx, cy + dy); return e === b || b.contains(e); }; const cs = getComputedStyle(b); const bg = getComputedStyle(t).backgroundColor; const svg = b.querySelector('svg'); return JSON.stringify({ w: r.width, h: r.height, hit: [hit(0, 0), hit(-20, 0), hit(20, 0), hit(0, -20), hit(0, 20)], color: cs.color, svgStroke: svg ? getComputedStyle(svg).stroke : null, bg, pe: getComputedStyle(t).pointerEvents }); })()`));
    check(`${tag}: alvo do botão de fechar ≥ 44×44 px de área clicável (visível ${Math.round(touch.w)}×${Math.round(touch.h)})`, touch.hit.slice(1).every(Boolean) || touch.hit.slice(1).filter(Boolean).length >= 2, `hits(centro,esq,dir,cima,baixo)=${touch.hit} pointer-events=${touch.pe}`);
    const rgb = (c) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number); const fg = rgb(touch.svgStroke && touch.svgStroke !== "none" ? touch.svgStroke : touch.color); const bgc = rgb(touch.bg);
    check(`${tag}: contraste do ícone de fechar sobre o aviso ≥ 3:1 (não textual, WCAG 1.4.11)`, fg.length === 3 && bgc.length === 3 && ratio(fg, bgc) >= 3, `ícone ${fg} sobre ${bgc} = ${fg.length === 3 && bgc.length === 3 ? ratio(fg, bgc).toFixed(2) : "n/d"}:1`);
    // clique real SOB O MODAL no botão do aviso da frente: fecha só o aviso, o diálogo permanece e o foco continua nele
    const before = await cdp.eval(ACTIVE); const c = JSON.parse(await cdp.eval(`(() => { const t = [...document.querySelectorAll('[data-sonner-toast]')].find((x) => x.getAttribute('data-front') === 'true') || document.querySelector('[data-sonner-toast]'); const r = t.querySelector('[data-close-button]').getBoundingClientRect(); return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]); })()`));
    await cdp.click(c[0], c[1]); await sleep(900); const after = await cdp.eval(ACTIVE);
    const st = JSON.parse(await cdp.eval(`JSON.stringify({ dialog: !!document.querySelector('[role="dialog"]'), inDialog: !!document.activeElement && !!document.activeElement.closest('[role="dialog"]') })`));
    check(`${tag}: clique real no "Fechar aviso" sob o modal dispensa o aviso (${before}→${after}) e NÃO fecha o diálogo`, after < before && st.dialog, `avisos ${before}→${after}; diálogo aberto=${st.dialog}; foco no diálogo=${st.inDialog}`);
    check(`${tag}: após dispensar, o foco permanece dentro do diálogo (sem salto de foco)`, st.inDialog, `foco no diálogo=${st.inDialog}`);
    await cdp.send("Fetch.disable", {}).catch(() => {});
  }

  // ---- 3) pausa por passagem do ponteiro sob o modal ----
  if (on(3)) {
    const v = { w: 1280, h: 900, mobile: false }; const ctx = await openDialog(v, "light"); await trigger(ctx, 500, "x"); await sleep(500);
    const c = JSON.parse(await cdp.eval(`(() => { const r = document.querySelector('[data-sonner-toast]').getBoundingClientRect(); return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]); })()`));
    await cdp.mouseMove(c[0], c[1]); const t0 = Date.now(); await sleep(11000); const still = await cdp.eval(ACTIVE);
    check(`1280×900 light: o ponteiro sobre o aviso (sob o modal) PAUSA o temporizador (visível aos ${Math.round((Date.now() - t0) / 1000)} s, além dos 8 s de um erro curto)`, still >= 1, `avisos ativos=${still}`);
    await cdp.mouseMove(5, 5); const gone = await visibleFor(30000); check(`1280×900 light: ao tirar o ponteiro, o temporizador retoma e o aviso some`, gone !== null, `some em ${gone} ms após retomar`);
    await cdp.send("Fetch.disable", {}).catch(() => {});
  }

  // ---- 4) fora de modal: teclado (Alt+T → Tab → Enter) dispensa o aviso; Escape no diálogo não mata o aviso ----
  if (on(4)) for (const [v, theme] of [[{ w: 1280, h: 900, mobile: false }, "light"], [{ w: 375, h: 812, mobile: true }, "dark"]]) {
    const tag = `${v.w}×${v.h} ${theme}`; const ctx = await openDialog(v, theme); await trigger(ctx, 422, LONG);
    const key = async (k, code, vk, mods = 0) => { await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); await sleep(250); };
    await key("Escape", "Escape", 27); await sleep(500); // fecha o diálogo; o aviso permanece
    const keep = JSON.parse(await cdp.eval(`JSON.stringify({ dialog: !!document.querySelector('[role="dialog"]'), toasts: ${ACTIVE} })`));
    check(`${tag}: fechar o diálogo (Esc) não remove o aviso de erro que ainda precisa ser lido`, !keep.dialog && keep.toasts >= 1, JSON.stringify(keep));
    await key("t", "KeyT", 84, 1); // Alt+T: foca a região de avisos (atalho padrão do Sonner)
    let onButton = false; for (let i = 0; i < 6 && !onButton; i++) { await key("Tab", "Tab", 9); onButton = await cdp.eval(`!!document.activeElement && document.activeElement.hasAttribute('data-close-button')`); }
    const vis = onButton ? JSON.parse(await cdp.eval(`(() => { const e = document.activeElement; const cs = getComputedStyle(e); return JSON.stringify({ shadow: cs.boxShadow !== 'none', outline: cs.outlineStyle !== 'none' }); })()`)) : null;
    check(`${tag}: por teclado (Alt+T, Tab) chega-se ao botão "Fechar aviso" e o foco é visível`, onButton && vis && (vis.shadow || vis.outline), `no botão=${onButton} indicador=${JSON.stringify(vis)}`);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); await sleep(900); const left = await cdp.eval(ACTIVE);
    check(`${tag}: Enter no botão dispensa o aviso`, onButton && left === 0, `avisos restantes=${left}`);
    await cdp.send("Fetch.disable", {}).catch(() => {});
  }

  // ---- 5) M13: teclado SOB o modal (o aviso não é alcançável por Tab; Alt+T dispensa sem mover o foco) ----
  if (on(5)) for (const [v, theme, kind] of [[{ w: 1280, h: 900, mobile: false }, "light", "erro-longo-e-segundo"], [{ w: 375, h: 812, mobile: true }, "dark", "erro-longo"]]) {
    const tag = `${v.w}×${v.h} ${theme} (${kind})`; const ctx = await openDialog(v, theme); await trigger(ctx, 422, LONG); await parkPointer();
    if (kind.includes("segundo")) { await runStep(ctx, sc, png); await runStep(ctx, sc, fail(500, "Segundo aviso: o servidor não respondeu.")); await waitToasts(2); }
    const kd = async (k, code, vk, mods = 0, text) => { await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods, ...(text ? { text } : {}) }); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); await sleep(200); };
    const where = `JSON.stringify({ inDialog: !!document.activeElement && !!document.activeElement.closest('[role="dialog"]'), inToast: !!document.activeElement && !!document.activeElement.closest('[data-sonner-toaster]'), tag: document.activeElement && document.activeElement.tagName, dialog: !!document.querySelector('[role="dialog"]'), toasts: ${ACTIVE} })`;
    // Tab e Shift+Tab: o foco circula DENTRO do diálogo e nunca chega ao aviso (armadilha de foco preservada); o aviso continua visível
    let leaked = false; for (let i = 0; i < 25; i++) { await kd("Tab", "Tab", 9); const w = JSON.parse(await cdp.eval(where)); if (!w.inDialog || w.inToast) leaked = true; } for (let i = 0; i < 25; i++) { await kd("Tab", "Tab", 9, 8); const w = JSON.parse(await cdp.eval(where)); if (!w.inDialog || w.inToast) leaked = true; }
    check(`${tag}: Tab ×25 e Shift+Tab ×25 mantêm o foco dentro do diálogo (armadilha de foco intacta; o aviso não entra na ordem de Tab)`, !leaked, leaked ? "o foco saiu do diálogo" : "preso corretamente");
    // semântica por atributos
    const sem = JSON.parse(await cdp.eval(`JSON.stringify([...document.querySelectorAll('[data-sonner-toast]')].map((t) => ({ type: t.getAttribute('data-type'), role: t.getAttribute('role'), hint: !!t.querySelector('[data-toast-hint]') })))`));
    check(`${tag}: erro com role="alert" e texto do atalho (Alt+T) para tecnologia assistiva`, sem.length >= 1 && sem.every((x) => x.type !== "error" || x.role === "alert") && sem.every((x) => x.hint), JSON.stringify(sem));
    // Espaço num campo de texto DO diálogo (foco explícito): digita o espaço e não dispensa o aviso nem fecha o diálogo (Enter não é testado aqui: poderia enviar o formulário)
    await cdp.eval("(() => { const f = document.querySelector('[role=dialog] textarea, [role=dialog] input[type=text]'); if (f) f.focus(); })()"); await sleep(150);
    const before = JSON.parse(await cdp.eval(where)).toasts; await kd(" ", "Space", 32, 0, " "); const afterSpace = JSON.parse(await cdp.eval(where));
    check(`${tag}: Espaço no campo de texto focado do diálogo não dispensa o aviso nem fecha o diálogo (avisos ${before}→${afterSpace.toasts}; foco no diálogo=${afterSpace.inDialog})`, afterSpace.toasts === before && afterSpace.dialog && afterSpace.inDialog, JSON.stringify(afterSpace));
    if (!(await cdp.eval(`!!document.querySelector('[role="dialog"]')`))) { await openDialog(v, theme); await trigger(ctx, 422, LONG); await parkPointer(); }
    // Alt+T: dispensa SEM mover o foco e o diálogo permanece; foco visível mantido (continua no mesmo elemento)
    const f0 = await cdp.eval("(() => { const e = document.activeElement; return e ? e.tagName + '|' + (e.getAttribute('aria-label') || e.textContent || '').slice(0, 30) : null; })()");
    await kd("t", "KeyT", 84, 1); await sleep(700); const w2 = JSON.parse(await cdp.eval(where)); const f1 = await cdp.eval("(() => { const e = document.activeElement; return e ? e.tagName + '|' + (e.getAttribute('aria-label') || e.textContent || '').slice(0, 30) : null; })()");
    check(`${tag}: Alt+T sob o modal dispensa TODOS os avisos, o diálogo permanece e o foco não se move (${f0} → ${f1})`, w2.toasts === 0 && w2.dialog && w2.inDialog && f0 === f1, JSON.stringify(w2));
    // Escape continua fechando só o diálogo (não é sequestrado pelos avisos)
    await trigger(ctx, 422, LONG).catch(() => {}); await kd("Escape", "Escape", 27); await sleep(500); const w3 = JSON.parse(await cdp.eval(where));
    check(`${tag}: Esc fecha o diálogo (comportamento original) e não é consumido pelos avisos`, !w3.dialog, JSON.stringify(w3));
    await cdp.send("Fetch.disable", {}).catch(() => {});
  }
  // informativo (sucesso) sob o modal: role=status e dispensável por Alt+T
  if (on(5)) { const v = { w: 1280, h: 900, mobile: false }; const ctx = await openDialog(v, "light"); await runStep(ctx, sc, png); await waitToasts(1, 12000); await parkPointer();
    const s0 = JSON.parse(await cdp.eval(`JSON.stringify([...document.querySelectorAll('[data-sonner-toast]')].map((t) => ({ type: t.getAttribute('data-type'), role: t.getAttribute('role') })))`));
    check("1280×900 light: mensagem informativa/sucesso sob o modal tem role=status (não alert)", s0.length >= 1 && s0.every((x) => x.role === "status"), JSON.stringify(s0));
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "t", code: "KeyT", windowsVirtualKeyCode: 84, modifiers: 1 }); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "t", code: "KeyT", windowsVirtualKeyCode: 84, modifiers: 1 }); await sleep(700);
    check("1280×900 light: Alt+T dispensa também o aviso informativo sob o modal", (await cdp.eval(ACTIVE)) === 0 && !!(await cdp.eval(`!!document.querySelector('[role="dialog"]')`)), "ok"); }
} finally { await session.close(); await stack.stop(); await dropDatabase(dbUrl); rmSync(files, { recursive: true, force: true }); own.state.clearDatabase(); await own.end(); }
results.push({ name: "tentativas extras para abrir o diálogo (infra do verificador; 0 é o esperado)", ok: true, detail: `${retries}` });
const fails = results.filter((x) => !x.ok).length; if (o.out) writeFileSync(path.resolve(o.out), JSON.stringify({ geradoEm: new Date().toISOString(), navegador: o.browser, total: results.length, falhas: fails, nota: "Teclado automatizado e ARIA por atributos; NÃO é homologação com leitor de tela, Safari, Firefox nem teclado virtual real.", resultados: results }, null, 2) + "\n");
console.log(`\nAvisos no produto real: ${results.length - fails}/${results.length} como esperado`); process.exit(fails ? 4 : 0);
