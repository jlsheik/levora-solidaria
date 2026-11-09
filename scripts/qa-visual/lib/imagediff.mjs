// Comparação PIXEL A PIXEL entre duas imagens RGBA (módulo puro, testado). Não usa hash nem dimensões como substituto: cada pixel é comparado.
//
// Critério de pixel diferente: distância perceptual YIQ (o mesmo espírito do pixelmatch) com limiar `pixelThreshold` (0..1, padrão 0,1). Diferenças
// que o olho não distingue (< limiar) não contam. Tolerância a ANTI-ALIASING: um pixel só é "tolerado" se a cor dele na outra imagem existe na vizinhança 3×3 e
// vice-versa (jitter de 1px na borda de glifos). Deslocamento real (≥ 2px), cor trocada, elemento sumido ou aparecido NÃO passam por essa tolerância.
//
// Tolerância de aprovação (explícita e por cenário): `maxDiffPixels` (pixels estritamente diferentes) e `maxClusterPixels` (maior aglomerado). O padrão é 0/0:
// um limite "percentual alto" esconderia regressões localizadas (uma borda de 1px num campo largo é só ~0,03% da página). Qualquer folga acima de 0 exige
// justificativa escrita na configuração do cenário (ver visual-matrix.mjs). Máscaras (regiões dinâmicas) exigem `reason` e são sempre contadas no relatório.
//
// M11 — POLÍTICA PADRÃO ESTRITA. Medido com regressões sintéticas controladas (m11-evidence/r14/comparador-atual-medicao.json): o padrão anterior (limiar 0,1 ≈ 26 níveis de cinza +
// anti-aliasing 3×3) deixava PASSAR um deslocamento real de 1 px, 1 px de espaçamento a mais, o título com contraste reduzido (40→60) e o botão com a cor mudada em até 20 níveis por canal.
// Agora o padrão é EXATO (limiar 0, sem anti-aliasing). Ruído de rasterização comprovado só é aceito por REGIÃO declarada (`tolerance.regions`): retângulo inteiro, `maxChannelDelta` pequeno
// (1..4), `maxPixels` e justificativa (reason); pixel fora da região, ou acima do Δ, reprova; estourar o orçamento da região reprova todos os pixels dela. `LEGACY_PERCEPTUAL_TOLERANCE` é a
// política antiga, usada SOMENTE no portão de estabilidade da captura (a página terminou de renderizar?), nunca para comparar com baseline.
const MAX_DELTA = 35215; // maior distância YIQ possível (preto×branco)

const blendWhite = (c, a) => 255 + (c - 255) * a;
function yiq(d, o) {
  const a = d[o + 3] / 255; const r = blendWhite(d[o], a), g = blendWhite(d[o + 1], a), b = blendWhite(d[o + 2], a);
  return [r * 0.29889531 + g * 0.58662247 + b * 0.11448223, r * 0.59597799 - g * 0.2741761 - b * 0.32180189, r * 0.21147017 - g * 0.52261711 + b * 0.31114694];
}
/** Distância perceptual entre o pixel `o1` de `d1` e o pixel `o2` de `d2` (0..MAX_DELTA). */
export function colorDelta(d1, o1, d2, o2) {
  if (d1[o1] === d2[o2] && d1[o1 + 1] === d2[o2 + 1] && d1[o1 + 2] === d2[o2 + 2] && d1[o1 + 3] === d2[o2 + 3]) return 0;
  const [y1, i1, q1] = yiq(d1, o1), [y2, i2, q2] = yiq(d2, o2); const dy = y1 - y2, di = i1 - i2, dq = q1 - q2;
  return 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
}
const lum = (d, o) => d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114;

export const DEFAULT_TOLERANCE = Object.freeze({ pixelThreshold: 0, antiAliasing: false, maxDiffPixels: 0, maxClusterPixels: 0, regions: Object.freeze([]) });
/** Política antiga (perceptual + anti-aliasing). Só para o portão de estabilidade da captura. */
export const LEGACY_PERCEPTUAL_TOLERANCE = Object.freeze({ pixelThreshold: 0.1, antiAliasing: true });
export const MAX_REGION_CHANNEL_DELTA = 4;

