/**
 * Testes UNITÁRIOS do QA de regressão visual (M02): codec PNG, comparação pixel a pixel, impressão de layout, baselines (candidata × aprovada × stale × corrompida),
 * classificação do resultado visual, classificação de falha de carregamento (D6) com a evidência REAL do C24, matriz e códigos de saída.
 * Não abrem navegador: a captura/comparação com Chrome e Edge reais é feita por `node scripts/qa-visual/visual-selftest.mjs`.
 * QA_VISUAL_ROOT (opcional) aponta para uma CÓPIA do diretório scripts/qa-visual — é assim que os mutantes (scripts/qa-visual/dev/visual-mutants.mjs) testam código sabotado.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.env.QA_VISUAL_ROOT ?? path.resolve(__dirname, "../scripts/qa-visual");
const load = (rel: string) => import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href);
const png = await load("lib/png.mjs");
const diff = await load("lib/imagediff.mjs");
const fpm = await load("lib/fingerprint.mjs");
const bl = await load("lib/baseline.mjs");
const lh = await load("lib/loadhealth.mjs");
const vr = await load("lib/visualrun.mjs");
const cap = await load("lib/capture.mjs");
const matrix = await load("visual-matrix.mjs");
const realD6 = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/qa-visual/c24-cache-read-failure.json"), "utf8"));

// ------------------------------------------------------------------------------------------------ imagens sintéticas
type Img = { width: number; height: number; data: Uint8ClampedArray };
function mk(w: number, h: number, bg = [255, 255, 255]): Img { const data = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255; } return { width: w, height: h, data }; }
function rect(img: Img, x: number, y: number, w: number, h: number, c: number[]) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) { const o = (j * img.width + i) * 4; img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255; } return img; }
const clone = (a: Img): Img => ({ width: a.width, height: a.height, data: new Uint8ClampedArray(a.data) });
/** "página" sintética: cabeçalho, botão e um campo largo com borda de 1px (os elementos que as regressões vão tocar). */
function page(): Img { const p = mk(200, 120); rect(p, 0, 0, 200, 20, [30, 30, 30]); rect(p, 10, 40, 60, 24, [29, 78, 216]); rect(p, 10, 80, 180, 1, [120, 120, 120]); rect(p, 10, 100, 180, 1, [120, 120, 120]); rect(p, 10, 80, 1, 21, [120, 120, 120]); rect(p, 189, 80, 1, 21, [120, 120, 120]); return p; }

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "levora-qa-visual-test-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

// ================================================================================================ PNG
describe("codec PNG", () => {
  it("ida e volta preserva cada pixel e a codificação é determinística (mesmos bytes → mesmo SHA-256)", () => {
    const a = page(); const b1 = png.encodePng(a); const b2 = png.encodePng(a); const d = png.decodePng(b1);
    expect(b1.equals(b2)).toBe(true); expect(d.width).toBe(200); expect(d.height).toBe(120); expect(Buffer.from(d.data).equals(Buffer.from(a.data))).toBe(true);
  });
  it("recusa arquivo que não é PNG, truncado e com CRC adulterado (nunca vira imagem)", () => {
    const b = png.encodePng(page());
    expect(() => png.decodePng(Buffer.from("isto não é um png de jeito nenhum, mesmo"))).toThrow(/assinatura|PNG/);
    expect(() => png.decodePng(b.subarray(0, b.length - 20))).toThrow(); // IEND cortado
    const bad = Buffer.from(b); bad[bad.length - 1] ^= 0xff; // CRC do IEND adulterado: só a checagem de CRC pega (os dados continuam descomprimindo)
    try { png.decodePng(bad); expect.unreachable(); } catch (e: any) { expect(e.name).toBe("PngError"); expect(e.code).toBe("BAD_CRC"); }
    const bad2 = Buffer.from(b); bad2[20] ^= 0x01; // altura no IHDR alterada: CRC do IHDR não confere
    try { png.readHeader(bad2); expect.unreachable(); } catch (e: any) { expect(e.code).toBe("BAD_CRC"); }
  });
  it("dados de imagem corrompidos com CRC válido são recusados (BAD_DATA)", () => {
    const b = Buffer.from(png.encodePng(page())); const idat = b.indexOf("IDAT"); const len = b.readUInt32BE(idat - 4);
    for (let i = 0; i < len; i++) b[idat + 4 + i] = 0x55; b.writeUInt32BE(png.crc32(b, idat, idat + 4 + len), idat + 4 + len);
    expect(() => png.decodePng(b)).toThrow(/corrompid|tamanho/);
  });
  it("recusa PNG entrelaçado e profundidade ≠ 8 bits com mensagem clara", () => {
    const b = Buffer.from(png.encodePng(mk(2, 2))); b[28] = 1; b.writeUInt32BE(png.crc32(b, 12, 29), 29);
    expect(() => png.decodePng(b)).toThrow(/entrelaçado/);
  });
  it("buffer RGBA inconsistente não é codificado", () => { expect(() => png.encodePng({ width: 3, height: 3, data: new Uint8ClampedArray(5) })).toThrow(); });
});

