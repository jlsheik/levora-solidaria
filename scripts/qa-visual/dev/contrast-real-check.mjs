#!/usr/bin/env node
// M05 (F18): contraste MEDIDO no PRODUTO REAL, não estimado. Para cada página da matriz visual (14) × viewport (375, 1280) × tema (claro, escuro):
//  - texto visível: razão de contraste WCAG 2.x entre a cor efetiva do texto (alfa e opacidade dos ancestrais compostos) e o fundo efetivo (ancestrais compostos); mínimo 4,5:1, ou 3:1 para texto grande (≥24px, ou ≥18,66px em negrito);
//  - placeholder (::placeholder), texto de controles desabilitados (registrado à parte: WCAG isenta, mas o valor é medido e reportado);
//  - fronteira de campos (input/select/textarea) contra o fundo ao redor: mínimo 3:1 (WCAG 1.4.11);
//  - ícones SVG relevantes (currentColor/stroke) contra o fundo: mínimo 3:1.
// Quando há diálogo aberto só o conteúdo do diálogo é medido (o resto está sob o overlay). Fundo com imagem/gradiente é marcado "indeterminado": a razão é calculada sobre a cor de fundo composta dos ancestrais (o gradiente não entra) e os seletores indeterminados são listados para conferência manual.
// Uso: QA_DATABASE_URL=… node scripts/qa-visual/dev/contrast-real-check.mjs [--browser chrome|edge] [--out arquivo.json] [--pages a,b]   (exit 0 = nenhuma reprovação; 4 = há reprovações)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findBrowser, launchBrowser } from "../lib/browser.mjs";
import { startStack, prepareDatabase, dropDatabase } from "../lib/stack.mjs";
import { installProbe, login, navigate, applyViewport, setTheme, runStep } from "../lib/runner.mjs";
import { Report } from "../lib/report.mjs";
import { FROZEN_CLOCK, browserClockScript } from "../lib/clock.mjs";
import { QA_PASSWORD } from "../scenarios.mjs";
import { VISUAL_PAGES } from "../visual-matrix.mjs";
import { assertDisposableDatabase } from "../lib/guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { values: o } = parseArgs({ options: { browser: { type: "string", default: "chrome" }, out: { type: "string" }, pages: { type: "string" } } });
const dbUrl = process.env.QA_DATABASE_URL; assertDisposableDatabase(dbUrl); process.env.QA_PASSWORD = QA_PASSWORD;
const VIEWS = [{ w: 375, h: 812, mobile: true }, { w: 1280, h: 900, mobile: false }];
const pages = VISUAL_PAGES.filter((p) => !o.pages || o.pages.split(",").includes(p.id));
const results = []; const fails = [];

