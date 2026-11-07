/**
 * M11 — o comparador visual NÃO mascara regressões (testes adversariais, sem navegador). Medido na M11 (m11-evidence/r14/comparador-atual-medicao.json): o padrão anterior (limiar
 * perceptual 0,1 + anti-aliasing 3×3) deixava passar deslocamento real de 1 px, 1 px de espaçamento, contraste do título reduzido e cor do botão alterada em até 20 níveis.
 * Aqui: (1) o padrão estrito reprova todas essas regressões; (2) a tolerância por REGIÃO (ruído de rasterização Δ≤2, orçamento de pixels, justificativa) aceita só o ruído, e NÃO aceita
 * deslocamento de 1 px, borda removida, texto alterado, elemento oculto, cor alterada, contraste reduzido nem espaçamento incorreto, nem mesmo DENTRO da região; (3) o limite técnico
 * (variação de até Δ2 dentro da região é indistinguível do ruído) está registrado em teste.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.env.QA_VISUAL_ROOT ?? path.resolve(__dirname, "../scripts/qa-visual");
const load = (rel: string) => import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href);
const diff = await load("lib/imagediff.mjs");
const vr = await load("lib/visualrun.mjs");
const png = await load("lib/png.mjs");

type Img = { width: number; height: number; data: Uint8ClampedArray };
const mk = (w: number, h: number, bg = [255, 255, 255]): Img => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { d[i * 4] = bg[0]; d[i * 4 + 1] = bg[1]; d[i * 4 + 2] = bg[2]; d[i * 4 + 3] = 255; } return { width: w, height: h, data: d }; };
const px = (img: Img, x: number, y: number, c: number[]) => { if (x < 0 || y < 0 || x >= img.width || y >= img.height) return; const o = (y * img.width + x) * 4; img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; };
const rect = (img: Img, x: number, y: number, w: number, h: number, c: number[]) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) px(img, i, j, c); };
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
function text(img: Img, x: number, y: number, str: string, c: number[], bg = [255, 255, 255]) { for (let k = 0; k < str.length; k++) { const seed = str.charCodeAt(k); const gx = x + k * 7; for (let j = 0; j < 9; j++) for (let i = 0; i < 5; i++) { if (((seed * (i + 3) + j * 7 + i * j) % 5) < 3) px(img, gx + i, y + j, (i === 0 || i === 4 || j === 0 || j === 8) ? mix(bg, c, 0.6) : c); } } }
type O = { title?: string; titleColor?: number[]; mutedColor?: number[]; gap?: number; btn?: number[]; btnDx?: number; btnDy?: number; noButton?: boolean; noBorder?: boolean; shadow?: number[]; toastDx?: number; toastDy?: number; fieldW?: number; loading?: boolean };
function page(o: O = {}): Img {
  const p = mk(240, 160);
  rect(p, 0, 0, 240, 24, [30, 30, 30]);
  text(p, 10, 40, o.title ?? "Receber doacao", o.titleColor ?? [40, 40, 40]);
  text(p, 10, 54 + (o.gap ?? 0), "Texto de apoio", o.mutedColor ?? [100, 100, 100]);
  if (!o.noButton) rect(p, 10 + (o.btnDx ?? 0), 74 + (o.btnDy ?? 0), 70, 24, o.btn ?? [29, 78, 216]);
  const fw = o.fieldW ?? 130; // campo de link (M12: largura menor = campo parcialmente cortado)
  if (!o.noBorder) { rect(p, 100, 74, fw, 1, [120, 120, 120]); rect(p, 100, 98, fw, 1, [120, 120, 120]); rect(p, 100, 74, 1, 25, [120, 120, 120]); rect(p, 100 + fw - 1, 74, 1, 25, [120, 120, 120]); }
  rect(p, 150 + (o.toastDx ?? 0), 102 + (o.toastDy ?? 0), 80, 8, [60, 60, 60]); // M12: aviso (toast) — posição indevida = deslocamento
  rect(p, 10, 112, 220, 36, [248, 245, 240]); if (o.loading) rect(p, 16, 122, 90, 9, [226, 222, 216]); else text(p, 16, 122, "Comprovante enviado", [60, 60, 60], [248, 245, 240]); rect(p, 10, 112, 220, 1, [220, 214, 205]); rect(p, 10, 147, 220, 1, [220, 214, 205]); rect(p, 10, 148, 220, 2, o.shadow ?? [236, 232, 226]);
  return p;
}
const base = page();
/** As regressões controladas (cada uma tem de reprovar). */
const REGRESSIONS: Record<string, Img> = {
  "deslocamento real de 1 px (direita)": page({ btnDx: 1 }),
  "deslocamento real de 1 px (baixo)": page({ btnDy: 1 }),
  "borda removida": page({ noBorder: true }),
  "texto alterado": page({ title: "Receber boacao" }),
  "elemento oculto": page({ noButton: true }),
  "cor alterada (azul → vermelho)": page({ btn: [185, 28, 28] }),
  "cor alterada em 8 níveis": page({ btn: [21, 70, 208] }),
  "contraste reduzido do texto de apoio (100 → 135)": page({ mutedColor: [135, 135, 135] }),
  "contraste reduzido leve do título (40 → 60)": page({ titleColor: [60, 60, 60] }),
  "espaçamento incorreto (+1 px)": page({ gap: 1 }),
  "M12 aviso (toast) deslocado indevidamente (+1 px)": page({ toastDy: 1 }),
  "M12 aviso (toast) deslocado indevidamente (lateral +1 px)": page({ toastDx: 1 }),
  "M12 campo de link parcialmente cortado (-8 px)": page({ fieldW: 122 }),
  "M12 carregamento incompleto (esqueleto no lugar do conteúdo)": page({ loading: true }),
};
// Região de ruído declarada (sombra do cartão, como nas imagens R14): Δ ≤ 2, até 20 pixels.
const REGION = { x: 10, y: 140, w: 220, h: 20, maxChannelDelta: 2, maxPixels: 20, reason: "ruído de rasterização da sombra do cartão (Δ1–Δ2), comprovado em rodadas independentes" };
const WIDE_REGION = { ...REGION, x: 0, y: 0, w: 240, h: 160, maxPixels: 100000, reason: "região propositalmente enorme para provar que o Δ máximo ainda reprova" };

