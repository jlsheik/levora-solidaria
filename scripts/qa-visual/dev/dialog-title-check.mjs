#!/usr/bin/env node
// M06 (Fase F): comportamento do TÍTULO do diálogo (componentes REAIS de produção, via harness sem banco) sob o botão X.
// Mede, em Chrome/Edge × claro/escuro × viewports (inclui zoom 200% e 400% por viewport estreito + DPR) × títulos (curto, médio, longo, palavra extensa,
// quebra explícita): sobreposição título×X (texto real, linha a linha, e área efetiva de clique do X), estouro horizontal, altura do cabeçalho, alinhamento,
// visibilidade do X (elementFromPoint), nome acessível, rótulo do diálogo, Tab até o X com anel visível e Esc.
// Uso: node scripts/qa-visual/dev/dialog-title-check.mjs [--browser chrome|edge] [--out arquivo.json]   (exit 0 = tudo conforme; 4 = reprovações)
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findBrowser, launchBrowser, killTree } from "../lib/browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { values: o } = parseArgs({ options: { browser: { type: "string", default: "chrome" }, out: { type: "string" } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); });

const TITLES = [
  { id: "curto", t: "Editar" },
  { id: "medio", t: "Registrar recebimento de doação sintética" },
  { id: "longo", t: "Registrar recebimento da doação de cestas básicas, cobertores, kits escolares e itens de higiene pessoal para as famílias atendidas pela associação no bairro" },
  { id: "palavra-extensa", t: "Supercalifragilisticoespialidosoincrivelmenteextensoparaverificarquebra_de_palavra_em_diálogo_estreito_00000" },
  { id: "quebra-explicita", t: "Primeira linha do título|Segunda linha do título|Terceira" },
  { id: "extenso-sem-espaco", t: "Identificador-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789" },
];
// zoom 200%/400% = viewport CSS de 640/320 px de largura (o que o navegador entrega a 200%/400% de zoom em 1280 px) com DPR 2/4
const VIEWS = [{ id: "1280", w: 1280, h: 900, dpr: 1, mobile: false }, { id: "1024x480", w: 1024, h: 480, dpr: 1, mobile: false }, { id: "375", w: 375, h: 812, dpr: 1, mobile: true }, { id: "320", w: 320, h: 568, dpr: 1, mobile: true }, { id: "zoom200", w: 640, h: 450, dpr: 2, mobile: false }, { id: "zoom400", w: 320, h: 225, dpr: 4, mobile: false }];

const MEASURE = `(() => {
  const d = document.querySelector('[role="dialog"]'); if (!d) return JSON.stringify({ open: false });
  const t = d.querySelector('h2'); const close = [...d.querySelectorAll('button')].find((b) => /fechar|close/i.test(b.textContent));
  const R = (r) => ({ x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom });
  const dr = d.getBoundingClientRect(); const cr = close.getBoundingClientRect();
  const range = document.createRange(); range.selectNodeContents(t); const lines = [...range.getClientRects()].filter((r) => r.width > 0.5).map(R);
  const hit = { x: cr.x - 7, y: cr.y - 7, r: cr.right + 7, b: cr.bottom + 7 }; // área efetiva (::after inset -0.4375rem)
  const inter = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.y, b.y));
  const vis = { x: cr.x, y: cr.y, r: cr.right, b: cr.bottom };
  const overlapVisual = lines.reduce((s, l) => s + inter(l, vis), 0); const overlapHit = lines.reduce((s, l) => s + inter(l, hit), 0);
  const cx = cr.x + cr.width / 2, cy = cr.y + cr.height / 2; const top = document.elementFromPoint(cx, cy); const closeOnTop = !!top && (top === close || close.contains(top));
  const tr = t.getBoundingClientRect(); const cs = getComputedStyle(d);
  const textRight = lines.length ? Math.max(...lines.map((l) => l.r)) : 0; const textLeft = lines.length ? Math.min(...lines.map((l) => l.x)) : 0;
  const header = t.closest('[class*="_header_"]') || t.parentElement; const hr = header.getBoundingClientRect();
  return JSON.stringify({ open: true, vw: innerWidth, vh: innerHeight, dlg: R(dr), close: R(cr), title: R(tr), lines: lines.length, overlapVisual: Math.round(overlapVisual), overlapHit: Math.round(overlapHit), closeOnTop,
    hOverflow: d.scrollWidth - d.clientWidth, textRightGap: Math.round(dr.right - textRight), textLeft: Math.round(textLeft - dr.x), closeInsideDialog: cr.x >= dr.x && cr.right <= dr.right && cr.y >= dr.y && cr.bottom <= dr.bottom, closeInViewport: cr.x >= 0 && cr.y >= 0 && cr.right <= innerWidth && cr.bottom <= innerHeight,
    headerH: Math.round(hr.height), titleFont: cs.fontSize ? getComputedStyle(t).fontSize : '', titleFamily: getComputedStyle(t).fontFamily.slice(0, 20), closeName: (close.textContent || '').trim(), labelledby: d.getAttribute('aria-labelledby'), titleId: t.id, titleClipped: t.scrollWidth > t.clientWidth + 1, confirmRect: (() => { const b = [...d.querySelectorAll('button')].find((x) => /salvar/i.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { y: Math.round(r.y), b: Math.round(r.bottom) }; })(), confirmVisible: (() => { const b = [...d.querySelectorAll('button')].find((x) => /salvar/i.test(x.textContent)); if (!b) return false; const r = b.getBoundingClientRect(); return r.y >= 0 && r.bottom <= innerHeight && r.x >= 0 && r.right <= innerWidth; })() });
})()`;