// Roda dentro da página. Devolve JSON { n, items: [...] } com cada medição.
export const MEASURE = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (f, b) => { const a = f[3]; return [f[0] * a + b[0] * (1 - a), f[1] * a + b[1] * (1 - a), f[2] * a + b[2] * (1 - a), 1]; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const dlg = document.querySelector('[role="dialog"]');
  const root = dlg || document.body;
  const bgOf = (el) => { // fundo efetivo: compõe do ancestral mais externo para o elemento; imagem/gradiente => indeterminado
    const chain = []; let e = el; let indeterminate = false;
    while (e && e.nodeType === 1) { const cs = getComputedStyle(e); if (cs.backgroundImage && cs.backgroundImage !== 'none') indeterminate = true; chain.push(rgba(cs.backgroundColor)); if (chain[chain.length - 1][3] >= 0.999) break; e = e.parentElement; }
    let base = rgba(getComputedStyle(document.documentElement).backgroundColor); if (base[3] < 0.999) base = over(base, [255, 255, 255, 1]);
    const opaque = chain.length > 0 && chain[chain.length - 1][3] >= 0.999; let cur = opaque ? chain[chain.length - 1] : base;
    for (let i = chain.length - (opaque ? 2 : 1); i >= 0; i--) cur = over(chain[i], cur);
    return { c: cur, indeterminate };
  };
  const opac = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity || '1'); return o; };
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && !(r.width <= 1 && r.height <= 1) && cs.visibility !== 'hidden' && cs.display !== 'none' && opac(el) > 0.01; };
  const sel = (el) => { const cls = (typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter(Boolean).map((c) => c.replace(/_[A-Za-z0-9]{5,}$/, '')).join('.'); return el.tagName.toLowerCase() + (cls ? '.' + cls : ''); };
  const items = [];
  const push = (kind, el, fg, bgr, need, extra) => { const r = ratio(fg, bgr.c); items.push({ kind, sel: sel(el), text: (extra && extra.text) || '', ratio: Math.round(r * 100) / 100, need, ok: r + 1e-9 >= need, indeterminate: bgr.indeterminate, fg: fg.slice(0, 3).map(Math.round).join(','), bg: bgr.c.slice(0, 3).map(Math.round).join(','), disabled: !!(extra && extra.disabled), size: extra && extra.size, weight: extra && extra.weight }); };
  // texto
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const seen = new Set();
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const txt = t.nodeValue.replace(/\\s+/g, ' ').trim(); if (!txt) continue; const el = t.parentElement; if (!el || seen.has(el) || !vis(el)) continue; if (['SCRIPT', 'STYLE', 'OPTION'].includes(el.tagName)) continue; seen.add(el);
    const cs = getComputedStyle(el); const fs = parseFloat(cs.fontSize); const w = parseInt(cs.fontWeight, 10) || 400; const large = fs >= 24 || (fs >= 18.66 && w >= 700);
    let fg = rgba(cs.color); const a = fg[3] * opac(el); const bgr = bgOf(el); fg = over([fg[0], fg[1], fg[2], a], bgr.c);
    const dis = !!el.closest('button:disabled, input:disabled, select:disabled, textarea:disabled, [aria-disabled="true"], fieldset:disabled');
    push('texto', el, fg, bgr, large ? 3 : 4.5, { text: txt.slice(0, 48), disabled: dis, size: fs, weight: w });
  }
  // placeholder e valor de campos
  for (const el of root.querySelectorAll('input, textarea, select')) { if (!vis(el) || el.type === 'hidden' || el.type === 'checkbox' || el.type === 'radio') continue;
    const cs = getComputedStyle(el); const bgr = bgOf(el); const dis = el.disabled;
    if ((el.placeholder || '') && !el.value) { const ps = getComputedStyle(el, '::placeholder'); let fg = rgba(ps.color); fg = over([fg[0], fg[1], fg[2], fg[3] * parseFloat(ps.opacity || '1')], bgr.c); push('placeholder', el, fg, bgr, 4.5, { text: el.placeholder.slice(0, 40), disabled: dis, size: parseFloat(cs.fontSize) }); }
    // fronteira do campo contra o fundo ao redor (o fundo do pai)
    const par = bgOf(el.parentElement || document.body); let bc = rgba(cs.borderTopColor); const bw = parseFloat(cs.borderTopWidth);
    if (bw > 0 && bc[3] > 0) { bc = over(bc, bgr.c.map((v, i) => i < 3 ? v : 1)); const fld = bgr; /* o campo tem fundo próprio: compara borda × fundo do ambiente */ const r1 = ratio(bc, par.c); items.push({ kind: 'borda-campo', sel: sel(el), text: el.type || el.tagName.toLowerCase(), ratio: Math.round(r1 * 100) / 100, need: 3, ok: r1 >= 3, indeterminate: par.indeterminate, fg: bc.slice(0, 3).map(Math.round).join(','), bg: par.c.slice(0, 3).map(Math.round).join(','), disabled: dis }); }
  }
  // chaves e caixas (role=switch/checkbox): trilho/borda contra o fundo ao redor, mínimo 3:1
  for (const el of root.querySelectorAll('[role="switch"], [role="checkbox"], input[type="checkbox"], input[type="radio"]')) { if (!vis(el)) continue; const cs = getComputedStyle(el); const par = bgOf(el.parentElement || document.body); const own = rgba(cs.backgroundColor); const bw = parseFloat(cs.borderTopWidth); let c = own[3] > 0.5 ? own : rgba(cs.borderTopColor); if (own[3] <= 0.5 && !(bw > 0)) continue; c = over(c, par.c); const r1 = ratio(c, par.c); items.push({ kind: 'controle', sel: sel(el), text: el.getAttribute('role') || el.type, ratio: Math.round(r1 * 100) / 100, need: 3, ok: r1 >= 3, indeterminate: par.indeterminate, fg: c.slice(0, 3).map(Math.round).join(','), bg: par.c.slice(0, 3).map(Math.round).join(','), disabled: !!el.disabled }); }
  // ícones
  for (const el of root.querySelectorAll('svg')) { if (!vis(el)) continue; const r = el.getBoundingClientRect(); if (r.width < 10) continue; const cs = getComputedStyle(el); let fg = rgba(cs.color); const st = rgba(cs.stroke === 'none' ? 'rgba(0,0,0,0)' : cs.stroke); if (st[3] > 0) fg = st; const bgr = bgOf(el.parentElement || el); fg = over([fg[0], fg[1], fg[2], fg[3] * opac(el)], bgr.c);
    const dis = !!el.closest('button:disabled, [aria-disabled="true"]'); push('icone', el, fg, bgr, 3, { text: (el.getAttribute('class') || 'svg').toString().slice(0, 30), disabled: dis }); }
  return JSON.stringify({ n: items.length, dialog: !!dlg, items });
})()`;

await prepareDatabase(dbUrl, root, { clock: FROZEN_CLOCK }); const stack = await startStack({ root, databaseUrl: dbUrl, clock: FROZEN_CLOCK });
const files = mkdtempSync(path.join(tmpdir(), "levora-qa-contrast-")); const session = await launchBrowser(findBrowser(o.browser)); await installProbe(session.cdp);
await session.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: browserClockScript(FROZEN_CLOCK) }); await session.cdp.send("Emulation.setTimezoneOverride", { timezoneId: FROZEN_CLOCK.timezone });
try {
  const cdp = session.cdp; let current = null;
  for (const user of [...new Set(pages.map((p) => p.user))].sort((a, b) => (a === "guest" ? -1 : b === "guest" ? 1 : 0))) {
    await cdp.send("Network.clearBrowserCookies"); if (user !== "guest" && !(await login(cdp, stack.baseUrl, user))) throw new Error(`login de ${user} não concluiu`); current = user;
    for (const pg of pages.filter((p) => p.user === user)) for (const v of VIEWS) for (const theme of ["light", "dark"]) {
      const tag = `${pg.id} · ${v.w}px · ${theme}`;
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: v.w, height: v.h, deviceScaleFactor: 1, mobile: v.mobile });
      const nav = await navigate(cdp, `${stack.baseUrl}${pg.path}`); await applyViewport(cdp, { w: v.w, h: v.h }).catch(() => {}); await setTheme(cdp, theme);
      const rep = new Report(); const sctx = { cdp, name: o.browser, version: session.version, baseUrl: stack.baseUrl, report: rep, theme, vp: { w: v.w, h: v.h }, vpKey: `${v.w}x${v.h}`, vpInner: "-", filesDir: files };
      let ok = nav.ready; for (const step of pg.steps ?? []) if (!(await runStep(sctx, { ...pg, variant: "contrast" }, step))) ok = false;
      await cdp.eval("document.fonts.ready.then(() => 0)"); await new Promise((r) => setTimeout(r, 700));
      if (!ok) { console.log(`FALHA DE PREPARO  ${tag}`); fails.push({ tag, kind: "preparo" }); continue; }
      const m = JSON.parse(await cdp.eval(MEASURE)); const bad = m.items.filter((i) => !i.ok && !i.disabled); const dis = m.items.filter((i) => !i.ok && i.disabled); const ind = m.items.filter((i) => i.indeterminate);
      results.push({ tag, page: pg.id, w: v.w, theme, n: m.n, dialog: m.dialog, falhas: bad, desabilitados: dis, indeterminados: ind.length, indeterminadosSel: [...new Set(ind.map((i) => i.sel))], min: Math.min(...m.items.map((i) => i.ratio)) });
      console.log(`${bad.length ? "FAIL" : "PASS"}  ${tag} — ${m.n} medições, ${bad.length} abaixo do mínimo, ${dis.length} desabilitadas abaixo, ${ind.length} indeterminadas`);
      for (const b of bad.slice(0, 12)) console.log(`      ${b.kind} ${b.sel} "${b.text}" ${b.ratio}:1 (<${b.need}) fg=${b.fg} bg=${b.bg}`);
      for (const b of bad) fails.push({ tag, ...b });
    }
  }
} finally { await session.close(); await stack.stop(); await dropDatabase(dbUrl); rmSync(files, { recursive: true, force: true }); }
if (o.out) writeFileSync(path.resolve(o.out), JSON.stringify({ geradoEm: new Date().toISOString(), navegador: o.browser, celulas: results.length, reprovacoes: fails.length, resultados: results }, null, 2) + "\n");
console.log(`\nContraste no produto real: ${results.length} células medidas, ${fails.length} medição(ões) abaixo do mínimo (desabilitadas listadas à parte)`); process.exit(fails.length ? 4 : 0);