describe("M11 — padrão estrito: nenhuma regressão controlada passa", () => {
  for (const [name, img] of Object.entries(REGRESSIONS)) it(`reprova: ${name}`, () => {
    const r = diff.compareImages(base, img);
    expect(r.verdict).toBe("DIFFERENT"); expect(r.metrics.diffPixels).toBeGreaterThan(0);
    expect(vr.compareCaptured({ png: png.encodePng(img), fingerprint: null, resolution: { png: png.encodePng(base), fingerprint: null }, page: { id: "p" } }).status).toBe("VISUAL_REGRESSION");
  });
  it("idêntica continua IDENTICAL e a política antiga é explícita (só portão de estabilidade)", () => {
    expect(diff.compareImages(base, page()).verdict).toBe("IDENTICAL");
    expect(diff.DEFAULT_TOLERANCE.pixelThreshold).toBe(0); expect(diff.DEFAULT_TOLERANCE.antiAliasing).toBe(false); expect(diff.DEFAULT_TOLERANCE.regions).toEqual([]);
    expect(diff.compareImages(base, REGRESSIONS["deslocamento real de 1 px (direita)"], { tolerance: diff.LEGACY_PERCEPTUAL_TOLERANCE }).verdict).toBe("WITHIN_TOLERANCE"); // o que a política antiga deixava passar
  });
});

