#!/usr/bin/env node
// M04 (Fase F): verifica os DIÁLOGOS no PRODUTO REAL, não só a imagem: geometria na viewport, rodapé alcançável, rolagem interna, overlay, foco/Tab/Esc e alvo do botão de fechar.
// Uso: QA_DATABASE_URL=… node scripts/qa-visual/dev/modal-real-check.mjs [--browser chrome|edge] [--out arquivo.json]   (exit 0 = todos os critérios atendidos)
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
import { SCENARIOS, QA_PASSWORD } from "../scenarios.mjs";
import { assertDisposableDatabase } from "../lib/guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { values: o } = parseArgs({ options: { browser: { type: "string", default: "chrome" }, out: { type: "string" } } });
const dbUrl = process.env.QA_DATABASE_URL; assertDisposableDatabase(dbUrl); process.env.QA_PASSWORD = QA_PASSWORD;
const DIALOGS = [{ id: "dropzone-title", nome: "Registrar recebimento (Atribuições)" }, { id: "needs-edit-dialog-title", nome: "Editar necessidade" }];
const VIEWS = [{ w: 1280, h: 900, mobile: false }, { w: 375, h: 812, mobile: true }, { w: 360, h: 520, mobile: true }, { w: 1024, h: 480, mobile: false }]; // inclui viewports BAIXOS (celular pequeno e paisagem)
const results = []; const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`); };
const GEO = `(() => { const d = document.querySelector('[role="dialog"]'); if (!d) return JSON.stringify({ open: false });
  const r = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), b: Math.round(b.bottom), r: Math.round(b.right) }; };
  const btns = [...d.querySelectorAll('button')]; const submit = btns.find((b) => b.type === 'submit') || btns.filter((b) => !b.getAttribute('aria-label') && !/close|fechar/i.test(b.textContent + b.className)).pop();
  const close = btns.find((b) => /close|fechar/i.test(b.getAttribute('aria-label') || '') || /close/i.test(b.className)); const ov = document.querySelector('[class*="_overlay_"]');
  const cs = getComputedStyle(d); const sub = submit ? r(submit) : null; let reach = null;
  if (submit) { const s = submit.getBoundingClientRect(); const el = document.elementFromPoint(s.x + s.width / 2, s.y + s.height / 2); reach = !!el && (el === submit || submit.contains(el) || (submit.disabled && d.contains(el))); /* botão desabilitado (formulário intocado) não recebe o ponto: vale se nada de FORA do diálogo o cobre */ }
  return JSON.stringify({ open: true, vw: innerWidth, vh: innerHeight, dlg: r(d), sub, subText: submit ? submit.textContent.trim() : null, reach, close: close ? r(close) : null, overlay: ov ? r(ov) : null, scrollH: d.scrollHeight, clientH: d.clientHeight, overflowY: cs.overflowY, maxH: cs.maxHeight,
    footer: (() => { const f = d.querySelector('[class*="_footer_"]'); if (!f) return null; const fs = getComputedStyle(f); return { ...r(f), position: fs.position }; })() }); })()`;

await prepareDatabase(dbUrl, root, { clock: FROZEN_CLOCK }); const stack = await startStack({ root, databaseUrl: dbUrl, clock: FROZEN_CLOCK });
const files = mkdtempSync(path.join(tmpdir(), "levora-qa-modal-")); const session = await launchBrowser(findBrowser(o.browser)); await installProbe(session.cdp);
await session.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: browserClockScript(FROZEN_CLOCK) }); await session.cdp.send("Emulation.setTimezoneOverride", { timezoneId: FROZEN_CLOCK.timezone });
try {
  const cdp = session.cdp; if (!(await login(cdp, stack.baseUrl, "owner"))) throw new Error("login do proprietário não concluiu");
  for (const dlg of DIALOGS) {
    const sc = SCENARIOS.find((s) => s.id === dlg.id);
    for (const v of VIEWS) for (const theme of ["light", "dark"]) {
      const tag = `${dlg.nome} · ${v.w}×${v.h} · ${theme}`;
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: v.w, height: v.h, deviceScaleFactor: 1, mobile: v.mobile });
      const nav = await navigate(cdp, `${stack.baseUrl}${sc.path}`); await applyViewport(cdp, { w: v.w, h: v.h }).catch(() => {}); await setTheme(cdp, theme);
      const rep = new Report(); const sctx = { cdp, name: o.browser, version: session.version, baseUrl: stack.baseUrl, report: rep, theme, vp: { w: v.w, h: v.h }, vpKey: `${v.w}x${v.h}`, vpInner: "-", filesDir: files };
      let opened = true; for (const step of sc.steps ?? []) if (!(await runStep(sctx, { ...sc, variant: "modal" }, step))) opened = false;
      await new Promise((r) => setTimeout(r, 400));
      const g = JSON.parse(await cdp.eval(GEO)); if (!nav.ready || !opened || !g.open) { check(`${tag}: diálogo abriu`, false, `nav=${nav.ready} passos=${opened} aberto=${g.open}`); continue; }
      const d = g.dlg, vh = g.vh, vw = g.vw;
      check(`${tag}: o diálogo cabe na viewport (topo/base/laterais visíveis)`, d.y >= 0 && d.b <= vh && d.x >= 0 && d.r <= vw, `dlg y=${d.y}..${d.b} de ${vh}; x=${d.x}..${d.r} de ${vw}`);
      check(`${tag}: centralizado (desvio ≤ 2 px em cada eixo)`, Math.abs((d.x + d.r) / 2 - vw / 2) <= 2 && Math.abs((d.y + d.b) / 2 - vh / 2) <= 2, `centro ${(d.x + d.r) / 2},${(d.y + d.b) / 2} esperado ${vw / 2},${vh / 2}`);
      check(`${tag}: overlay cobre a viewport inteira`, !!g.overlay && g.overlay.x <= 0 && g.overlay.y <= 0 && g.overlay.r >= vw && g.overlay.b >= vh, JSON.stringify(g.overlay));
      check(`${tag}: ação de confirmar visível SEM rolar e alcançável (nenhum elemento por cima)`, !!g.sub && g.sub.y >= d.y && g.sub.b <= d.b && g.sub.b <= vh && g.reach === true, `botão "${g.subText}" y=${g.sub?.y}..${g.sub?.b} alcançável=${g.reach}`);
      if (g.scrollH > g.clientH + 1) check(`${tag}: conteúdo mais alto que o diálogo → rolagem INTERNA (overflow auto) e rodapé fixo (sticky)`, ["auto", "scroll"].includes(g.overflowY) && g.footer?.position === "sticky", `scroll ${g.scrollH}>${g.clientH} overflowY=${g.overflowY} rodapé=${JSON.stringify(g.footer)}`);
      if (g.close) check(`${tag}: botão fechar com alvo ≥ 32 px dentro do diálogo`, g.close.w >= 32 && g.close.h >= 32 && g.close.x >= d.x && g.close.r <= d.r, JSON.stringify(g.close));
      // teclado: Tab fica preso no diálogo; Esc fecha
      let escaped = false; for (let i = 0; i < 40 && !escaped; i++) { await cdp.key?.("Tab"); await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }); escaped = !(await cdp.eval("!!document.activeElement && !!document.activeElement.closest('[role=\"dialog\"]')")); }
      check(`${tag}: foco por Tab permanece dentro do diálogo (40 Tabs)`, !escaped, escaped ? "o foco saiu do diálogo" : "preso corretamente");
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await new Promise((r) => setTimeout(r, 400)); const closed = !(JSON.parse(await cdp.eval(GEO)).open);
      check(`${tag}: Esc fecha o diálogo`, closed, closed ? "fechou" : "continuou aberto");
    }
  }
} finally { await session.close(); await stack.stop(); await dropDatabase(dbUrl); rmSync(files, { recursive: true, force: true }); }
const fails = results.filter((x) => !x.ok).length; if (o.out) writeFileSync(path.resolve(o.out), JSON.stringify({ geradoEm: new Date().toISOString(), navegador: o.browser, total: results.length, falhas: fails, resultados: results }, null, 2) + "\n");
console.log(`\nDiálogos no produto real: ${results.length - fails}/${results.length} como esperado`); process.exit(fails ? 4 : 0);