// ================================================================================================ comparação pixel a pixel
describe("comparação pixel a pixel (imagediff)", () => {
  it("imagens idênticas → IDENTICAL, 0 pixels", () => { const r = diff.compareImages(page(), page()); expect(r.verdict).toBe("IDENTICAL"); expect(r.metrics.diffPixels).toBe(0); expect(r.metrics.shape).toBe("none"); });
  it("UM pixel de cor muito diferente já é regressão com a tolerância padrão (0/0)", () => { const b = page(); const c = clone(b); rect(c, 100, 60, 1, 1, [255, 0, 0]); const r = diff.compareImages(b, c); expect(r.verdict).toBe("DIFFERENT"); expect(r.metrics.diffPixels).toBe(1); expect(r.metrics.bbox).toEqual({ x: 100, y: 60, w: 1, h: 1 }); });
  it("borda de 1px de um campo largo que some (≈0,6% da página) NÃO passa: tolerância percentual alta esconderia isto", () => {
    const b = page(); const c = clone(b); rect(c, 10, 100, 180, 1, [255, 255, 255]); const r = diff.compareImages(b, c);
    expect(r.verdict).toBe("DIFFERENT"); expect(r.metrics.diffPixels).toBeGreaterThanOrEqual(170); expect(r.metrics.diffRatio).toBeLessThan(0.01);
  });
  it("elemento deslocado 4px é regressão (anti-aliasing não absorve deslocamento real)", () => { const b = page(); const c = mk(200, 120); rect(c, 0, 0, 200, 20, [30, 30, 30]); rect(c, 14, 40, 60, 24, [29, 78, 216]); rect(c, 10, 80, 180, 1, [120, 120, 120]); rect(c, 10, 100, 180, 1, [120, 120, 120]); rect(c, 10, 80, 1, 21, [120, 120, 120]); rect(c, 189, 80, 1, 21, [120, 120, 120]); const r = diff.compareImages(b, c); expect(r.verdict).toBe("DIFFERENT"); expect(r.metrics.shape).toBe("shape"); });
  it("M11: jitter/deslocamento de 1px NÃO passa no padrão estrito (era tolerado como anti-aliasing); só com antiAliasing:true explícito é contado à parte", () => { const b = page(); const c = clone(b); rect(c, 10, 40, 60, 1, [255, 255, 255]); rect(c, 10, 64, 60, 1, [29, 78, 216]); const strict = diff.compareImages(b, c); expect(strict.verdict).toBe("DIFFERENT"); expect(strict.metrics.aaTolerated).toBe(0); const aa = diff.compareImages(b, c, { tolerance: diff.LEGACY_PERCEPTUAL_TOLERANCE }); expect(aa.metrics.aaTolerated).toBeGreaterThan(0); });
  it("M11: diferença de 1 nível por canal é DIFERENTE no padrão estrito; só a política antiga (explícita) a tratava como imperceptível", () => { const b = page(); const c = clone(b); rect(c, 10, 40, 60, 24, [30, 79, 217]); const r = diff.compareImages(b, c); expect(r.verdict).toBe("DIFFERENT"); expect(r.metrics.exactDiffPixels).toBe(60 * 24); const legacy = diff.compareImages(b, c, { tolerance: diff.LEGACY_PERCEPTUAL_TOLERANCE }); expect(legacy.verdict).toBe("WITHIN_TOLERANCE"); expect(legacy.metrics.diffPixels).toBe(0); });
  it("mudança de cor sem mudar a forma é classificada como color-only; deslocamento como shape", () => { const b = page(); const c = clone(b); rect(c, 10, 40, 60, 24, [185, 28, 28]); const r = diff.compareImages(b, c); expect(r.verdict).toBe("DIFFERENT"); expect(r.metrics.shape).toBe("color-only"); expect(r.metrics.meanDelta).toBeGreaterThan(0.05); });
  it("tolerância explícita: maxDiffPixels/maxClusterPixels acima do medido → WITHIN_TOLERANCE; abaixo → DIFFERENT", () => {
    const b = page(); const c = clone(b); rect(c, 100, 60, 3, 3, [255, 0, 0]);
    expect(diff.compareImages(b, c, { tolerance: { maxDiffPixels: 9, maxClusterPixels: 9 } }).verdict).toBe("WITHIN_TOLERANCE");
    expect(diff.compareImages(b, c, { tolerance: { maxDiffPixels: 8, maxClusterPixels: 9 } }).verdict).toBe("DIFFERENT");
    expect(diff.compareImages(b, c, { tolerance: { maxDiffPixels: 9, maxClusterPixels: 8 } }).verdict).toBe("DIFFERENT");
    expect(() => diff.compareImages(b, c, { tolerance: { pixelThreshold: 2 } })).toThrow(RangeError);
  });
  it("dimensões diferentes → DIMENSION_MISMATCH (não compara pixels como se fossem a mesma imagem)", () => { const r = diff.compareImages(page(), mk(200, 140)); expect(r.verdict).toBe("DIMENSION_MISMATCH"); expect(r.reasons[0]).toMatch(/200x120.*200x140/); expect(r.diffImage.height).toBe(140); });
  it("máscara com justificativa ignora a região e é contada; sem justificativa, fora da imagem ou vazia → erro", () => {
    const b = page(); const c = clone(b); rect(c, 100, 60, 10, 10, [255, 0, 0]);
    const ok = diff.compareImages(b, c, { masks: [{ x: 95, y: 55, w: 30, h: 30, reason: "relógio dinâmico do cabeçalho" }] }); expect(ok.verdict).toBe("IDENTICAL"); expect(ok.metrics.masked).toBe(900);
    expect(() => diff.compareImages(b, c, { masks: [{ x: 0, y: 0, w: 5, h: 5 }] })).toThrow(/justificativa/);
    expect(() => diff.compareImages(b, c, { masks: [{ x: 0, y: 0, w: 5, h: 5, reason: "x" }] })).toThrow(/justificativa/);
    expect(() => diff.compareImages(b, c, { masks: [{ x: 190, y: 0, w: 30, h: 5, reason: "fora da imagem de propósito" }] })).toThrow(/fora da imagem/);
  });
  it("imagem de diferença tem o tamanho da página e marca os pixels em vermelho; o painel junta referência | atual | diferença", () => {
    const b = page(); const c = clone(b); rect(c, 100, 60, 2, 2, [255, 0, 0]); const r = diff.compareImages(b, c); const o = (60 * 200 + 100) * 4;
    expect(r.diffImage.width).toBe(200); expect([r.diffImage.data[o], r.diffImage.data[o + 1], r.diffImage.data[o + 2]]).toEqual([255, 0, 64]);
    const t = diff.triptych(b, c, r.diffImage, 10); expect(t.width).toBe(200 * 3 + 20); expect(t.height).toBe(120);
  });
  it("agrupa a diferença em aglomerados com caixa delimitadora", () => { const b = page(); const c = clone(b); rect(c, 20, 90, 4, 4, [255, 0, 0]); rect(c, 150, 30, 4, 4, [0, 255, 0]); const r = diff.compareImages(b, c); expect(r.clusters.length).toBe(2); expect(r.metrics.largestCluster).toBe(16); });
});

