// Revisão assistida das candidatas (módulo puro, testado): aponta POSSÍVEIS problemas visuais para o revisor humano, compara Chrome × Edge e mede o determinismo entre duas
// capturas do mesmo conjunto. Nada aqui aprova nem reprova baseline: é material para a decisão de uma pessoa.
import { createHash } from "node:crypto";
import { compareImages } from "./imagediff.mjs";
import { decodePng } from "./png.mjs";
import { overlapSet } from "./fingerprint.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
export const vpWidth = (viewport) => Number(String(viewport).split("x")[0]);

export function meanLuminance(img) { let s = 0; const n = img.width * img.height; for (let i = 0; i < n; i++) { const o = i * 4; s += img.data[o] * 0.299 + img.data[o + 1] * 0.587 + img.data[o + 2] * 0.114; } return n ? s / n : 0; }
export function distinctColors(img, cap = 64) { const set = new Set(); for (let i = 0; i < img.data.length; i += 4) { set.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]); if (set.size >= cap) break; } return set.size; }

/**
 * Possíveis problemas de uma candidata. meta: { viewport, theme, truncatedHeight }, fingerprint (ou null), image (decodificada, opcional).
 * Retorna [{ kind, severity: high|medium|info, detail }]. "high" = provavelmente um defeito; "medium" = olhar com atenção; "info" = contexto.
 */
export function analyzeCandidate({ meta, fingerprint, image }) {
  const issues = []; const add = (kind, severity, detail) => issues.push({ kind, severity, detail });
  const w = vpWidth(meta.viewport);
  if (!fingerprint) add("no-layout-data", "info", "sem impressão de layout: só a inspeção visual vale");
  else {
    const els = fingerprint.elements.filter((e) => e.visible);
    if (fingerprint.doc.w > w + 1) add("horizontal-overflow", "high", `largura rolável ${fingerprint.doc.w}px maior que o viewport ${w}px (rolagem horizontal)`);
    const off = els.filter((e) => !e.hscroll && /^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(e.tag) && (e.x < -1 || e.x + e.w > w + 1)); // M05: controles em contêiner com rolagem horizontal (abas) não contam como 'fora da tela'
    if (off.length) add("offscreen-control", "high", `${off.length} controle(s) fora da tela (ex.: "${off[0].text || off[0].tag}" x=${off[0].x} largura=${off[0].w})`);
    if (els.length < 5) add("nearly-empty", "high", `só ${els.length} elemento(s) visível(is): a página parece vazia`);
    const clipped = els.filter((e) => e.clipped && e.w >= 8 && e.h >= 8); // elementos só para leitor de tela (1×1, recortados de propósito) não são conteúdo cortado
    if (clipped.length) add("clipped-content", "medium", `${clipped.length} elemento(s) com conteúdo cortado (ex.: "${clipped[0].text || clipped[0].tag}")`);
    const ov = [...overlapSet(fingerprint.elements)]; if (ov.length) add("overlap", "medium", `${ov.length} sobreposição(ões) entre elementos (ex.: ${ov[0].slice(0, 90)})`);
    const small = els.filter((e) => e.text && parseFloat(e.size) < 12); if (small.length) add("small-text", "medium", `${small.length} texto(s) menores que 12px (ex.: "${small[0].text}" ${small[0].size})`);
    if (fingerprint.truncated) add("fingerprint-truncated", "info", "a impressão de layout atingiu o limite de elementos");
  }
  if (meta.truncatedHeight) add("truncated-height", "info", "a imagem foi limitada a 3.200px de altura: o que está abaixo não foi capturado");
  if (image) {
    const lum = meanLuminance(image);
    if (distinctColors(image) < 3) add("blank-image", "high", "imagem praticamente de uma cor só");
    if (meta.theme === "dark" && lum > 140) add("theme-mismatch", "high", `tema escuro, mas a imagem é predominantemente clara (luminância média ${Math.round(lum)})`);
    if (meta.theme === "light" && lum < 110) add("theme-mismatch", "high", `tema claro, mas a imagem é predominantemente escura (luminância média ${Math.round(lum)})`);
  }
  return issues;
}

/** Chrome × Edge (ou qualquer par): mesma célula, navegadores diferentes. Só informativo: baselines são por navegador. */
export function crossBrowser(imgA, imgB, opts = {}) {
  const r = compareImages(imgA, imgB, opts);
  return { verdict: r.verdict, diffPixels: r.metrics.diffPixels, diffRatio: r.metrics.diffRatio, shape: r.metrics.shape, bbox: r.metrics.bbox, largestCluster: r.metrics.largestCluster, baseWidth: r.metrics.baseWidth, baseHeight: r.metrics.baseHeight, diffImage: r.diffImage };
}

/**
 * Determinismo: compara duas execuções de captura do MESMO conjunto. aCells/bCells = `celulas` dos visual-report.json; read(side, relFile) → Buffer do PNG.
 * Cada célula: IDENTICAL | WITHIN_TOLERANCE | DIFFERENT | DIMENSION_MISMATCH | ONLY_A | ONLY_B | NOT_CAPTURED | UNREADABLE | HASH_MISMATCH.
 * `maskCandidates` lista as regiões que diferem (SUGESTÃO para investigar; nunca é aplicada automaticamente).
 */
export function compareRuns({ aCells, bCells, read, tolerance }) {
  const A = new Map(aCells.map((c) => [c.id, c])), B = new Map(bCells.map((c) => [c.id, c])); const ids = [...new Set([...A.keys(), ...B.keys()])].sort(); const cells = [];
  for (const id of ids) {
    const a = A.get(id), b = B.get(id);
    if (!a || !b) { cells.push({ id, status: a ? "ONLY_A" : "ONLY_B" }); continue; }
    if (!a.captured || !b.captured) { cells.push({ id, status: "NOT_CAPTURED", detail: `A=${a.status} B=${b.status}` }); continue; }
    let pa, pb; try { pa = read("a", a.captured.file); pb = read("b", b.captured.file); } catch (e) { cells.push({ id, status: "UNREADABLE", detail: e.message }); continue; }
    if (sha(pa) !== a.captured.sha256 || sha(pb) !== b.captured.sha256) { cells.push({ id, status: "HASH_MISMATCH", detail: "o SHA-256 de um dos PNGs não confere com o relatório da execução" }); continue; }
    if (a.captured.sha256 === b.captured.sha256) { cells.push({ id, status: "IDENTICAL", diffPixels: 0 }); continue; }
    let ia, ib; try { ia = decodePng(pa); ib = decodePng(pb); } catch (e) { cells.push({ id, status: "UNREADABLE", detail: e.message }); continue; }
    const r = compareImages(ia, ib, { tolerance });
    cells.push({ id, status: r.verdict, diffPixels: r.metrics.diffPixels, diffRatio: r.metrics.diffRatio, shape: r.metrics.shape, bbox: r.metrics.bbox, largestCluster: r.metrics.largestCluster, clusters: r.clusters.slice(0, 4), diffImage: r.diffImage });
  }
  const counts = {}; for (const c of cells) counts[c.status] = (counts[c.status] ?? 0) + 1;
  const unstable = cells.filter((c) => !["IDENTICAL", "WITHIN_TOLERANCE"].includes(c.status));
  return { cells, counts, deterministic: unstable.length === 0 && cells.length > 0, maskCandidates: cells.filter((c) => c.status === "DIFFERENT").map((c) => ({ id: c.id, bbox: c.bbox, pixels: c.diffPixels, note: "região que variou entre duas capturas idênticas: investigar a causa (data, contador, animação, fonte, dado assíncrono) antes de qualquer máscara" })) };
}
