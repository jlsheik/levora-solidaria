// Galeria HTML ESTÁTICA para revisão humana das baselines (sem dependências externas, sem rede): páginas → viewport → tema → Chrome | Edge | diferença Chrome×Edge,
// com metadados, hash, configuração e os POSSÍVEIS problemas apontados por lib/review.mjs. Deixa claro que as imagens estão AGUARDANDO APROVAÇÃO e a ORIGEM
// (produto real × app-fixture de demonstração). Gerar a galeria NUNCA aprova nada.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BASELINE_STATE, loadManifest, sha256 } from "./baseline.mjs";
import { decodePng, encodePng } from "./png.mjs";
import { analyzeCandidate, crossBrowser, vpWidth } from "./review.mjs";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const THEMES = ["light", "dark"]; const BROWSERS = ["chrome", "edge"];
const SEV = { high: 0, medium: 1, info: 2 };

function pick(entries) { // por célula: a APROVADA vale; senão, a candidata mais recente; SUPERSEDED fica de fora
  const by = new Map();
  for (const e of entries) {
    if (e.state === BASELINE_STATE.SUPERSEDED) continue; const cur = by.get(e.id);
    if (!cur || (e.state === BASELINE_STATE.APPROVED && cur.state !== BASELINE_STATE.APPROVED) || (e.state === cur.state && String(e.capturedAt) > String(cur.capturedAt))) by.set(e.id, e);
  }
  return [...by.values()];
}

/** Lê as baselines, confere os hashes, analisa, copia as imagens para outDir/img e calcula Chrome×Edge (imagens de diferença em outDir/diff). */
export function buildGalleryModel({ baselineDir, outDir, sourceKind, title = "Revisão das baselines visuais", pageOrder = [] }) {
  if (!["produto", "fixture"].includes(sourceKind)) throw new Error("sourceKind precisa ser 'produto' ou 'fixture' (a galeria não pode deixar dúvida sobre a origem das imagens)");
  const manifest = loadManifest(baselineDir); const chosen = pick(manifest.entries); const cells = [];
  mkdirSync(path.join(outDir, "img"), { recursive: true }); mkdirSync(path.join(outDir, "diff"), { recursive: true });
  const imgs = new Map();
  for (const e of chosen) {
    const cell = { id: e.id, pageId: e.pageId, browser: e.browser, browserVersion: e.browserVersion, viewport: e.viewport, theme: e.theme, state: e.state, route: e.route, sourceSha: e.sourceSha, capturedAt: e.capturedAt, captureConfigVersion: e.captureConfigVersion, sha256: e.imageSha256, width: e.width, height: e.height, approvedBy: e.approvedBy ?? null, issues: [], error: null };
    try {
      const buf = readFileSync(path.join(baselineDir, e.file)); if (sha256(buf) !== e.imageSha256) throw new Error("SHA-256 do PNG não confere com o manifesto");
      const image = decodePng(buf); imgs.set(e.id, image);
      let fingerprint = null; if (e.fingerprintFile) { const t = readFileSync(path.join(baselineDir, e.fingerprintFile)); if (e.fingerprintSha256 && sha256(t) !== e.fingerprintSha256) throw new Error("SHA-256 da impressão de layout não confere"); fingerprint = JSON.parse(t.toString("utf8")); }
      cell.issues = analyzeCandidate({ meta: { viewport: e.viewport, theme: e.theme, truncatedHeight: e.truncatedHeight ?? (e.height >= 3200) }, fingerprint, image }).sort((x, y) => SEV[x.severity] - SEV[y.severity]);
      if (e.dynamicText?.count) cell.issues.push({ kind: "dynamic-text-normalized", severity: "info", detail: `${e.dynamicText.count} texto(s) de data/hora normalizado(s) para dígitos 0 (regiões exatas no manifesto): os VALORES de data/hora não foram verificados visualmente nesta imagem` });
      cell.img = `img/${e.id}.${e.imageSha256.slice(0, 12)}.png`; copyFileSync(path.join(baselineDir, e.file), path.join(outDir, cell.img));
    } catch (err) { cell.error = err.message; cell.issues = [{ kind: "unreadable", severity: "high", detail: `imagem/metadado ilegível: ${err.message}` }]; }
    cells.push(cell);
  }
  const byKey = new Map(cells.map((c) => [`${c.pageId}|${c.viewport}|${c.theme}|${c.browser}`, c]));
  const pairs = [];
  for (const c of cells) {
    if (c.browser !== "chrome") continue; const e = byKey.get(`${c.pageId}|${c.viewport}|${c.theme}|edge`); if (!e || c.error || e.error) continue;
    const x = crossBrowser(imgs.get(c.id), imgs.get(e.id)); const rec = { chromeId: c.id, edgeId: e.id, verdict: x.verdict, diffPixels: x.diffPixels, diffRatio: x.diffRatio, shape: x.shape, bbox: x.bbox };
    if (x.verdict !== "IDENTICAL") { rec.diff = `diff/${c.pageId}__${c.viewport}__${c.theme}__chrome-x-edge.png`; writeFileSync(path.join(outDir, rec.diff), encodePng(x.diffImage)); }
    pairs.push(rec);
  }
  const pageIds = [...new Set(cells.map((c) => c.pageId))].sort((a, b) => { const ia = pageOrder.indexOf(a), ib = pageOrder.indexOf(b); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b); });
  const sevCount = { high: 0, medium: 0, info: 0 }; for (const c of cells) for (const i of c.issues) sevCount[i.severity]++;
  return { title, sourceKind, generatedAt: new Date().toISOString(), baselineDir: path.basename(baselineDir), cells, pairs, pageIds,
    summary: { total: cells.length, candidates: cells.filter((c) => c.state === "CANDIDATE").length, approved: cells.filter((c) => c.state === "APPROVED").length, cellsWithHigh: cells.filter((c) => c.issues.some((i) => i.severity === "high")).length, issues: sevCount, crossBrowserDifferent: pairs.filter((p) => p.verdict !== "IDENTICAL").length, crossBrowserPairs: pairs.length } };
}

