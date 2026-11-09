/**
 * Testes UNITÁRIOS da revisão assistida das baselines (M02): análise de problemas por candidata, comparação Chrome × Edge, determinismo entre execuções e a galeria HTML.
 * Sem navegador e sem banco. QA_VISUAL_ROOT (opcional) aponta para uma cópia sabotada (mutantes).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const ROOT = process.env.QA_VISUAL_ROOT ?? path.resolve(__dirname, "../scripts/qa-visual");
const load = (rel: string) => import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href);
const png = await load("lib/png.mjs");
const rv = await load("lib/review.mjs");
const gal = await load("lib/gallery.mjs");
const bl = await load("lib/baseline.mjs");

type Img = { width: number; height: number; data: Uint8ClampedArray };
const mk = (w: number, h: number, bg = [255, 255, 255]): Img => { const data = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255; } return { width: w, height: h, data }; };
const rect = (img: Img, x: number, y: number, w: number, h: number, c: number[]) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) { const o = (j * img.width + i) * 4; img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; } return img; };
const light = (): Img => { const p = mk(200, 120); rect(p, 0, 0, 200, 20, [30, 30, 30]); rect(p, 10, 40, 60, 24, [29, 78, 216]); return p; };
const dark = (): Img => { const p = mk(200, 120, [17, 17, 17]); rect(p, 10, 40, 60, 24, [29, 78, 216]); rect(p, 100, 40, 60, 24, [230, 230, 230]); return p; };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let tmp: string;
let ledgerDir = ""; const OLD_LEDGER = process.env.QA_APPROVAL_LEDGER; // M19
beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "levora-qa-review-test-")); ledgerDir = mkdtempSync(path.join(tmpdir(), "levora-qa-ledger-test-")); process.env.QA_APPROVAL_LEDGER = path.join(ledgerDir, "approvals.jsonl"); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); rmSync(ledgerDir, { recursive: true, force: true }); if (OLD_LEDGER === undefined) delete process.env.QA_APPROVAL_LEDGER; else process.env.QA_APPROVAL_LEDGER = OLD_LEDGER; });

const el = (o: any = {}) => ({ key: "k" + Math.random(), pk: null, tag: "DIV", role: "", text: "texto", visible: true, x: 10, y: 10, w: 100, h: 20, color: "rgb(0,0,0)", bg: "rgba(0,0,0,0)", font: "Arial", size: "16px", weight: "400", lh: "20px", display: "block", clipped: false, overflow: "visible/visible", ...o });
const fp = (els: any[], doc = { w: 375, h: 600 }) => ({ count: els.length, truncated: false, doc, elements: els });
const six = () => [1, 2, 3, 4, 5, 6].map((i) => el({ key: "e" + i, text: "t" + i, y: i * 30 }));
const meta = (o: any = {}) => ({ viewport: "375x812", theme: "light", truncatedHeight: false, ...o });
const kinds = (r: any[]) => r.map((i) => i.kind);

describe("análise de problemas por candidata", () => {
  it("página limpa → nenhum problema", () => { expect(rv.analyzeCandidate({ meta: meta(), fingerprint: fp(six()), image: light() })).toEqual([]); });
  it("rolagem horizontal: largura rolável maior que o viewport", () => { const r = rv.analyzeCandidate({ meta: meta(), fingerprint: fp(six(), { w: 520, h: 600 }) }); expect(kinds(r)).toContain("horizontal-overflow"); expect(r.find((i: any) => i.kind === "horizontal-overflow").severity).toBe("high"); });
  it("botão fora da tela é high; texto comum fora da tela não é controle", () => {
    expect(kinds(rv.analyzeCandidate({ meta: meta(), fingerprint: fp([...six(), el({ tag: "BUTTON", text: "Salvar", x: 340, w: 80 })]) }))).toContain("offscreen-control");
    expect(kinds(rv.analyzeCandidate({ meta: meta(), fingerprint: fp([...six(), el({ tag: "P", x: 340, w: 80 })]) }))).not.toContain("offscreen-control");
    // M05: aba fora da tela dentro de um contêiner com rolagem horizontal é o comportamento previsto (barra de abas), mas o mesmo botão fora da tela SEM contêiner continua sendo defeito
    expect(kinds(rv.analyzeCandidate({ meta: meta(), fingerprint: fp([...six(), el({ tag: "A", text: "Aba", x: 340, w: 80, hscroll: true })]) }))).not.toContain("offscreen-control");
    expect(kinds(rv.analyzeCandidate({ meta: meta(), fingerprint: fp([...six(), el({ tag: "A", text: "Aba", x: 340, w: 80, hscroll: false })]) }))).toContain("offscreen-control");
  });
  it("página quase vazia, conteúdo cortado, sobreposição e texto pequeno", () => {
    expect(kinds(rv.analyzeCandidate({ meta: meta(), fingerprint: fp([el()]) }))).toContain("nearly-empty");
    expect(kinds(rv.analyzeCandidate({ meta: meta(), fingerprint: fp([...six(), el({ clipped: true, text: "cortado" })]) }))).toContain("clipped-content");
    expect(kinds(rv.analyzeCandidate({ meta: meta(), fingerprint: fp([...six(), el({ key: "a", y: 300, h: 40, text: "A" }), el({ key: "b", y: 310, h: 40, text: "B" })]) }))).toContain("overlap");
    expect(kinds(rv.analyzeCandidate({ meta: meta(), fingerprint: fp([...six(), el({ size: "10px", text: "miúdo" })]) }))).toContain("small-text");
  });
  it("elemento só para leitor de tela (1×1 recortado) não conta como conteúdo cortado; elemento visível cortado conta", () => {
    expect(kinds(rv.analyzeCandidate({ meta: meta(), fingerprint: fp([...six(), el({ clipped: true, w: 1, h: 1, text: "Close" })]) }))).not.toContain("clipped-content");
    expect(kinds(rv.analyzeCandidate({ meta: meta(), fingerprint: fp([...six(), el({ clipped: true, w: 120, h: 20, text: "cortado" })]) }))).toContain("clipped-content");
  });
  it("tema errado: escuro com imagem clara e claro com imagem escura; imagem de uma cor só", () => {
    expect(kinds(rv.analyzeCandidate({ meta: meta({ theme: "dark" }), fingerprint: fp(six()), image: light() }))).toContain("theme-mismatch");
    expect(kinds(rv.analyzeCandidate({ meta: meta({ theme: "light" }), fingerprint: fp(six()), image: dark() }))).toContain("theme-mismatch");
    expect(kinds(rv.analyzeCandidate({ meta: meta({ theme: "light" }), fingerprint: fp(six()), image: mk(50, 50) }))).toContain("blank-image");
    expect(kinds(rv.analyzeCandidate({ meta: meta({ theme: "dark" }), fingerprint: fp(six()), image: dark() }))).not.toContain("theme-mismatch");
  });
  it("sem impressão de layout e altura truncada são só informativos", () => { const r = rv.analyzeCandidate({ meta: meta({ truncatedHeight: true }), fingerprint: null }); expect(kinds(r)).toEqual(["no-layout-data", "truncated-height"]); expect(r.every((i: any) => i.severity === "info")).toBe(true); });
  it("luminância e cores distintas", () => { expect(rv.meanLuminance(mk(4, 4, [255, 255, 255]))).toBeCloseTo(255, 0); expect(rv.meanLuminance(mk(4, 4, [0, 0, 0]))).toBe(0); expect(rv.distinctColors(light())).toBe(3); });
});

describe("Chrome × Edge", () => {
  it("imagens iguais → IDENTICAL; diferentes → DIFFERENT com contagem e imagem de diferença", () => {
    expect(rv.crossBrowser(light(), light()).verdict).toBe("IDENTICAL");
    const b = light(); rect(b, 100, 60, 4, 4, [255, 0, 0]); const x = rv.crossBrowser(light(), b); expect(x.verdict).toBe("DIFFERENT"); expect(x.diffPixels).toBe(16); expect(x.diffImage.width).toBe(200);
  });
});

describe("determinismo entre duas execuções", () => {
  const cell = (id: string, buf: Buffer, file = `screens/${id}.png`) => ({ id, status: "CANDIDATE_CREATED", captured: { file, sha256: sha(buf) } });
  const mkRun = (cells: { id: string; img: Img }[]) => { const files = new Map<string, Buffer>(); const out = cells.map((c) => { const b = png.encodePng(c.img); files.set(`screens/${c.id}.png`, b); return cell(c.id, b); }); return { out, files }; };
  const cmp = (a: any, b: any, tamper?: (side: string, rel: string, buf: Buffer) => Buffer) => rv.compareRuns({ aCells: a.out, bCells: b.out, read: (side: string, rel: string) => { const buf = (side === "a" ? a.files : b.files).get(rel); if (!buf) throw new Error("arquivo ausente " + rel); return tamper ? tamper(side, rel, buf) : buf; } });
  it("mesmo conteúdo → todas IDENTICAL e determinístico", () => { const r = cmp(mkRun([{ id: "x", img: light() }, { id: "y", img: dark() }]), mkRun([{ id: "x", img: light() }, { id: "y", img: dark() }])); expect(r.deterministic).toBe(true); expect(r.counts).toEqual({ IDENTICAL: 2 }); expect(r.maskCandidates).toEqual([]); });
  it("uma célula variou → DIFFERENT, não determinístico, e a região aparece como candidata a investigação (sem máscara automática)", () => {
    const moved = light(); rect(moved, 150, 90, 6, 3, [255, 0, 0]);
    const r = cmp(mkRun([{ id: "x", img: light() }, { id: "y", img: dark() }]), mkRun([{ id: "x", img: moved }, { id: "y", img: dark() }]));
    expect(r.deterministic).toBe(false); expect(r.counts).toEqual({ DIFFERENT: 1, IDENTICAL: 1 }); expect(r.maskCandidates).toHaveLength(1); expect(r.maskCandidates[0].bbox).toEqual({ x: 150, y: 90, w: 6, h: 3 }); expect(r.maskCandidates[0].note).toMatch(/investigar/);
  });
  it("PNG que não confere com o SHA-256 do relatório → HASH_MISMATCH (evidência adulterada nunca é comparada)", () => { const r = cmp(mkRun([{ id: "x", img: light() }]), mkRun([{ id: "x", img: light() }]), (side, rel, buf) => (side === "b" ? Buffer.concat([buf, Buffer.from("x")]) : buf)); expect(r.cells[0].status).toBe("HASH_MISMATCH"); expect(r.deterministic).toBe(false); });
  it("célula só em uma execução, não capturada, arquivo ausente e ilegível", () => {
    const a = mkRun([{ id: "x", img: light() }, { id: "so-a", img: light() }]), b = mkRun([{ id: "x", img: light() }]);
    expect(Object.fromEntries(cmp(a, b).cells.map((c: any) => [c.id, c.status]))).toEqual({ "so-a": "ONLY_A", x: "IDENTICAL" });
    expect(rv.compareRuns({ aCells: [{ id: "n", status: "INCONCLUSIVE" }], bCells: [{ id: "n", status: "INCONCLUSIVE" }], read: () => Buffer.alloc(0) }).cells[0].status).toBe("NOT_CAPTURED");
    const bad = mkRun([{ id: "x", img: light() }]); bad.files.delete("screens/x.png"); expect(cmp(bad, mkRun([{ id: "x", img: light() }])).cells[0].status).toBe("UNREADABLE");
  });
  it("execuções vazias não são 'determinísticas'", () => { expect(rv.compareRuns({ aCells: [], bCells: [], read: () => Buffer.alloc(0) }).deterministic).toBe(false); });
});

describe("galeria HTML de revisão", () => {
  const bdir = () => path.join(tmp, "bl"); const out = () => path.join(tmp, "gal");
  const add = (o: any, img: Img, fpr: any = fp(six())) => bl.addCandidate(bdir(), { pageId: "painel", browser: "chrome", browserVersion: "Chrome/157.0.1.1", viewport: "375x812", theme: "light", sourceSha: "a".repeat(40), captureConfigVersion: "cc-1", route: "/painel", width: img.width, height: img.height, ...o }, png.encodePng(img), fpr);
  const build = (o: any = {}) => gal.buildGallery({ baselineDir: bdir(), outDir: out(), sourceKind: "produto", ...o });
  const html = () => readFileSync(path.join(out(), "index.html"), "utf8");

  it("a origem (produto|fixture) é obrigatória; fixture é anunciada com destaque; produto não carrega esse aviso", () => {
    add({}, light()); expect(() => gal.buildGalleryModel({ baselineDir: bdir(), outDir: out(), sourceKind: "talvez" })).toThrow(/sourceKind/);
    build({ sourceKind: "fixture" }); expect(html()).toContain("DEMONSTRAÇÃO COM APP-FIXTURE"); build({ sourceKind: "produto" }); expect(html()).not.toContain("DEMONSTRAÇÃO COM APP-FIXTURE");
  });
  it("deixa claro que está AGUARDANDO APROVAÇÃO e não aprovou nada (nem altera o manifesto)", () => {
    add({}, light()); const before = sha(readFileSync(path.join(bdir(), "manifest.json"))); const m = build();
    expect(m.summary).toMatchObject({ total: 1, candidates: 1, approved: 0 }); expect(html()).toMatch(/NÃO HOMOLOGADO/); expect(html()).toMatch(/AGUARDANDO APROVAÇÃO/); expect(html()).toContain("<NOME DO REVISOR>".replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    expect(sha(readFileSync(path.join(bdir(), "manifest.json")))).toBe(before); expect(bl.loadManifest(bdir()).entries.every((e: any) => e.state === "CANDIDATE")).toBe(true);
  });
  it("lista todas as células agrupadas por página/viewport/tema/navegador e traz hash e metadados", () => {
    add({}, light()); add({ browser: "edge", browserVersion: "Edg/156.0.1.1" }, light()); add({ theme: "dark" }, dark()); add({ viewport: "1280x900" }, light(), fp(six(), { w: 1280, h: 600 }));
    const m = build(); expect(m.cells).toHaveLength(4); const h = html();
    for (const c of m.cells) { expect(h).toContain(`id="${c.id}"`); expect(h).toContain(c.sha256); expect(existsSync(path.join(out(), c.img))).toBe(true); }
    expect(h.indexOf("375x812")).toBeLessThan(h.indexOf("1280x900")); expect(h).toContain("Chrome × Edge");
  });
  it("Chrome × Edge: iguais → idêntico; diferentes → imagem de diferença gravada e contada", () => {
    add({}, light()); add({ browser: "edge" }, light()); let m = build(); expect(m.pairs[0].verdict).toBe("IDENTICAL"); expect(m.summary.crossBrowserDifferent).toBe(0);
    const e = light(); rect(e, 100, 60, 5, 5, [255, 0, 0]); add({ browser: "edge", viewport: "1280x900" }, e); add({ viewport: "1280x900" }, light()); m = build();
    const diff = m.pairs.find((p: any) => p.verdict !== "IDENTICAL"); expect(diff.diffPixels).toBe(25); expect(existsSync(path.join(out(), diff.diff))).toBe(true); expect(m.summary.crossBrowserDifferent).toBe(1);
  });
  it("problemas automáticos aparecem na célula e o tema errado é marcado", () => { add({ theme: "dark" }, light(), fp(six(), { w: 600, h: 600 })); const m = build(); expect(kinds(m.cells[0].issues)).toEqual(expect.arrayContaining(["horizontal-overflow", "theme-mismatch"])); expect(m.summary.cellsWithHigh).toBe(1); expect(html()).toContain("sev-high"); });
  it("tudo que vem de metadados é escapado (sem HTML injetado)", () => { add({ route: '/x"><img src=x onerror=alert(1)>' }, light()); build(); expect(html()).not.toContain("<img src=x onerror"); expect(html()).toContain("&lt;img src=x onerror"); expect(gal.esc("<a>&\"'")).toBe("&lt;a&gt;&amp;&quot;&#39;"); });
  it("a aprovada vale mais que uma candidata mais nova; SUPERSEDED some; banner muda quando há aprovada", () => {
    const a = add({}, light()); bl.approveBaseline(bdir(), { id: a.entry.id, imageSha256: a.entry.imageSha256, reviewer: "Revisora Teste" }); const n = light(); rect(n, 1, 1, 3, 3, [255, 0, 0]); add({ capturedAt: "2099-01-01T00:00:00Z" }, n);
    const m = build(); expect(m.cells).toHaveLength(1); expect(m.cells[0].state).toBe("APPROVED"); expect(m.cells[0].approvedBy).toBe("Revisora Teste"); expect(html()).toMatch(/1 aprovada\(s\)/);
  });
  it("PNG adulterado: a célula mostra o erro (sem imagem) e conta como problema high", () => { const a = add({}, light()); writeFileSync(path.join(bdir(), a.entry.file), Buffer.from("adulterado")); const m = build(); expect(m.cells[0].error).toMatch(/SHA-256/); expect(m.cells[0].img).toBeUndefined(); expect(html()).toContain("sem imagem"); expect(m.summary.cellsWithHigh).toBe(1); });
  it("gera index.html, gallery.json e o manifesto de hashes da galeria, sem recursos externos", () => {
    add({}, light()); build(); expect(existsSync(path.join(out(), "gallery.json"))).toBe(true); const sums = readFileSync(path.join(out(), "GALLERY-SHA256.txt"), "utf8"); expect(sums).toMatch(/index\.html/);
    expect(html()).not.toMatch(/https?:\/\/|<link |<script src/);
  });
});