const port = await freePort();
const vite = spawn(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "--config", path.join("scripts", "qa-visual", "vite.config.ts"), "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: root, env: { ...process.env, QA_API_PORT: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let ready = false; vite.stdout.on("data", (d) => { if (/Local:|ready in/i.test(String(d))) ready = true; }); vite.stderr.on("data", () => {});
for (let i = 0; i < 120 && !ready; i++) await sleep(250);
const exe = findBrowser(o.browser); if (!exe) { console.error(`navegador ${o.browser} indisponível`); killTree(vite); process.exit(3); }
const results = []; const fails = []; let session;
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); if (!ok) fails.push(name); console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`); };
try {
  if (!ready) throw new Error("Vite do harness não subiu");
  session = await launchBrowser(exe); const { cdp } = session;
  for (const theme of ["light", "dark"]) for (const v of VIEWS) for (const T of TITLES) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: v.w, height: v.h, deviceScaleFactor: v.dpr, mobile: v.mobile });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/scripts/qa-visual/dev/harness-dialog/index.html?theme=${theme}&title=${encodeURIComponent(T.t)}` });
    let m = null; for (let i = 0; i < 80; i++) { await sleep(150); const s = await cdp.eval(MEASURE).catch(() => null); if (s) { const j = JSON.parse(s); if (j.open) { await sleep(700); m = JSON.parse(await cdp.eval(MEASURE)); break; } } }
    const tag = `${T.id} · ${v.id} · ${theme}`;
    if (!m) { check(`${tag}: diálogo abriu`, false, "não abriu"); continue; }
    check(`${tag}: texto do título não encosta no botão X visível`, m.overlapVisual === 0, `sobreposição=${m.overlapVisual}px² linhas=${m.lines}`);
    check(`${tag}: texto do título não invade a área efetiva de clique do X`, m.overlapHit === 0, `sobreposição=${m.overlapHit}px²`);
    check(`${tag}: X é o elemento no topo do seu centro (clicável)`, m.closeOnTop, "elementFromPoint");
    check(`${tag}: X dentro do diálogo e da viewport`, m.closeInsideDialog && m.closeInViewport, `dentro=${m.closeInsideDialog} viewport=${m.closeInViewport}`);
    check(`${tag}: sem rolagem horizontal no diálogo (título não estoura)`, m.hOverflow <= 0, `scrollWidth−clientWidth=${m.hOverflow}`);
    check(`${tag}: título não é cortado dentro do próprio elemento`, !m.titleClipped, `titleClipped=${m.titleClipped}`);
    check(`${tag}: texto do título fica dentro do diálogo (folga à direita ≥ 0)`, m.textRightGap >= 0 && m.textLeft >= 0, `folgaDireita=${m.textRightGap} esquerda=${m.textLeft}`);
    check(`${tag}: diálogo rotulado pelo título e X com nome acessível`, m.labelledby && m.labelledby === m.titleId && /fechar/i.test(m.closeName), `labelledby=${m.labelledby} título=${m.titleId} nome="${m.closeName}"`);
    check(`${tag}: botão de confirmar visível sem rolar (rodapé fixo alcançável)`, m.confirmVisible, `confirmar=${JSON.stringify(m.confirmRect)} vh=${m.vh} cabeçalho=${m.headerH}px`);
    if (T.id === "longo" || T.id === "curto") {
      // teclado: Tab percorre os controles; o X precisa receber foco com anel visível; Esc fecha
      let reached = false, ring = false; for (let i = 0; i < 6 && !reached; i++) { await cdp.key("Tab"); await sleep(260); const f = JSON.parse(await cdp.eval(`(() => { const e = document.activeElement; if (!e) return JSON.stringify({}); const cs = getComputedStyle(e); return JSON.stringify({ isClose: /fechar|close/i.test(e.textContent || ''), shadow: cs.boxShadow, outline: cs.outlineStyle + ' ' + cs.outlineWidth }); })()`)); if (f.isClose) { reached = true; ring = (f.shadow && f.shadow !== "none") || (f.outline && !/^none/.test(f.outline)); } }
      check(`${tag}: Tab alcança o X com indicador de foco visível`, reached && ring, `alcançou=${reached} anel=${ring}`);
      await cdp.key("Escape"); await sleep(400); const still = await cdp.eval("!!document.querySelector('[role=\"dialog\"]')");
      check(`${tag}: Esc fecha o diálogo`, !still, still ? "continuou aberto" : "fechou");
    }
  }
} catch (e) { check("execução", false, e.message); }
finally { if (session) await session.close(); killTree(vite); }
console.log(`\nTítulo do diálogo: ${results.length - fails.length}/${results.length} como esperado`);
if (o.out) writeFileSync(o.out, JSON.stringify({ navegador: o.browser, total: results.length, falhas: fails, resultados: results }, null, 2));
process.exit(fails.length ? 4 : 0);