export class RegionError extends Error { constructor(message) { super(message); this.name = "RegionError"; } }
/** Valida as regiões de ruído tolerado: retângulo inteiro dentro da imagem, Δ por canal 1..4, orçamento de pixels e justificativa obrigatória. */
export function validateRegions(regions = [], { width, height } = {}) {
  if (!Array.isArray(regions)) throw new RegionError("regions precisa ser uma lista");
  return regions.map((r, i) => {
    if (!r || typeof r.reason !== "string" || r.reason.trim().length < 12) throw new RegionError(`região #${i}: falta a justificativa (reason, ≥ 12 caracteres)`);
    for (const k of ["x", "y", "w", "h"]) if (!Number.isInteger(r[k]) || r[k] < 0) throw new RegionError(`região #${i}: ${k} precisa ser inteiro ≥ 0`);
    if (r.w < 1 || r.h < 1) throw new RegionError(`região #${i}: tamanho vazio`);
    if (!Number.isInteger(r.maxChannelDelta) || r.maxChannelDelta < 1 || r.maxChannelDelta > MAX_REGION_CHANNEL_DELTA) throw new RegionError(`região #${i}: maxChannelDelta precisa ser inteiro de 1 a ${MAX_REGION_CHANNEL_DELTA}`);
    if (!Number.isInteger(r.maxPixels) || r.maxPixels < 1) throw new RegionError(`região #${i}: maxPixels precisa ser inteiro ≥ 1`);
    if (width !== undefined && (r.x + r.w > width || r.y + r.h > height)) throw new RegionError(`região #${i}: fora da imagem (${width}x${height})`);
    return { x: r.x, y: r.y, w: r.w, h: r.h, maxChannelDelta: r.maxChannelDelta, maxPixels: r.maxPixels, reason: r.reason.trim() };
  });
}

export class MaskError extends Error { constructor(message) { super(message); this.name = "MaskError"; } }
/** Valida as máscaras: retângulo inteiro dentro da imagem e `reason` (justificativa) obrigatória. */
export function validateMasks(masks = [], { width, height } = {}) {
  if (!Array.isArray(masks)) throw new MaskError("masks precisa ser uma lista");
  return masks.map((m, i) => {
    if (!m || typeof m.reason !== "string" || m.reason.trim().length < 8) throw new MaskError(`máscara #${i}: falta a justificativa (reason, ≥ 8 caracteres): máscara sem motivo esconde regressão`);
    for (const k of ["x", "y", "w", "h"]) if (!Number.isInteger(m[k]) || m[k] < 0) throw new MaskError(`máscara #${i}: ${k} precisa ser inteiro ≥ 0`);
    if (m.w < 1 || m.h < 1) throw new MaskError(`máscara #${i}: tamanho vazio`);
    if (width !== undefined && (m.x + m.w > width || m.y + m.h > height)) throw new MaskError(`máscara #${i}: fora da imagem (${width}x${height})`);
    return { x: m.x, y: m.y, w: m.w, h: m.h, reason: m.reason.trim() };
  });
}