const CSS = `body{font-family:Arial,Helvetica,sans-serif;margin:0;background:#f4f4f5;color:#18181b}header,.banner{padding:12px 20px}h1{margin:0 0 4px;font-size:22px}h2{margin:28px 20px 6px;font-size:19px;border-bottom:2px solid #d4d4d8;padding-bottom:4px}h3{margin:14px 20px 4px;font-size:15px;color:#3f3f46}
.banner{font-weight:700}.b-wait{background:#fde68a;color:#78350f}.b-fix{background:#ddd6fe;color:#3b0764}.b-ok{background:#bbf7d0;color:#14532d}main{padding-bottom:40px}.sum{padding:8px 20px;font-size:14px}.sum code{background:#e4e4e7;padding:1px 4px;border-radius:3px}
.row{display:flex;gap:12px;padding:0 20px;align-items:flex-start;flex-wrap:wrap}.cell{background:#fff;border:1px solid #d4d4d8;border-radius:8px;padding:8px;flex:1 1 320px;max-width:560px}.cell img{max-width:100%;border:1px solid #e4e4e7;display:block}
.cell.bad{border-color:#dc2626;border-width:2px}.cell.warn{border-color:#f59e0b}.meta{font-size:12px;color:#52525b;margin:4px 0}.badge{display:inline-block;font-size:11px;font-weight:700;padding:1px 6px;border-radius:9px;margin-right:6px}
.CANDIDATE{background:#fef3c7;color:#92400e}.APPROVED{background:#dcfce7;color:#166534}.sev-high{color:#b91c1c;font-weight:700}.sev-medium{color:#b45309}.sev-info{color:#52525b}ul.issues{margin:4px 0 4px 18px;padding:0;font-size:12px}
details{font-size:12px;margin-top:4px}pre{white-space:pre-wrap;word-break:break-all;background:#f4f4f5;padding:6px;margin:4px 0}.nav{padding:8px 20px;font-size:14px}.nav a{margin-right:10px}label.f{font-size:14px;margin-left:20px}.cell.ok.hide{display:none}`;

function cellHtml(c, pairs) {
  const sev = c.issues.some((i) => i.severity === "high") ? "bad" : c.issues.some((i) => i.severity === "medium") ? "warn" : "ok";
  const cmd = `node scripts/qa-visual/visual.mjs approve --id ${c.id} --sha256 ${c.sha256} --reviewer "<NOME DO REVISOR>" --yes`;
  return `<div class="cell ${sev}" id="${esc(c.id)}">${c.img ? `<a href="${esc(c.img)}"><img loading="lazy" src="${esc(c.img)}" alt="${esc(c.id)}"></a>` : `<p class="sev-high">sem imagem: ${esc(c.error)}</p>`}
<div class="meta"><span class="badge ${esc(c.state)}">${esc(c.state)}</span><b>${esc(c.browser)}</b> ${esc(c.browserVersion)} · ${esc(c.viewport)} · ${esc(c.theme)} · ${esc(c.width)}×${esc(c.height)} px${c.approvedBy ? ` · aprovada por ${esc(c.approvedBy)}` : " · <b>aguardando aprovação</b>"}</div>
${c.issues.length ? `<ul class="issues">${c.issues.map((i) => `<li class="sev-${esc(i.severity)}">[${esc(i.severity)}] ${esc(i.kind)}: ${esc(i.detail)}</li>`).join("")}</ul>` : `<div class="meta">nenhum problema automático apontado (isso não substitui a sua inspeção)</div>`}
<details><summary>metadados e como aprovar</summary><pre>id: ${esc(c.id)}\nrota: ${esc(c.route)}\nsha256: ${esc(c.sha256)}\nSHA testado: ${esc(c.sourceSha)}\ncapturada em: ${esc(c.capturedAt)}\nconfig de captura: ${esc(c.captureConfigVersion)}\n\nSÓ depois de examinar esta imagem:\n${esc(cmd)}</pre></details></div>`;
}

