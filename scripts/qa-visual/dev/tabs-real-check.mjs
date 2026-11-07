#!/usr/bin/env node
// M04 (F05/F06/F09/F16): barra de abas da organização no PRODUTO REAL — uma linha só, aba ativa inteira dentro da área visível, alvo ≥ 44 px, mesmas abas em todas as páginas,
// mesma margem lateral e nenhum overflow horizontal da página. Uso: QA_DATABASE_URL=… node scripts/qa-visual/dev/tabs-real-check.mjs [--browser chrome|edge] [--out arquivo.json]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findBrowser, launchBrowser } from "../lib/browser.mjs";
import { startStack, prepareDatabase, dropDatabase } from "../lib/stack.mjs";
import { installProbe, login, navigate, applyViewport, setTheme } from "../lib/runner.mjs";
import { FROZEN_CLOCK, browserClockScript } from "../lib/clock.mjs";
import { QA_PASSWORD } from "../scenarios.mjs";
import { assertDisposableDatabase } from "../lib/guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { values: o } = parseArgs({ options: { browser: { type: "string", default: "chrome" }, out: { type: "string" } } });
const dbUrl = process.env.QA_DATABASE_URL; assertDisposableDatabase(dbUrl); process.env.QA_PASSWORD = QA_PASSWORD;
const PAGES = ["", "/inventario", "/necessidades", "/destinacoes", "/oportunidades", "/atribuicoes", "/prestacao-contas", "/matching", "/unidades", "/regularizacao"];
const results = []; const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`); };
const GEO = `(() => { const nav = document.querySelector('main nav, nav[class*="tabNav"], [class*="tabNav_"], [class*="_tabNav"]') || [...document.querySelectorAll('nav')].find((n) => n.querySelector('a[href*="/organizacoes/"]'));
  if (!nav) return JSON.stringify({ nav: false }); const items = [...nav.children]; const nb = nav.getBoundingClientRect(); const act = items.find((e) => e.tagName === 'SPAN');
  const ab = act ? act.getBoundingClientRect() : null; const ys = [...new Set(items.map((e) => Math.round(e.getBoundingClientRect().y)))];
  const page = nav.parentElement; const pr = page.getBoundingClientRect(); const cs = getComputedStyle(page);
  return JSON.stringify({ nav: true, labels: items.map((e) => e.textContent.trim().replace(/[0-9]+$/, "")), rows: ys.length, navX: Math.round(nb.x), navR: Math.round(nb.right), act: ab ? { x: Math.round(ab.x), r: Math.round(ab.right), h: Math.round(ab.height), t: act.textContent.trim() } : null,
    minH: Math.round(Math.min(...items.map((e) => e.getBoundingClientRect().height))), scroll: nav.scrollWidth > nav.clientWidth, docOverflow: document.documentElement.scrollWidth > innerWidth, padL: cs.paddingLeft, vw: innerWidth }); })()`;

await prepareDatabase(dbUrl, root, { clock: FROZEN_CLOCK }); const stack = await startStack({ root, databaseUrl: dbUrl, clock: FROZEN_CLOCK });
const files = mkdtempSync(path.join(tmpdir(), "levora-qa-tabs-")); const session = await launchBrowser(findBrowser(o.browser)); await installProbe(session.cdp);
await session.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: browserClockScript(FROZEN_CLOCK) }); await session.cdp.send("Emulation.setTimezoneOverride", { timezoneId: FROZEN_CLOCK.timezone });
try {
  const cdp = session.cdp; if (!(await login(cdp, stack.baseUrl, "owner"))) throw new Error("login do proprietário não concluiu");
  const first = {};
  for (const v of [{ w: 375, h: 812, mobile: true }, { w: 1280, h: 900, mobile: false }]) for (const theme of ["light", "dark"]) {
    for (const p of PAGES) {
      const tag = `${v.w}px · ${theme} · /organizacoes/1${p}`;
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: v.w, height: v.h, deviceScaleFactor: 1, mobile: v.mobile });
      const nav = await navigate(cdp, `${stack.baseUrl}/organizacoes/1${p}`); await applyViewport(cdp, { w: v.w, h: v.h }).catch(() => {}); await setTheme(cdp, theme);
      await cdp.eval("document.fonts.ready.then(() => 0)"); await new Promise((r) => setTimeout(r, 700));
      const g = JSON.parse(await cdp.eval(GEO));
      if (!nav.ready || !g.nav) { check(`${tag}: barra de abas presente`, false, `nav=${nav.ready}/${g.nav}`); continue; }
      check(`${tag}: UMA linha só (todas as abas no mesmo y)`, g.rows === 1, `linhas=${g.rows}`);
      check(`${tag}: aba ativa "${g.act?.t}" inteira dentro da área visível da barra`, !!g.act && g.act.x >= g.navX - 1 && g.act.r <= g.navR + 1, JSON.stringify(g.act) + ` barra ${g.navX}..${g.navR}`);
      check(`${tag}: altura de toque ≥ 44 px em todas as abas`, g.minH >= 44, `menor=${g.minH}`);
      check(`${tag}: a página não tem rolagem horizontal`, !g.docOverflow, `overflow=${g.docOverflow}`);
      if (v.w === 1280) check(`${tag}: desktop — todas as abas cabem sem rolagem horizontal da barra (M05/N02)`, !g.scroll, `scrollWidth>clientWidth=${g.scroll}`);
      if (v.w === 375) check(`${tag}: margem lateral de 16 px`, g.padL === "16px", `padding-left=${g.padL}`);
      const key = `${v.w}`; if (!first[key]) first[key] = g.labels; else check(`${tag}: mesmo conjunto de abas das demais páginas`, JSON.stringify(first[key]) === JSON.stringify(g.labels), g.labels.join(" | ") + "  ESPERADO: " + first[key].join(" | "));
    }
  }
} finally { await session.close(); await stack.stop(); await dropDatabase(dbUrl); rmSync(files, { recursive: true, force: true }); }
const fails = results.filter((x) => !x.ok).length; if (o.out) writeFileSync(path.resolve(o.out), JSON.stringify({ geradoEm: new Date().toISOString(), navegador: o.browser, total: results.length, falhas: fails, resultados: results }, null, 2) + "\n");
console.log(`\nAbas no produto real: ${results.length - fails}/${results.length} como esperado`); process.exit(fails ? 4 : 0);