describe("M11 — tolerância por região: aceita só o ruído localizado", () => {
  const noise = (n: number, delta: number, y = 148) => { const p = page(); for (let i = 0; i < n; i++) px(p, 20 + i * 3, y, [236 - delta, 232 - delta, 226 - delta]); return p; };
  it("ruído Δ1–Δ2 dentro da região e dentro do orçamento: WITHIN_TOLERANCE, contado e visível no relatório", () => {
    const r = diff.compareImages(base, noise(12, 2), { tolerance: { regions: [REGION] } });
    expect(r.verdict).toBe("WITHIN_TOLERANCE"); expect(r.metrics.diffPixels).toBe(0); expect(r.metrics.regions[0].toleratedPixels).toBe(12); expect(r.metrics.regions[0].exceeded).toBe(false);
  });
  it("o mesmo ruído SEM região declarada reprova (padrão estrito)", () => { expect(diff.compareImages(base, noise(12, 2)).verdict).toBe("DIFFERENT"); });
  it("ruído fora da região reprova", () => { expect(diff.compareImages(base, noise(12, 2, 60), { tolerance: { regions: [REGION] } }).verdict).toBe("DIFFERENT"); });
  it("Δ acima do limite da região (3 > 2) reprova", () => { expect(diff.compareImages(base, noise(12, 3), { tolerance: { regions: [REGION] } }).verdict).toBe("DIFFERENT"); });
  it("orçamento estourado (21 > 20): TODOS os pixels da região passam a contar como diferença", () => {
    const r = diff.compareImages(base, noise(21, 1), { tolerance: { regions: [REGION] } });
    expect(r.verdict).toBe("DIFFERENT"); expect(r.metrics.diffPixels).toBe(21); expect(r.metrics.regions[0].exceeded).toBe(true); expect(r.metrics.regions[0].toleratedPixels).toBe(0);
  });
  for (const [name, img] of Object.entries(REGRESSIONS)) {
    it(`com a região declarada, AINDA reprova: ${name}`, () => { expect(diff.compareImages(base, img, { tolerance: { regions: [REGION] } }).verdict).toBe("DIFFERENT"); });
    it(`mesmo com uma região enorme (a página inteira), o Δ máximo preserva a detecção: ${name}`, () => {
      const r = diff.compareImages(base, img, { tolerance: { regions: [WIDE_REGION] } });
      expect(r.verdict).toBe("DIFFERENT"); // todas as regressões controladas têm Δ ≥ 8 em algum pixel (acima do teto de 4 níveis)
    });
  }
  it("LIMITE TÉCNICO documentado: uma mudança de cor de até Δ2 DENTRO da região é indistinguível do ruído e passa (fora da região, ou acima de Δ4, reprova)", () => {
    const shadowOff = page({ shadow: [234, 230, 224] }); // sombra 2 níveis mais escura, dentro da região
    expect(diff.compareImages(base, shadowOff, { tolerance: { regions: [{ ...REGION, maxPixels: 500 }] } }).verdict).toBe("WITHIN_TOLERANCE");
    expect(diff.compareImages(base, shadowOff).verdict).toBe("DIFFERENT");
    expect(diff.compareImages(base, page({ btn: [27, 76, 214] }), { tolerance: { regions: [{ ...REGION, maxPixels: 5000 }] } }).verdict).toBe("DIFFERENT"); // 2 níveis no botão: fora da região
  });
  it("validação: sem justificativa, Δ fora de 1..4, orçamento inválido, retângulo fora da imagem ou vazio → erro", () => {
    const bad = (r: object) => () => diff.compareImages(base, base, { tolerance: { regions: [{ ...REGION, ...r }] } });
    expect(bad({ reason: "" })).toThrow(/justificativa/); expect(bad({ reason: "curto" })).toThrow(/justificativa/);
    expect(bad({ maxChannelDelta: 0 })).toThrow(/maxChannelDelta/); expect(bad({ maxChannelDelta: 5 })).toThrow(/maxChannelDelta/);
    expect(bad({ maxPixels: 0 })).toThrow(/maxPixels/); expect(bad({ x: 230 })).toThrow(/fora da imagem/); expect(bad({ w: 0 })).toThrow(/vazio/); expect(bad({ x: 1.5 })).toThrow(/inteiro/);
  });
  it("regionsForCell: a região restrita por \`cells\` só vale para as células listadas", () => {
    const p = { tolerance: { regions: [{ ...REGION, cells: ["a__chrome__375x812__light"] }, { ...REGION, x: 11 }] } };
    expect(vr.regionsForCell(p, "a__chrome__375x812__light")).toHaveLength(2); expect(vr.regionsForCell(p, "a__edge__375x812__light")).toHaveLength(1);
    expect(vr.regionsForCell({ tolerance: {} }, "x")).toBeUndefined(); expect(vr.regionsForCell({}, "x")).toBeUndefined();
  });
  it("compareCaptured com a região da célula: ruído passa; deslocamento de 1 px continua reprovando", () => {
    const pg = { id: "p", tolerance: { regions: [{ ...REGION, cells: ["p__chrome__375x812__light"] }] } };
    const res = { png: png.encodePng(base), fingerprint: null };
    const ok = vr.compareCaptured({ png: png.encodePng(noise(12, 2)), fingerprint: null, resolution: res, page: pg, cellId: "p__chrome__375x812__light" });
    expect(ok.status).toBe("VISUAL_PASS"); expect(ok.cause).toBe("WITHIN_TOLERANCE");
    expect(vr.compareCaptured({ png: png.encodePng(noise(12, 2)), fingerprint: null, resolution: res, page: pg, cellId: "p__edge__375x812__light" }).status).toBe("VISUAL_REGRESSION"); // outra célula: sem região
    expect(vr.compareCaptured({ png: png.encodePng(REGRESSIONS["deslocamento real de 1 px (baixo)"]), fingerprint: null, resolution: res, page: pg, cellId: "p__chrome__375x812__light" }).status).toBe("VISUAL_REGRESSION");
  });
});