export function renderGalleryHtml(m) {
  const wait = m.summary.approved === 0;
  const banners = `${m.sourceKind === "fixture" ? `<div class="banner b-fix">DEMONSTRAÇÃO COM APP-FIXTURE: estas imagens NÃO são do produto LEVORA SOLIDÁRIA e não servem de baseline do produto.</div>` : ""}<div class="banner ${wait ? "b-wait" : "b-ok"}">${wait ? `NÃO HOMOLOGADO: ${m.summary.candidates} imagem(ns) AGUARDANDO APROVAÇÃO HUMANA. Nenhuma está aprovada. Ver esta galeria não aprova nada.` : `${m.summary.approved} aprovada(s), ${m.summary.candidates} candidata(s) aguardando aprovação.`}</div>`;
  const nav = m.pageIds.map((p) => `<a href="#p-${esc(p)}">${esc(p)}</a>`).join("");
  const sum = `<div class="sum">${m.summary.total} célula(s) · <b>${m.summary.cellsWithHigh}</b> com problema provável (high) · problemas: high ${m.summary.issues.high}, medium ${m.summary.issues.medium}, info ${m.summary.issues.info} · Chrome×Edge diferentes: <b>${m.summary.crossBrowserDifferent}</b> de ${m.summary.crossBrowserPairs} par(es) · gerada em ${esc(m.generatedAt)} · origem <code>${esc(m.sourceKind)}</code></div>`;
  const sections = m.pageIds.map((pid) => {
    const cells = m.cells.filter((c) => c.pageId === pid); const vps = [...new Set(cells.map((c) => c.viewport))].sort((a, b) => vpWidth(a) - vpWidth(b));
    const body = vps.map((vp) => THEMES.map((th) => {
      const row = BROWSERS.map((b) => cells.find((c) => c.viewport === vp && c.theme === th && c.browser === b)).filter(Boolean); if (!row.length) return "";
      const chrome = row.find((c) => c.browser === "chrome"), edge = row.find((c) => c.browser === "edge"); const pr = chrome && edge ? m.pairs.find((p) => p.chromeId === chrome.id && p.edgeId === edge.id) : null;
      const cmp = pr ? `<div class="cell ${pr.verdict === "IDENTICAL" ? "ok" : "warn"}"><b>Chrome × Edge</b><div class="meta">${pr.verdict === "IDENTICAL" ? "pixels idênticos entre os navegadores" : `${esc(pr.verdict)}: ${esc(pr.diffPixels)} px diferentes (${esc(((pr.diffRatio ?? 0) * 100).toFixed(3))}%), forma ${esc(pr.shape)}`}</div>${pr.diff ? `<a href="${esc(pr.diff)}"><img loading="lazy" src="${esc(pr.diff)}" alt="diferença Chrome×Edge"></a>` : ""}</div>` : "";
      return `<h3>${esc(vp)} · tema ${th === "light" ? "claro" : "escuro"}</h3><div class="row">${row.map((c) => cellHtml(c, m.pairs)).join("")}${cmp}</div>`;
    }).join("")).join("");
    return `<h2 id="p-${esc(pid)}">${esc(pid)} <small>(${esc(cells[0]?.route ?? "")})</small></h2>${body}`;
  }).join("");
  const js = `document.getElementById('so').addEventListener('change',function(e){document.querySelectorAll('.cell.ok').forEach(function(n){n.classList.toggle('hide',e.target.checked)})});`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(m.title)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body><header><h1>${esc(m.title)}</h1></header>${banners}${sum}<div class="nav">${nav}<label class="f"><input type="checkbox" id="so"> mostrar só células com problema</label></div><main>${sections}</main><script>${js}</script></body></html>`;
}

/** Gera a galeria completa em outDir (index.html, gallery.json, img/, diff/, GALLERY-SHA256.txt). */
export function buildGallery(opts) {
  const model = buildGalleryModel(opts); writeFileSync(path.join(opts.outDir, "index.html"), renderGalleryHtml(model));
  writeFileSync(path.join(opts.outDir, "gallery.json"), JSON.stringify(model, null, 2) + "\n");
  const files = []; const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); statSync(p).isDirectory() ? walk(p) : n !== "GALLERY-SHA256.txt" && files.push(p); } }; walk(opts.outDir);
  writeFileSync(path.join(opts.outDir, "GALLERY-SHA256.txt"), files.sort().map((p) => `${sha256(readFileSync(p))}  ${path.relative(opts.outDir, p).split(path.sep).join("/")}`).join("\n") + "\n");
  return model;
}
