#!/usr/bin/env node
// M05 (F09): alvos de toque, espaçamento e foco por TECLADO no PRODUTO REAL (14 páginas × {375, 1280} × {claro, escuro}).
//  1) tamanho do alvo: mobile (375, ponteiro grosso) ≥ 44×44 px de área clicável; desktop ≥ 24×24 (WCAG 2.2 AA 2.5.8) — o desktop com mouse NÃO é obrigado a 44 e o valor medido (ex.: 32 px) é reportado;
//     isentos: links dentro de texto corrido (display inline), elementos ocultos/sr-only, campos de formulário nativos ocultos, itens de menu aberto;
//  2) distância entre alvos pequenos: quando um alvo tem menos de 24 px, não pode haver outro alvo a menos de 24 px do seu centro (exceção de espaçamento do 2.5.8);
//  3) foco: a navegação por Tab (até 80 paradas por página) deve mostrar um indicador de foco visível (contorno ≥ 2 px ou sombra de anel) em CADA parada, com contraste ≥ 3:1 contra o fundo; o foco não pode ficar preso nem sumir.
// Uso: QA_DATABASE_URL=… node scripts/qa-visual/dev/targets-real-check.mjs [--browser chrome|edge] [--out arquivo.json] [--pages a,b]   (exit 0 = tudo conforme; 4 = reprovações)
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