// ================================================================================================ impressão de layout
describe("impressão de layout (fingerprint)", () => {
  const el = (key: string, o: any = {}) => ({ key, pk: null, tag: "DIV", role: "", text: key, visible: true, x: 10, y: 10, w: 100, h: 20, color: "rgb(0,0,0)", bg: "rgba(0,0,0,0)", font: "Arial", size: "16px", weight: "400", lh: "20px", display: "block", clipped: false, overflow: "visible/visible", ...o });
  const fp = (els: any[], doc = { w: 400, h: 300 }) => ({ count: els.length, truncated: false, doc, elements: els });
  const types = (r: any) => r.findings.map((f: any) => f.type);
  const base = () => fp([el("a"), el("b", { y: 40 }), el("c", { y: 70 })]);
  it("idêntica → nenhum achado", () => { expect(fpm.compareFingerprints(base(), base()).findings).toEqual([]); });
  it("removido e oculto são estruturais", () => { const cur = fp([el("a"), el("b", { y: 40, visible: false })]); const r = fpm.compareFingerprints(base(), cur); expect(types(r)).toContain("hidden"); expect(types(r)).toContain("removed"); expect(r.summary.structural).toBe(2); });
  it("deslocamento e redimensionamento acima de 1px", () => { const cur = fp([el("a", { x: 18 }), el("b", { y: 40, w: 130 }), el("c", { y: 70 })]); const r = fpm.compareFingerprints(base(), cur); expect(types(r)).toContain("moved"); expect(types(r)).toContain("resized"); });
  it("cor e tipografia", () => { const cur = fp([el("a", { color: "rgb(255,0,0)" }), el("b", { y: 40, size: "18px" }), el("c", { y: 70 })]); const r = fpm.compareFingerprints(base(), cur); expect(types(r)).toContain("color"); expect(types(r)).toContain("typography"); });
  it("conteúdo que passou a ser cortado e sobreposição nova são estruturais", () => { const cur = fp([el("a", { clipped: true }), el("b", { y: 40 }), el("c", { y: 45 })]); const r = fpm.compareFingerprints(base(), cur); expect(types(r)).toContain("clipped"); expect(types(r)).toContain("overlap"); expect(r.summary.structural).toBeGreaterThanOrEqual(2); });
  it("espaçamento entre irmãos que mudou", () => { const b = fp([el("p", { pk: null }), el("a", { pk: "p", y: 10 }), el("b", { pk: "p", y: 40 })]); const c = fp([el("p", { pk: null }), el("a", { pk: "p", y: 10 }), el("b", { pk: "p", y: 60 })]); expect(types(fpm.compareFingerprints(b, c))).toContain("spacing"); });
  it("documento mais largo é estrutural", () => { const r = fpm.compareFingerprints(base(), fp(base().elements, { w: 600, h: 300 })); expect(r.findings.some((f: any) => f.type === "document-size" && f.severity === "structural")).toBe(true); });
  it("a coleta mascara e-mails e nunca usa o valor digitado de campos", () => { expect(fpm.FINGERPRINT_SOURCE).toContain("<email>"); expect(fpm.FINGERPRINT_SOURCE).not.toMatch(/el\.value/); });
});