describe("M11 — regiões de ruído medidas (visual-noise-regions.mjs): pequenas, por célula, justificadas e sem aprovar nada", async () => {
  const nr = await load("visual-noise-regions.mjs"); const matrix = await load("visual-matrix.mjs");
  const all = Object.entries(nr.NOISE_REGIONS as Record<string, any[]>).flatMap(([page, rs]) => rs.map((r) => ({ page, ...r })));
  it("há regiões e todas passam na validação do comparador (retângulo inteiro, Δ de 1 a 4, orçamento, justificativa)", () => {
    expect(all.length).toBeGreaterThan(0); expect(() => diff.validateRegions(all.map(({ page, cells, ...r }) => r))).not.toThrow();
  });
  it("cada região é PEQUENA (≤ 12×12 px, ≤ 20 pixels, Δ ≤ 4) e restrita a células nomeadas da própria página", () => {
    for (const r of all) { expect(r.w * r.h, r.page).toBeLessThanOrEqual(12 * 12); expect(r.maxPixels).toBeLessThanOrEqual(20); expect(r.maxChannelDelta).toBeLessThanOrEqual(4);
      expect(Array.isArray(r.cells) && r.cells.length > 0).toBe(true); for (const c of r.cells) expect(c.startsWith(r.page + "__")).toBe(true); expect(r.reason.length).toBeGreaterThan(30); }
  });
  it("na matriz oficial só as páginas com região têm tolerância, com justificativa; nenhuma máscara foi criada", () => {
    for (const p of matrix.VISUAL_PAGES) { const has = (nr.NOISE_REGIONS[p.id] ?? []).length > 0; expect(!!p.tolerance?.regions, p.id).toBe(has); if (has) expect(p.why, p.id).toBeTruthy(); expect(p.masks ?? [], p.id).toEqual([]); expect(p.tolerance?.maxDiffPixels ?? 0, p.id).toBe(0); expect(p.tolerance?.pixelThreshold ?? 0, p.id).toBe(0); }
  });
  it("withNoiseRegions não altera páginas sem região nem o resto da definição", () => {
    const p = { id: "login", path: "/x" }; expect(nr.withNoiseRegions(p)).toBe(p);
    const q = nr.withNoiseRegions({ id: "org-inicio", path: "/y" }); expect(q.path).toBe("/y"); expect(q.tolerance.regions.length).toBeGreaterThan(0); expect(q.why).toMatch(/R14/);
  });
});