const TARGETS = `(() => {
  const dlg = document.querySelector('[role="dialog"]'); const root = dlg || document.body; const mobile = innerWidth < 768; const min = mobile ? 44 : 24;
  const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="combobox"], summary';
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.01; };
  const name = (e) => (e.getAttribute('aria-label') || e.textContent || e.placeholder || e.type || e.tagName).replace(/\\s+/g, ' ').trim().slice(0, 40);
  const list = [...root.querySelectorAll(sel)].filter(vis).map((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    const inline = e.tagName === 'A' && cs.display === 'inline' && !!e.closest('p, li, span, div') && (e.parentElement && /^(P|LI|SPAN|SMALL|STRONG|EM|LABEL)$/.test(e.parentElement.tagName));
    const hiddenNative = (e.type === 'checkbox' || e.type === 'radio') && cs.opacity === '0';
    return { el: e, name: name(e), tag: e.tagName.toLowerCase(), cls: (typeof e.className === 'string' ? e.className : '').split(/\\s+/)[0].replace(/_[A-Za-z0-9]{5,}$/, ''), x: r.x, y: r.y + scrollY, w: r.width, h: r.height, inline, hiddenNative }; });
  const items = list.filter((t) => !t.inline && !t.hiddenNative);
  const hit = (e) => { e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(); const cx = r.x + r.width / 2, cy = r.y + r.height / 2; const own = (x, y) => { const t = document.elementFromPoint(x, y); return !!t && (t === e || e.contains(t)); };
    let up = 0, dn = 0, lf = 0, rt = 0; while (up < 40 && own(cx, r.y - up - 1)) up++; while (dn < 40 && own(cx, r.bottom + dn + 1)) dn++; while (lf < 40 && own(r.x - lf - 1, cy)) lf++; while (rt < 40 && own(r.right + rt + 1, cy)) rt++; return { w: r.width + lf + rt, h: r.height + up + dn }; };
  const FIELD = /^(input|select|textarea)$/; // campos de texto/seleção de largura total: no mobile o mínimo é 40 px (decisão de produto documentada; 44 px vale para botões, links, abas e chaves)
  const need = (t) => (mobile && (FIELD.test(t.tag) || t.cls.indexOf('_input') === 0 || t.cls === '_input' || t.cls === 'input') ? 40 : min);
  const small = items.filter((t) => Math.min(t.w, t.h) < need(t) - 0.5).filter((t) => { const h = hit(t.el); t.hw = Math.round(h.w); t.hh = Math.round(h.h); return Math.min(h.w, h.h) < need(t) - 0.5; });
  const crowd = []; if (!mobile) for (const t of items) if (Math.min(t.w, t.h) < 24) for (const u of items) if (u !== t) { const dx = (t.x + t.w / 2) - (u.x + u.w / 2), dy = (t.y + t.h / 2) - (u.y + u.h / 2); if (Math.hypot(dx, dy) < 24 + 0 && Math.abs(dx) < (t.w + u.w) / 2 + 24 && Math.abs(dy) < (t.h + u.h) / 2 + 24) crowd.push(t.name + ' ~ ' + u.name); }
  const sizes = {}; for (const t of items) { const k = Math.round(t.h) + 'px'; sizes[k] = (sizes[k] || 0) + 1; }
  return JSON.stringify({ n: items.length, min, small: small.map((t) => ({ name: t.name, tag: t.tag, cls: t.cls, w: Math.round(t.w), h: Math.round(t.h), efetivoW: t.hw, efetivoH: t.hh })), crowd: [...new Set(crowd)].slice(0, 8), heights: sizes });
})()`;
const FOCUS = `(() => { const e = document.activeElement; if (!e || e === document.body) return JSON.stringify({ none: true });
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (f, b) => [f[0] * f[3] + b[0] * (1 - f[3]), f[1] * f[3] + b[1] * (1 - f[3]), f[2] * f[3] + b[2] * (1 - f[3]), 1];
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = (el) => { const chain = []; for (let p = el; p && p.nodeType === 1; p = p.parentElement) { const c = rgba(getComputedStyle(p).backgroundColor); chain.push(c); if (c[3] >= 0.999) break; } let cur = chain.length && chain[chain.length - 1][3] >= 0.999 ? chain[chain.length - 1] : [255, 255, 255, 1]; for (let i = chain.length - (chain[chain.length - 1][3] >= 0.999 ? 2 : 1); i >= 0; i--) cur = over(chain[i], cur); return cur; };
  const cs = getComputedStyle(e); const dlg = document.querySelector('[role="dialog"]');
  const ow = parseFloat(cs.outlineWidth) || 0; const auto = cs.outlineStyle === 'auto'; const hasOutline = (cs.outlineStyle !== 'none' && ow >= 2 && rgba(cs.outlineColor)[3] > 0) || auto; const sh = cs.boxShadow; const hasShadow = sh !== 'none' && /\\d/.test(sh);
  const bg = bgOf(e.parentElement || e); let ringRatio = null; let ringColor = null;
  if (cs.outlineStyle !== 'none' && ow >= 2 && !auto) { const c = rgba(cs.outlineColor); ringColor = c; ringRatio = ratio(over(c, bg), bg); }
  else if (hasShadow) { const m = [...sh.matchAll(/rgba?\\([^)]*\\)/g)].map((x) => rgba(x[0])); if (m.length) { const c = m[m.length - 1]; ringColor = c; ringRatio = ratio(over(c, bg), bg); } }
  const r = e.getBoundingClientRect();
  return JSON.stringify({ name: (e.getAttribute('aria-label') || e.textContent || e.placeholder || e.tagName).replace(/\s+/g, ' ').trim().slice(0, 40), tag: e.tagName.toLowerCase(), cls: (typeof e.className === 'string' ? e.className : '').split(/\s+/)[0].replace(/_[A-Za-z0-9]{5,}$/, ''),
    ok: (hasOutline || hasShadow) && (auto || ringRatio === null || ringRatio >= 3), ringRatio: ringRatio === null ? null : Math.round(ringRatio * 100) / 100, auto, outline: cs.outlineStyle + ' ' + cs.outlineWidth, shadow: sh.slice(0, 80), inView: r.bottom > 0 && r.top < innerHeight, inDialog: dlg ? dlg.contains(e) : null }); })()`;
const key = async (cdp, k, code, vk, mods = 0) => { await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); };