// ================================================================================================ baselines
describe("baselines: candidata × aprovada × stale × corrompida", () => {
  const meta = (o: any = {}) => ({ pageId: "painel", browser: "chrome", browserVersion: "Chrome/157.0.8103.26", viewport: "1280x900", theme: "light", sourceSha: "a".repeat(40), captureConfigVersion: "cc-1", route: "/painel", auth: { user: "guest", sessionCookie: false }, width: 200, height: 120, ...o });
  const key = (o: any = {}) => ({ pageId: "painel", browser: "chrome", viewport: "1280x900", theme: "light", ...o });
  const ctx = { captureConfigVersion: "cc-1", version: "Chrome/157.0.8103.26" };
  const add = (o: any = {}, img = page()) => bl.addCandidate(tmp, meta(o), png.encodePng(img), { count: 0, elements: [], doc: { w: 1, h: 1 } });

  it("uma captura nasce CANDIDATE e NÃO serve de referência (CANDIDATE_ONLY); sem nada é MISSING_BASELINE", () => {
    expect(bl.resolveBaseline(tmp, key(), ctx).status).toBe("MISSING_BASELINE");
    const { entry, created } = add(); expect(created).toBe(true); expect(entry.state).toBe("CANDIDATE");
    const r = bl.resolveBaseline(tmp, key(), ctx); expect(r.status).toBe("CANDIDATE_ONLY"); expect(r.png).toBeUndefined();
  });
  it("aprovação exige revisor, uma candidata existente com o SHA-256 certo e o arquivo íntegro", () => {
    const { entry } = add();
    expect(() => bl.approveBaseline(tmp, { id: entry.id, imageSha256: entry.imageSha256 })).toThrow(/revisor/);
    expect(() => bl.approveBaseline(tmp, { id: entry.id, imageSha256: "0".repeat(64), reviewer: "Ana" })).toThrow(/não há candidata/);
    writeFileSync(path.join(tmp, entry.file), Buffer.from("adulterado")); expect(() => bl.approveBaseline(tmp, { id: entry.id, imageSha256: entry.imageSha256, reviewer: "Ana" })).toThrow(/não confere/);
  });
  it("aprovada válida resolve APPROVED com a imagem e o hash; registra quem aprovou e quando", () => {
    const { entry } = add(); const a = bl.approveBaseline(tmp, { id: entry.id, imageSha256: entry.imageSha256, reviewer: "Ana", note: "revisado lado a lado" });
    expect(a.state).toBe("APPROVED"); expect(a.approvedBy).toBe("Ana"); expect(a.approvedAt).toBeTruthy();
    const r = bl.resolveBaseline(tmp, key(), ctx); expect(r.status).toBe("APPROVED"); expect(bl.sha256(r.png)).toBe(entry.imageSha256);
  });
  it("nova captura diferente NÃO substitui a aprovada: vira candidata com `supersedes`, e trocar exige replace explícito (a antiga fica SUPERSEDED)", () => {
    const a = add(); bl.approveBaseline(tmp, { id: a.entry.id, imageSha256: a.entry.imageSha256, reviewer: "Ana" });
    const other = page(); rect(other, 10, 40, 60, 24, [185, 28, 28]); const b = add({}, other);
    expect(b.entry.state).toBe("CANDIDATE"); expect(b.entry.supersedes).toBe(a.entry.imageSha256);
    expect(bl.resolveBaseline(tmp, key(), ctx).entry.imageSha256).toBe(a.entry.imageSha256); // a aprovada continua valendo
    expect(() => bl.approveBaseline(tmp, { id: b.entry.id, imageSha256: b.entry.imageSha256, reviewer: "Ana" })).toThrow(/--replace/);
    bl.approveBaseline(tmp, { id: b.entry.id, imageSha256: b.entry.imageSha256, reviewer: "Ana", replace: true });
    const m = bl.loadManifest(tmp); expect(m.entries.filter((e: any) => e.state === "APPROVED")).toHaveLength(1); expect(m.entries.find((e: any) => e.imageSha256 === a.entry.imageSha256).state).toBe("SUPERSEDED");
    expect(bl.auditBaselines(tmp).issues).toEqual([]);
  });
  it("capturar a mesma imagem duas vezes não duplica; nada é sobrescrito no disco", () => { const a = add(); const b = add(); expect(b.created).toBe(false); expect(bl.loadManifest(tmp).entries).toHaveLength(1); expect(b.entry.file).toBe(a.entry.file); });
  it("STALE: configuração de captura diferente ou versão principal do navegador diferente", () => {
    const { entry } = add(); bl.approveBaseline(tmp, { id: entry.id, imageSha256: entry.imageSha256, reviewer: "Ana" });
    expect(bl.resolveBaseline(tmp, key(), { ...ctx, captureConfigVersion: "cc-2" }).status).toBe("STALE");
    expect(bl.resolveBaseline(tmp, key(), { ...ctx, version: "Chrome/158.0.1.1" }).status).toBe("STALE");
    expect(bl.resolveBaseline(tmp, key(), { ...ctx, version: "Chrome/157.0.9999.1" }).status).toBe("APPROVED"); // mesma versão principal
  });
  it("viewport e tema fazem parte da identidade: a aprovada de 1280/claro nunca é usada para 375/escuro", () => {
    const { entry } = add(); bl.approveBaseline(tmp, { id: entry.id, imageSha256: entry.imageSha256, reviewer: "Ana" });
    expect(bl.resolveBaseline(tmp, key({ viewport: "375x812" }), ctx).status).toBe("MISSING_BASELINE");
    expect(bl.resolveBaseline(tmp, key({ theme: "dark" }), ctx).status).toBe("MISSING_BASELINE");
    expect(bl.resolveBaseline(tmp, key({ browser: "edge" }), ctx).status).toBe("MISSING_BASELINE");
    expect(bl.resolveBaseline(tmp, key({ pageId: "outra" }), ctx).status).toBe("MISSING_BASELINE");
  });
  it("CORRUPT: arquivo adulterado ou ausente, e impressão de layout adulterada — nunca PASS silencioso", () => {
    const { entry } = add(); bl.approveBaseline(tmp, { id: entry.id, imageSha256: entry.imageSha256, reviewer: "Ana" });
    const f = path.join(tmp, entry.file); const original = readFileSync(f);
    writeFileSync(f, Buffer.concat([original, Buffer.from("x")])); expect(bl.resolveBaseline(tmp, key(), ctx).status).toBe("CORRUPT"); expect(bl.auditBaselines(tmp).issues.join()).toMatch(/SHA-256 diverge/);
    unlinkSync(f); expect(bl.resolveBaseline(tmp, key(), ctx).status).toBe("CORRUPT");
    writeFileSync(f, original); expect(bl.resolveBaseline(tmp, key(), ctx).status).toBe("APPROVED");
    writeFileSync(path.join(tmp, entry.fingerprintFile), "{}\n"); expect(bl.resolveBaseline(tmp, key(), ctx).status).toBe("CORRUPT");
  });
  it("manifesto ilegível ou de esquema desconhecido é erro, não 'sem baselines'", () => { writeFileSync(path.join(tmp, "manifest.json"), "{nao json"); expect(() => bl.loadManifest(tmp)).toThrow(/ilegível/); writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify({ schema: 9, entries: [] })); expect(() => bl.loadManifest(tmp)).toThrow(/esquema/); });
  it("metadados com segredo são recusados: cookie de sessão, Bearer, JWT, token do GitHub, senha, e-mail, valor secreto conhecido", () => {
    for (const bad of [{ route: "/x", note: "floot_built_app_session=abc123def456" }, { note: "Authorization: Bearer abcdefghijklmnop" }, { note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig" }, { note: "ghp_ABCDEFGHIJKLMNOPQRSTUVWX" }, { note: "password=hunter2" }, { note: "dono@exemplo.org" }])
      expect(() => bl.addCandidate(tmp, meta(bad), png.encodePng(page()), null)).toThrow(/segredo/);
    expect(() => bl.assertNoSecrets({ a: "tem-a-senha-qa-123" }, ["tem-a-senha-qa-123"])).toThrow(/segredo/);
    expect(() => bl.addCandidate(tmp, meta({ pageId: undefined }), png.encodePng(page()), null)).toThrow(/pageId/);
    expect(bl.loadManifest(tmp).entries).toHaveLength(0);
  });
  it("a impressão de layout gravada nunca contém e-mail/segredo (a auditoria também confere)", () => { const { entry } = add(); expect(readFileSync(path.join(tmp, entry.fingerprintFile), "utf8")).not.toMatch(/@/); expect(bl.auditBaselines(tmp).issues).toEqual([]); });
  it("identidade da célula e versão principal do navegador", () => { expect(bl.cellId({ pageId: "p", browser: "edge", viewport: "375x812", theme: "dark" })).toBe("p__edge__375x812__dark"); expect(bl.browserMajor("Edg/156.0.4314.58")).toBe(156); expect(bl.browserMajor(undefined)).toBeNull(); });
});

// ================================================================================================ resultado visual por célula
describe("classificação visual por célula (compareCaptured, saída)", () => {
  const approved = (img: Img) => ({ png: png.encodePng(img), fingerprint: null });
  const page0 = { id: "p" };
  it("pixels idênticos → VISUAL_PASS; qualquer diferença sem região declarada → VISUAL_REGRESSION (M11: padrão estrito)", () => {
    const b = page(); const same = vr.compareCaptured({ png: png.encodePng(page()), fingerprint: null, resolution: approved(b), page: page0 });
    expect(same.status).toBe("VISUAL_PASS"); expect(same.cause).toBe("IDENTICAL");
    const near = clone(b); rect(near, 10, 40, 60, 24, [30, 79, 217]); expect(vr.compareCaptured({ png: png.encodePng(near), fingerprint: null, resolution: approved(b), page: page0 }).status).toBe("VISUAL_REGRESSION"); // M11: sem região declarada, 1 nível reprova
    const far = clone(b); rect(far, 10, 40, 60, 24, [185, 28, 28]); const r = vr.compareCaptured({ png: png.encodePng(far), fingerprint: null, resolution: approved(b), page: page0 });
    expect(r.status).toBe("VISUAL_REGRESSION"); expect(r.detail).toMatch(/color-only/); expect(r.cmp.diffImage).toBeTruthy();
  });
  it("dimensões diferentes → VISUAL_REGRESSION (dimensions); tolerância por página só vale se declarada", () => {
    const b = page(); expect(vr.compareCaptured({ png: png.encodePng(mk(200, 130)), fingerprint: null, resolution: approved(b), page: page0 }).cause).toBe("DIMENSION_MISMATCH");
    const c = clone(b); rect(c, 100, 60, 2, 2, [255, 0, 0]);
    expect(vr.compareCaptured({ png: png.encodePng(c), fingerprint: null, resolution: approved(b), page: page0 }).status).toBe("VISUAL_REGRESSION");
    expect(vr.compareCaptured({ png: png.encodePng(c), fingerprint: null, resolution: approved(b), page: { id: "p", tolerance: { maxDiffPixels: 4, maxClusterPixels: 4 } } }).status).toBe("VISUAL_PASS");
  });
  it("imagem ilegível: a captura atual → INCONCLUSIVE; a baseline aprovada → BASELINE_CORRUPT", () => {
    const b = page();
    expect(vr.compareCaptured({ png: Buffer.from("lixo"), fingerprint: null, resolution: approved(b), page: page0 }).status).toBe("INCONCLUSIVE");
    expect(vr.compareCaptured({ png: png.encodePng(b), fingerprint: null, resolution: { png: Buffer.from("lixo"), fingerprint: null }, page: page0 }).status).toBe("BASELINE_CORRUPT");
  });
  it("achados de layout entram na explicação da regressão", () => {
    const b = page(); const c = clone(b); rect(c, 10, 40, 60, 24, [185, 28, 28]);
    const e = (o: any) => ({ key: "button||Salvar|1", pk: null, tag: "BUTTON", role: "", text: "Salvar", visible: true, x: 10, y: 40, w: 60, h: 24, color: "rgb(255,255,255)", bg: "rgb(29,78,216)", font: "Arial", size: "16px", weight: "400", lh: "20px", display: "block", clipped: false, overflow: "visible/visible", ...o });
    const r = vr.compareCaptured({ png: png.encodePng(c), fingerprint: { count: 1, doc: { w: 200, h: 120 }, elements: [e({ bg: "rgb(185,28,28)" })] }, resolution: { png: png.encodePng(b), fingerprint: { count: 1, doc: { w: 200, h: 120 }, elements: [e({})] } }, page: page0 });
    expect(r.detail).toMatch(/color×1/);
  });
  it("códigos de saída: 1 regressão/falha funcional > 2 inconclusivo/corrompida > 6 não homologado > 0 só com TODAS as células em VISUAL_PASS; vazio é inconclusivo", () => {
    const c = (s: string) => ({ status: s });
    expect(vr.visualExitCode([c("VISUAL_PASS"), c("VISUAL_PASS")])).toBe(0);
    expect(vr.visualExitCode([c("VISUAL_PASS"), c("MISSING_BASELINE")])).toBe(6);
    expect(vr.visualExitCode([c("VISUAL_PASS"), c("CANDIDATE_ONLY")])).toBe(6);
    expect(vr.visualExitCode([c("VISUAL_PASS"), c("STALE_BASELINE")])).toBe(6);
    expect(vr.visualExitCode([c("CANDIDATE_CREATED")])).toBe(6);
    expect(vr.visualExitCode([c("VISUAL_PASS"), c("INCONCLUSIVE"), c("MISSING_BASELINE")])).toBe(2);
    expect(vr.visualExitCode([c("BASELINE_CORRUPT")])).toBe(2);
    expect(vr.visualExitCode([c("INCONCLUSIVE"), c("VISUAL_REGRESSION"), c("MISSING_BASELINE")])).toBe(1);
    expect(vr.visualExitCode([c("FUNCTIONAL_FAIL")])).toBe(1);
    expect(vr.visualExitCode([])).toBe(2);
    expect(vr.summarizeVisual([c("VISUAL_PASS"), c("VISUAL_PASS"), c("INCONCLUSIVE")])).toMatchObject({ VISUAL_PASS: 2, INCONCLUSIVE: 1 });
  });
  it("relatório: JSON/Markdown/manifesto, sem homologar quando falta baseline, e evidência adulterada é detectada", () => {
    const cells = [{ id: "a", status: "VISUAL_PASS", detail: "ok", captured: { file: "screens/a.png" } }, { id: "b", status: "MISSING_BASELINE", detail: "sem" }];
    writeFileSync(path.join(tmp, "x"), "1"); const out = path.join(tmp, "rep"); const { report, exit } = vr.writeVisualReport(out, { meta: { mode: "compare", sourceSha: "a".repeat(40), browsers: [{ name: "chrome", version: "Chrome/157" }] }, cells });
    expect(exit).toBe(6); expect(report.homologado).toBe(false); expect(report.aviso).toMatch(/NÃO HOMOLOGADO/);
    expect(existsSync(path.join(out, "visual-report.md"))).toBe(true); expect(vr.verifyEvidence(out).bad).toEqual([]);
    writeFileSync(path.join(out, "visual-report.md"), "adulterado"); expect(vr.verifyEvidence(out).bad).toHaveLength(1);
  });
});

// ================================================================================================ D6 — saúde de carregamento
describe("D6: falha de carregamento × regressão de produto × elemento ausente", () => {
  const base = "http://127.0.0.1:5000";
  const mounted = { url: `${base}/org/1`, rootChildren: 3, visibleText: "Painel da organização" };
  const empty = { url: `${base}/org/1`, rootChildren: 0, visibleText: "" };
  const cls = (page: any, net: any = {}, extra: any = {}) => lh.classifyLoad({ baseUrl: base, expectedPath: "/org/1", page, net: { failed: [], http: [], ...net }, exceptions: [], ...extra });
  const failed = (p: string, error: string, type = "Script") => ({ url: `${base}${p}`, error, canceled: false, type });
  const http = (p: string, status: number, type = "Script") => ({ url: `${base}${p}`, status, type });

  it("EVIDÊNCIA REAL do C24 (#root vazio + 3× ERR_CACHE_READ_FAILURE em /@vite/client, /@react-refresh, /src/App.tsx) → UNMEASURABLE ambiental, nunca MISSING", () => {
    const r = lh.classifyLoad({ baseUrl: "http://127.0.0.1:55711", expectedPath: realD6.route, page: realD6.page, net: { failed: realD6.net.failed, http: realD6.net.http4xx5xx }, exceptions: realD6.exceptions });
    expect(realD6.page.rootChildren).toBe(0); expect(realD6.net.failed).toHaveLength(3); expect(realD6.net.failed.every((f: any) => f.error === "net::ERR_CACHE_READ_FAILURE")).toBe(true);
    expect(r.verdict).toBe("UNMEASURABLE"); expect(r.cause).toBe("environment-resource-load-failed"); expect(r.detail).toMatch(/ERR_CACHE_READ_FAILURE/); expect(r.mounted).toBe(false);
  });
  it("página montada na rota esperada → MEASURABLE (aí o elemento ausente é MISSING de verdade)", () => { const r = cls(mounted); expect(r.verdict).toBe("MEASURABLE"); expect(r.cause).toBe("mounted"); });
  it("falha de imagem/fonte/API não impede a medição quando o app montou", () => { expect(cls(mounted, { failed: [failed("/logo.png", "net::ERR_FAILED", "Image"), failed("/_api/x", "net::ERR_CONNECTION_RESET", "Fetch")] }).verdict).toBe("MEASURABLE"); });
  it("não montou + rede/cache em recurso crítico → UNMEASURABLE (ERR_CACHE_*, CONNECTION_*, EMPTY_RESPONSE, CONTENT_LENGTH_MISMATCH, TIMED_OUT)", () => {
    for (const e of ["net::ERR_CACHE_READ_FAILURE", "net::ERR_CONNECTION_RESET", "net::ERR_EMPTY_RESPONSE", "net::ERR_CONTENT_LENGTH_MISMATCH", "net::ERR_TIMED_OUT", "net::ERR_FAILED", "net::ERR_INTERNET_DISCONNECTED"]) {
      const r = cls(empty, { failed: [failed("/src/App.tsx", e)] }); expect(r.verdict, e).toBe("UNMEASURABLE"); expect(r.cause, e).toBe("environment-resource-load-failed");
    }
  });
  it("não montou + recurso crítico com erro HTTP do produto (404/500/403) → FAIL; 502/503/504 → UNMEASURABLE (infra)", () => {
    for (const s of [404, 500, 403, 400]) { const r = cls(empty, { http: [http("/src/App.tsx", s)] }); expect(r.verdict, String(s)).toBe("FAIL"); expect(r.cause).toBe("critical-resource-http-error"); }
    for (const s of [502, 503, 504]) { const r = cls(empty, { http: [http("/@vite/client", s)] }); expect(r.verdict, String(s)).toBe("UNMEASURABLE"); expect(r.cause).toBe("environment-gateway-unavailable"); }
  });
  it("bloqueio imposto pelo próprio produto (CSP/redirecionamento inválido) → FAIL", () => { expect(cls(empty, { failed: [failed("/src/App.tsx", "net::ERR_BLOCKED_BY_CSP")] }).verdict).toBe("FAIL"); expect(cls(empty, { failed: [failed("/src/App.tsx", "net::ERR_UNSAFE_REDIRECT")] }).cause).toBe("critical-resource-blocked-by-product"); });
  it("evidência de PRODUTO vence a de ambiente quando coexistem (nunca reduz severidade sem prova)", () => {
    const r = cls(empty, { failed: [failed("/src/a.ts", "net::ERR_CACHE_READ_FAILURE")], http: [http("/src/App.tsx", 404)] }); expect(r.verdict).toBe("FAIL");
    expect(cls(empty, { failed: [failed("/src/a.ts", "net::ERR_CACHE_READ_FAILURE")], http: [http("/src/App.tsx", 503)] }).verdict).toBe("UNMEASURABLE");
  });
  it("exceção ao montar sem falha de rede que a explique → FAIL; com falha de rede, a exceção é consequência → UNMEASURABLE", () => {
    expect(cls(empty, {}, { exceptions: ["Error: x is not a function"] }).cause).toBe("app-crashed-on-mount");
    expect(cls(empty, { failed: [failed("/src/App.tsx", "net::ERR_CACHE_READ_FAILURE")] }, { exceptions: ["TypeError: Failed to fetch dynamically imported module"] }).verdict).toBe("UNMEASURABLE");
  });
  it("não montou sem NENHUMA evidência → UNMEASURABLE not-mounted-no-evidence (não afirma defeito do produto e não é aprovação)", () => { const r = cls(empty); expect(r.verdict).toBe("UNMEASURABLE"); expect(r.cause).toBe("not-mounted-no-evidence"); });
  it("tipo de erro de rede desconhecido não vira defeito de produto sem prova", () => { const r = cls(empty, { failed: [failed("/src/App.tsx", "net::ERR_ALGO_NOVO")] }); expect(r.verdict).toBe("UNMEASURABLE"); expect(r.cause).toBe("unknown-network-error"); });
  it("redirecionamento indevido → FAIL (montada ou não); inclui a falha de autenticação do produto que termina em /login", () => {
    expect(cls({ url: `${base}/outra-rota`, rootChildren: 2, visibleText: "Outra" }).cause).toBe("unexpected-redirect");
    expect(cls({ url: `${base}/login`, rootChildren: 2, visibleText: "Entrar" }).verdict).toBe("FAIL");
    expect(cls({ url: `${base}/outra-rota`, rootChildren: 0, visibleText: "" }).verdict).toBe("FAIL");
    expect(cls({ url: `${base}/org/1/?x=1#h`, rootChildren: 2, visibleText: "Ok" }).verdict).toBe("MEASURABLE"); // query/hash/barra final não são redirecionamento
  });
  it("página de erro do produto (Acesso negado, etc.) no lugar do conteúdo → FAIL", () => { for (const t of ["Acesso negado\nVocê não pode", "Página não encontrada", "Algo deu errado", "Erro inesperado"]) expect(cls({ ...mounted, visibleText: t }).cause, t).toBe("unexpected-error-page"); expect(cls({ ...mounted, visibleText: "Painel — acesso negado em 2 itens" }).verdict).toBe("MEASURABLE"); });
  it("bloqueio proposital do cenário (blockUrls → ERR_BLOCKED_BY_CLIENT) não conta como falha de carregamento", () => {
    expect(cls(empty, { failed: [failed("/src/App.tsx", "net::ERR_BLOCKED_BY_CLIENT")] }, { scenarioBlocksUrls: true }).cause).toBe("not-mounted-no-evidence");
    expect(cls(empty, { failed: [failed("/src/App.tsx", "net::ERR_BLOCKED_BY_CLIENT")] }, { scenarioBlocksUrls: false }).verdict).toBe("UNMEASURABLE");
  });
  it("recurso crítico = documento/script/CSS da própria origem; de outra origem ou imagem não é", () => {
    expect(lh.isCritical({ url: `${base}/src/App.tsx`, type: "Script" }, base)).toBe(true); expect(lh.isCritical({ url: `${base}/@vite/client` }, base)).toBe(true); expect(lh.isCritical({ url: `${base}/a.css` }, base)).toBe(true);
    expect(lh.isCritical({ url: "https://cdn.exemplo.org/x.js", type: "Script" }, base)).toBe(false); expect(lh.isCritical({ url: `${base}/logo.png`, type: "Image" }, base)).toBe(false);
  });
  it("módulo com resposta 503 + loadingFailed (comportamento real do Chromium): a RESPOSTA HTTP vale como evidência, não a falha de rede", () => {
    const ev = [{ method: "Network.requestWillBeSent", params: { requestId: "9", type: "Script", request: { url: base + "/app.js" } } }, { method: "Network.responseReceived", params: { requestId: "9", type: "Script", response: { url: base + "/app.js", status: 503 } } },
      { method: "Network.loadingFailed", params: { requestId: "9", errorText: "net::ERR_ABORTED", canceled: false } }];
    const e = lh.extractLoadEvidence(ev, base); expect(e.failed).toHaveLength(0); expect(e.http[0].status).toBe(503);
    expect(lh.classifyLoad({ baseUrl: base, expectedPath: "/org/1", page: empty, net: { failed: e.failed, http: e.http }, exceptions: [] }).cause).toBe("environment-gateway-unavailable");
    const e404 = lh.extractLoadEvidence(ev.map((x: any) => (x.method === "Network.responseReceived" ? { ...x, params: { ...x.params, response: { url: base + "/app.js", status: 404 } } } : x)), base);
    expect(lh.classifyLoad({ baseUrl: base, expectedPath: "/org/1", page: empty, net: { failed: e404.failed, http: e404.http }, exceptions: [] }).cause).toBe("critical-resource-http-error");
  });
  it("extrai a evidência dos eventos CDP brutos (tipo do recurso, falha, HTTP, exceção)", () => {
    const ev = [{ method: "Network.requestWillBeSent", params: { requestId: "1", type: "Script", request: { url: `${base}/src/App.tsx?t=1` } } }, { method: "Network.loadingFailed", params: { requestId: "1", errorText: "net::ERR_CACHE_READ_FAILURE", canceled: false } },
      { method: "Network.requestWillBeSent", params: { requestId: "2", type: "Script", request: { url: `${base}/src/b.ts` } } }, { method: "Network.responseReceived", params: { requestId: "2", type: "Script", response: { url: `${base}/src/b.ts`, status: 500 } } },
      { method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom" } } } }];
    const e = lh.extractLoadEvidence(ev, base); expect(e.failed[0]).toMatchObject({ error: "net::ERR_CACHE_READ_FAILURE", type: "Script", url: `${base}/src/App.tsx` }); expect(e.http[0].status).toBe(500); expect(e.exceptions[0]).toMatch(/boom/);
    expect(lh.classifyLoad({ baseUrl: base, expectedPath: "/org/1", page: empty, net: { failed: e.failed, http: e.http }, exceptions: e.exceptions }).verdict).toBe("FAIL");
  });
});

// ================================================================================================ matriz e configuração de captura
describe("matriz visual e configuração de captura", () => {
  it("14 páginas únicas × 2 viewports × 2 temas; cada página tem rota, usuário e âncora (prova de que montou) e vem de um cenário funcional existente", () => {
    const ids = matrix.VISUAL_PAGES.map((p: any) => p.id); expect(new Set(ids).size).toBe(ids.length); expect(ids.length).toBe(14);
    for (const p of matrix.VISUAL_PAGES) { expect(p.path.startsWith("/")).toBe(true); expect(["guest", "owner", "volunteer"]).toContain(p.user); expect(p.target?.css).toBeTruthy(); expect(p.fromScenario).toBeTruthy(); }
    expect(matrix.VISUAL_VIEWPORTS.map((v: any) => `${v.w}x${v.h}`)).toEqual(["375x812", "1280x900"]); expect(matrix.VISUAL_THEMES).toEqual(["light", "dark"]);
    expect(matrix.VISUAL_PAGES.length * matrix.VISUAL_VIEWPORTS.length * matrix.VISUAL_THEMES.length * 2).toBe(112); // × Chrome e Edge
  });
  it("nenhuma página declara tolerância ou máscara sem justificativa (why)", () => { for (const p of matrix.VISUAL_PAGES) { if (p.tolerance) expect(p.why, p.id).toBeTruthy(); for (const m of p.masks ?? []) expect(m.reason, p.id).toBeTruthy(); } });
  it("seleção de páginas valida os ids", () => { expect(matrix.selectPages(matrix.VISUAL_PAGES, "login,matching").map((p: any) => p.id)).toEqual(["login", "matching"]); expect(() => matrix.selectPages(matrix.VISUAL_PAGES, "inexistente")).toThrow(/desconhecida/); });
  it("texto dinâmico: datas, data+hora, horas e ISO viram dígitos 0 (formato preservado); números que não são data/hora ficam intactos", () => {
    const n = (s: string) => cap.normalizeDynamicText(s);
    expect(n("Criado em 04/11/2026, 14:47:03").text).toBe("Criado em 00/00/0000, 00:00:00"); expect(n("Criado em 04/11/2026, 14:47:03").matches).toEqual(["data"]);
    expect(n("vence em 04/11/2026 19:47").text).toBe("vence em 00/00/0000 00:00"); expect(n("às 09:05").text).toBe("às 00:00"); expect(n("2026-11-04T19:47:00").text).toBe("0000-00-00T00:00:00");
    expect(n("2026-11-04").matches).toEqual(["iso"]); expect(n("14:47").matches).toEqual(["hora"]);
    for (const intacto of ["Qtd 12", "R$ 12,50", "5 kg", "v1.2.3", "(11) 91234-5678", "2026", "Lote 2026-ABC", "100%", "id 12345", "1.234,56", "Arroz 25/12 kg"]) expect(n(intacto).text, intacto).toBe(intacto);
    expect(n("sem nada").matches).toEqual([]); expect(n("04/11/2026 e 05/11/2026").matches).toEqual(["data", "data"]);
  });
  it("modo de captura por página: só o diálogo captura o viewport, com justificativa; a versão de configuração do modo difere da padrão", () => {
    const over = matrix.VISUAL_PAGES.filter((p: any) => p.capture); expect(over.map((p: any) => p.id)).toEqual(["necessidades-dialogo-editar", "atribuicoes-dropzone"]); for (const o of over) { expect(o.capture).toEqual({ fullPage: false }); expect(o.captureNote).toMatch(/viewport/); }
    expect(cap.captureConfigVersion({ ...cap.CAPTURE_CONFIG, ...over[0].capture })).not.toBe(cap.captureConfigVersion());
  });
  it("o texto dinâmico faz parte da identidade da configuração de captura (mudar o critério invalida baselines)", () => {
    const v0 = cap.captureConfigVersion(); expect(cap.captureConfigVersion({ ...cap.CAPTURE_CONFIG, dynamicText: { ...cap.DYNAMIC_TEXT, version: "v2" } })).not.toBe(v0); expect(cap.CAPTURE_CONFIG.dynamicText).toBe(cap.DYNAMIC_TEXT);
  });
  it("estabilidade entre capturas consecutivas: idênticas ou só ruído imperceptível (±1 nível) são estáveis; mudança perceptível, outra dimensão ou arquivo ilegível não", () => {
    const base = page(); const b1 = png.encodePng(base);
    expect(cap.stableBetween(b1, png.encodePng(page()))).toMatchObject({ stable: true, mode: "identical" });
    const noise = clone(base); rect(noise, 100, 60, 2, 20, [254, 255, 255]); const s1 = cap.stableBetween(b1, png.encodePng(noise)); expect(s1).toMatchObject({ stable: true, mode: "imperceptible" }); expect(s1.exact).toBe(40);
    const real = clone(base); rect(real, 100, 60, 4, 4, [255, 0, 0]); expect(cap.stableBetween(b1, png.encodePng(real))).toMatchObject({ stable: false, mode: "different" });
    expect(cap.stableBetween(b1, png.encodePng(mk(200, 130)))).toMatchObject({ stable: false, mode: "dimensions" });
    expect(cap.stableBetween(b1, Buffer.from("lixo"))).toMatchObject({ stable: false, mode: "unreadable" });
  });
  it("a versão da configuração de captura muda quando a configuração muda (as baselines antigas ficam STALE)", () => {
    const v0 = cap.captureConfigVersion(); expect(v0).toMatch(/^cc-[0-9a-f]{10}$/); expect(cap.captureConfigVersion({ ...cap.CAPTURE_CONFIG, fullPage: false })).not.toBe(v0); expect(cap.captureConfigVersion({ ...cap.CAPTURE_CONFIG, freezeCss: "" })).not.toBe(v0); expect(cap.captureConfigVersion()).toBe(v0);
  });
});

// M09: o banco de QA fixa a ordenação (C): a ordem de itens com ORDER BY name não pode depender do locale do cluster (achado: pt-BR → Água, Arroz, Lenço; C → Arroz, Lenço, Água)
describe("banco de QA com ordenação fixada (reprodutibilidade entre ambientes)", () => {
  it("CREATE DATABASE usa template0 e LC_COLLATE/LC_CTYPE 'C'", () => {
    const src = readFileSync(path.join(ROOT, "lib/stack.mjs"), "utf8");
    expect(src).toContain("TEMPLATE template0");
    expect(src).toContain("LC_COLLATE 'C'");
    expect(src).toContain("LC_CTYPE 'C'");
  });
});