function clusterize(cells, gw, gh) { // componentes conexos (8 vizinhos) sobre a grade de células com diferença
  const seen = new Uint8Array(gw * gh); const out = [];
  for (let s = 0; s < gw * gh; s++) {
    if (!cells.has(s) || seen[s]) continue;
    const stack = [s]; seen[s] = 1; let pixels = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    while (stack.length) {
      const c = stack.pop(); const cd = cells.get(c); pixels += cd.n; x0 = Math.min(x0, cd.x0); y0 = Math.min(y0, cd.y0); x1 = Math.max(x1, cd.x1); y1 = Math.max(y1, cd.y1);
      const cx = c % gw, cy = (c / gw) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue; const n = ny * gw + nx;
        if (cells.has(n) && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    out.push({ pixels, bbox: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } });
  }
  return out.sort((a, b) => b.pixels - a.pixels);
}

/**
 * Compara `base` (referência) e `cur` (captura atual); ambas { width, height, data(RGBA) }.
 * Retorna { verdict: IDENTICAL | WITHIN_TOLERANCE | DIFFERENT | DIMENSION_MISMATCH, metrics, clusters, diffImage, reasons[] }.
 */
export function compareImages(base, cur, { tolerance = {}, masks = [], cell = 8 } = {}) {
  const tol = { ...DEFAULT_TOLERANCE, ...tolerance };
  if (!(tol.pixelThreshold >= 0 && tol.pixelThreshold <= 1)) throw new RangeError("pixelThreshold precisa estar em [0,1]");
  if (tol.antiAliasing !== undefined && typeof tol.antiAliasing !== "boolean") throw new TypeError("antiAliasing precisa ser booleano");
  if (!Number.isInteger(tol.maxDiffPixels) || tol.maxDiffPixels < 0 || !Number.isInteger(tol.maxClusterPixels) || tol.maxClusterPixels < 0) throw new RangeError("maxDiffPixels/maxClusterPixels precisam ser inteiros ≥ 0");
  if (base.width !== cur.width || base.height !== cur.height) {
    const w = Math.max(base.width, cur.width), h = Math.max(base.height, cur.height); const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; const inB = x < base.width && y < base.height, inC = x < cur.width && y < cur.height; const inBoth = inB && inC;
      const v = inBoth ? 235 : 255; data[o] = inBoth ? v : 255; data[o + 1] = inBoth ? v : inB || inC ? 0 : 255; data[o + 2] = inBoth ? v : inB || inC ? 160 : 255; data[o + 3] = 255; }
    return { verdict: "DIMENSION_MISMATCH", reasons: [`dimensões diferentes: referência ${base.width}x${base.height}, atual ${cur.width}x${cur.height}`],
      metrics: { width: cur.width, height: cur.height, baseWidth: base.width, baseHeight: base.height, compared: 0, diffPixels: 0, aaTolerated: 0, masked: 0, diffRatio: null, meanDelta: null, maxDelta: null, bbox: null, largestCluster: 0, shape: "dimensions" }, clusters: [], diffImage: { width: w, height: h, data } };
  }
  const { width: w, height: h } = cur; const A = base.data, B = cur.data; const T = MAX_DELTA * tol.pixelThreshold * tol.pixelThreshold;
  const regionList = validateRegions(tol.regions ?? [], { width: w, height: h }); const regionAt = (x, y) => regionList.findIndex((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  const regionTolerated = regionList.map(() => []); // pixels (x,y,d) dentro de uma região com Δ pequeno; viram diferença se o orçamento da região estourar
  const maskList = validateMasks(masks, { width: w, height: h }); const masked = new Uint8Array(w * h);
  for (const m of maskList) for (let y = m.y; y < m.y + m.h; y++) masked.fill(1, y * w + m.x, y * w + m.x + m.w);
  const diffImage = new Uint8ClampedArray(w * h * 4);
  let diffPixels = 0, aaTolerated = 0, maskedCount = 0, sumDelta = 0, maxD = 0, exactDiff = 0, edgeMismatch = 0;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity; const cells = new Map(); const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const near = (D1, o1, D2, x, y) => { // a cor do pixel (D1,o1) existe na vizinhança 3×3 de (x,y) em D2?
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; if (colorDelta(D1, o1, D2, (ny * w + nx) * 4) <= T) return true; }
    return false;
  };
  const edge = (D, x, y) => { const o = (y * w + x) * 4; const r = x + 1 < w ? Math.abs(lum(D, o) - lum(D, o + 4)) : 0; const d = y + 1 < h ? Math.abs(lum(D, o) - lum(D, o + w * 4)) : 0; return r > 24 || d > 24; };
  const addDiff = (x, y, d) => {
    const o = (y * w + x) * 4; diffPixels++; const nd = d / MAX_DELTA; sumDelta += nd; if (nd > maxD) maxD = nd;
    diffImage[o] = 255; diffImage[o + 1] = 0; diffImage[o + 2] = 64;
    if (edge(A, x, y) !== edge(B, x, y)) edgeMismatch++;
    if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y;
    const ci = ((y / cell) | 0) * gw + ((x / cell) | 0); const c = cells.get(ci) ?? { n: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    c.n++; c.x0 = Math.min(c.x0, x); c.y0 = Math.min(c.y0, y); c.x1 = Math.max(c.x1, x); c.y1 = Math.max(c.y1, y); cells.set(ci, c);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; const o = i * 4; const g = Math.round(lum(A, o) * 0.25 + 191);
    diffImage[o] = diffImage[o + 1] = diffImage[o + 2] = g; diffImage[o + 3] = 255; // fundo = referência em cinza esmaecido
    if (masked[i]) { maskedCount++; diffImage[o] = 150; diffImage[o + 1] = 190; diffImage[o + 2] = 255; continue; }
    const d = colorDelta(A, o, B, o);
    if (d === 0) continue;
    exactDiff++;
    if (d <= T) continue; // diferença abaixo do limiar perceptual
    if (tol.antiAliasing && near(A, o, B, x, y) && near(B, o, A, x, y)) { aaTolerated++; diffImage[o] = 255; diffImage[o + 1] = 215; diffImage[o + 2] = 0; continue; } // anti-aliasing / jitter de 1px
    const ri = regionList.length ? regionAt(x, y) : -1;
    if (ri >= 0 && Math.max(Math.abs(A[o] - B[o]), Math.abs(A[o + 1] - B[o + 1]), Math.abs(A[o + 2] - B[o + 2]), Math.abs(A[o + 3] - B[o + 3])) <= regionList[ri].maxChannelDelta) { regionTolerated[ri].push([x, y, d]); continue; }
    addDiff(x, y, d);
  }
  const regionReport = regionList.map((r, ri) => { const n = regionTolerated[ri].length; const exceeded = n > r.maxPixels; if (exceeded) for (const [x, y, d] of regionTolerated[ri]) addDiff(x, y, d); else for (const [x, y] of regionTolerated[ri]) { const o = (y * w + x) * 4; diffImage[o] = 120; diffImage[o + 1] = 200; diffImage[o + 2] = 120; } return { ...r, toleratedPixels: exceeded ? 0 : n, observedPixels: n, exceeded }; });
  const clusters = clusterize(cells, gw, gh); const compared = w * h - maskedCount; const largest = clusters[0]?.pixels ?? 0;
  const shape = diffPixels === 0 ? "none" : edgeMismatch / diffPixels < 0.1 ? "color-only" : "shape";
  const metrics = { width: w, height: h, compared, masked: maskedCount, exactDiffPixels: exactDiff, diffPixels, aaTolerated, diffRatio: compared ? diffPixels / compared : 0,
    meanDelta: diffPixels ? sumDelta / diffPixels : 0, maxDelta: maxD, bbox: diffPixels ? { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 } : null, largestCluster: largest, clusterCount: clusters.length, shape,
    tolerance: tol, masks: maskList, regions: regionReport };
  let verdict; const reasons = [];
  if (exactDiff === 0) verdict = "IDENTICAL";
  else if (diffPixels <= tol.maxDiffPixels && largest <= tol.maxClusterPixels) verdict = "WITHIN_TOLERANCE";
  else { verdict = "DIFFERENT"; reasons.push(`${diffPixels} pixel(s) diferentes (limite ${tol.maxDiffPixels}); maior aglomerado ${largest} (limite ${tol.maxClusterPixels})`); }
  return { verdict, reasons, metrics, clusters: clusters.slice(0, 12), diffImage: { width: w, height: h, data: diffImage } };
}

/** Painel lado a lado: referência | atual | diferença (mesmas dimensões), para revisão humana num único arquivo. */
export function triptych(base, cur, diff, gap = 10) {
  const w = base.width + cur.width + diff.width + gap * 2, h = Math.max(base.height, cur.height, diff.height); const data = new Uint8ClampedArray(w * h * 4).fill(255);
  let xo = 0;
  for (const img of [base, cur, diff]) {
    for (let y = 0; y < img.height; y++) data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), (y * w + xo) * 4);
    xo += img.width + gap;
  }
  return { width: w, height: h, data };
}