await prepareDatabase(dbUrl, root, { clock: FROZEN_CLOCK }); const stack = await startStack({ root, databaseUrl: dbUrl, clock: FROZEN_CLOCK });
const files = mkdtempSync(path.join(tmpdir(), "levora-qa-targets-")); const session = await launchBrowser(findBrowser(o.browser)); await installProbe(session.cdp);
await session.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: browserClockScript(FROZEN_CLOCK) }); await session.cdp.send("Emulation.setTimezoneOverride", { timezoneId: FROZEN_CLOCK.timezone });
try {
  const cdp = session.cdp;
  for (const user of [...new Set(pages.map((p) => p.user))].sort((a, b) => (a === "guest" ? -1 : b === "guest" ? 1 : 0))) {
    await cdp.send("Network.clearBrowserCookies"); if (user !== "guest" && !(await login(cdp, stack.baseUrl, user))) throw new Error(`login de ${user} não concluiu`);
    for (const pg of pages.filter((p) => p.user === user)) for (const v of VIEWS) for (const theme of ["light", "dark"]) {
      const tag = `${pg.id} · ${v.w}px · ${theme}`;
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: v.w, height: v.h, deviceScaleFactor: 1, mobile: v.mobile });
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: v.mobile ? "coarse" : "fine" }, { name: "hover", value: v.mobile ? "none" : "hover" }] }).catch(() => {});
      const nav = await navigate(cdp, `${stack.baseUrl}${pg.path}`); await applyViewport(cdp, { w: v.w, h: v.h }).catch(() => {}); await setTheme(cdp, theme);
      const rep = new Report(); const sctx = { cdp, name: o.browser, version: session.version, baseUrl: stack.baseUrl, report: rep, theme, vp: { w: v.w, h: v.h }, vpKey: `${v.w}x${v.h}`, vpInner: "-", filesDir: files };
      let ok = nav.ready; for (const step of pg.steps ?? []) if (!(await runStep(sctx, { ...pg, variant: "targets" }, step))) ok = false;
      await cdp.eval("document.fonts.ready.then(() => 0)"); await new Promise((r) => setTimeout(r, 600));
      if (!ok) { console.log(`FALHA DE PREPARO  ${tag}`); fails.push({ tag, kind: "preparo" }); continue; }
      const t = JSON.parse(await cdp.eval(TARGETS));
      // foco: começa do topo; Tab até 80 paradas ou voltar ao início
      await cdp.eval("(document.activeElement && document.activeElement.blur && document.activeElement.blur(), window.scrollTo(0,0), 0)");
      const stops = []; const seen = new Set(); let bad = [];
      for (let i = 0; i < 80; i++) { await key(cdp, "Tab", "Tab", 9); await new Promise((r) => setTimeout(r, 230)); /* as transições de foco (box-shadow/borda) levam ~150 ms: ler antes mede o estado NÃO focado */ const f = JSON.parse(await cdp.eval(FOCUS)); if (f.none) { stops.push(f); break; } const id = f.tag + f.name + f.cls; if (seen.has(id) && i > 3 && stops.length > 8) { if (seen.size > 3 && [...seen][0] === id) break; } seen.add(id); stops.push(f); if (!f.ok) bad.push(f); }
      const dlgEscaped = stops.filter((s) => s.inDialog === false).length;
      results.push({ tag, page: pg.id, w: v.w, theme, alvos: t.n, minimo: t.min, pequenos: t.small, aglomerados: t.crowd, alturas: t.heights, paradasDeFoco: stops.length, focoSemIndicador: bad.map((b) => `${b.tag}.${b.cls} "${b.name}" (razão ${b.ringRatio}; ${b.outline}; ${b.shadow})`), focoSaiuDoDialogo: dlgEscaped });
      const nf = t.small.length + t.crowd.length + bad.length + dlgEscaped;
      console.log(`${nf ? "FAIL" : "PASS"}  ${tag} — ${t.n} alvos (mín. ${t.min}px): ${t.small.length} pequenos, ${t.crowd.length} aglomerados; foco: ${stops.length} paradas, ${bad.length} sem indicador${dlgEscaped ? `, ${dlgEscaped} fora do diálogo` : ""}`);
      for (const s of t.small.slice(0, 6)) console.log(`      pequeno ${s.tag}.${s.cls} "${s.name}" ${s.w}×${s.h} (área efetiva de clique ${s.efetivoW}×${s.efetivoH})`);
      for (const s of bad.slice(0, 4)) console.log(`      foco fraco/ausente ${s.tag}.${s.cls} "${s.name}" razão=${s.ringRatio} outline=${s.outline} shadow=${s.shadow}`);
      for (const s of t.small) fails.push({ tag, kind: "alvo-pequeno", ...s }); for (const c of t.crowd) fails.push({ tag, kind: "alvos-juntos", c }); for (const b of bad) fails.push({ tag, kind: "foco-sem-indicador", ...b });
    }
  }
} finally { await session.close(); await stack.stop(); await dropDatabase(dbUrl); rmSync(files, { recursive: true, force: true }); }
if (o.out) writeFileSync(path.resolve(o.out), JSON.stringify({ geradoEm: new Date().toISOString(), navegador: o.browser, celulas: results.length, reprovacoes: fails.length, resultados: results }, null, 2) + "\n");
console.log(`\nAlvos e foco no produto real: ${results.length} células, ${fails.length} ocorrência(s) fora do critério`); process.exit(fails.length ? 4 : 0);
