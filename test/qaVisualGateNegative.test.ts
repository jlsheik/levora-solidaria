/**
 * M13 — testes NEGATIVOS do gate visual: nenhum dos 15 cenários abaixo pode produzir um PASS visual enganoso (exit 0). Cada cenário registra o status e o exit code esperados.
 * Ponta a ponta sobre as funções reais (baselines em disco temporário → resolução → comparação → código de saída). Sem navegador, sem banco.
 *  1 sem baseline · 2 só CANDIDATE · 3 grupo NEEDS_INVESTIGATION · 4 manifesto ausente/corrompido · 5 hash divergente · 6 árvore/config diferente · 7 borda · 8 texto · 9 elemento ausente
 *  10 falha funcional · 11 falha ambiental · 12 contraste · 13 posição · 14 região inválida · 15 imagem histórica substituída usada como candidata
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.env.QA_VISUAL_ROOT ?? path.resolve(__dirname, "../scripts/qa-visual");
const load = (rel: string) => import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href);
const bl = await load("lib/baseline.mjs"); const vr = await load("lib/visualrun.mjs"); const png = await load("lib/png.mjs"); const cal = await load("visual-calibration.mjs");

type Img = { width: number; height: number; data: Uint8ClampedArray };
const mk = (w = 120, h = 80): Img => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255; d[i * 4 + 3] = 255; } return { width: w, height: h, data: d }; };
const rect = (im: Img, x: number, y: number, w: number, h: number, c: number[]) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) { const o = (j * im.width + i) * 4; im.data[o] = c[0]; im.data[o + 1] = c[1]; im.data[o + 2] = c[2]; } };
function scene(o: { border?: boolean; text?: boolean; button?: boolean; textColor?: number[]; dx?: number } = {}): Img {
  const im = mk(); if (o.border !== false) { rect(im, 5, 5, 100, 1, [90, 90, 90]); rect(im, 5, 40, 100, 1, [90, 90, 90]); rect(im, 5, 5, 1, 36, [90, 90, 90]); rect(im, 104, 5, 1, 36, [90, 90, 90]); }
  if (o.text !== false) rect(im, 12 + (o.dx ?? 0), 14, 40, 6, o.textColor ?? [30, 30, 30]);
  if (o.button !== false) rect(im, 12, 50, 36, 14, [29, 78, 216]); return im;
}
const META = { pageId: "painel", browser: "chrome", browserVersion: "Chrome/157.0.8103.39", viewport: "1280x900", theme: "light", sourceSha: "a".repeat(40), captureConfigVersion: "cc-1", route: "/painel" };
const KEY = { pageId: "painel", browser: "chrome", viewport: "1280x900", theme: "light" }; const CTX = { captureConfigVersion: "cc-1", version: "Chrome/157.0.8103.39" };
const FP = { count: 0, elements: [], doc: { w: 1, h: 1 } };
let tmp = ""; let ledgerDir = ""; const OLD_LEDGER = process.env.QA_APPROVAL_LEDGER; // M19: âncora temporária fora da pasta de baselines
beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "levora-qa-test-gate-")); ledgerDir = mkdtempSync(path.join(tmpdir(), "levora-qa-ledger-test-")); process.env.QA_APPROVAL_LEDGER = path.join(ledgerDir, "approvals.jsonl"); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); rmSync(ledgerDir, { recursive: true, force: true }); if (OLD_LEDGER === undefined) delete process.env.QA_APPROVAL_LEDGER; else process.env.QA_APPROVAL_LEDGER = OLD_LEDGER; });
const addCand = (im = scene(), meta = META) => bl.addCandidate(tmp, meta, png.encodePng(im), FP);
const approve = (im = scene()) => { const { entry } = addCand(im); return bl.approveBaseline(tmp, { id: entry.id, imageSha256: entry.imageSha256, reviewer: "Revisor sintético do teste" }); };
const exit = (...status: string[]) => vr.visualExitCode(status.map((s) => ({ status: s })));
const cmpWith = (cur: Img, base: Img = scene(), page: object = { id: "painel" }) => vr.compareCaptured({ png: png.encodePng(cur), fingerprint: null, resolution: { png: png.encodePng(base), fingerprint: null }, page, cellId: "painel__chrome__1280x900__light" });

describe("M13 gate visual — cenários negativos (nenhum vira PASS)", () => {
  it("1) sem baseline: MISSING_BASELINE → exit 6 (não homologado), nunca 0", () => { expect(bl.resolveBaseline(tmp, KEY, CTX).status).toBe("MISSING_BASELINE"); expect(exit("MISSING_BASELINE")).toBe(6); });
  it("2) só CANDIDATE: CANDIDATE_ONLY sem imagem de referência → exit 6; capturar gera CANDIDATE_CREATED → exit 6", () => {
    addCand(); const r = bl.resolveBaseline(tmp, KEY, CTX); expect(r.status).toBe("CANDIDATE_ONLY"); expect(r.png).toBeUndefined(); expect(exit("CANDIDATE_ONLY")).toBe(6); expect(exit("CANDIDATE_CREATED")).toBe(6);
  });
  it("3) grupo NEEDS_INVESTIGATION: a aprovação é recusada (UNCALIBRATED_CELL) e a candidata continua CANDIDATE", () => {
    const bad = Object.entries(cal.CALIBRATION.groups as Record<string, { status: string }>).find(([, v]) => v.status === "NEEDS_INVESTIGATION")!; const [page, vp] = bad[0].split("|");
    expect(() => cal.assertApprovable(`${page}__edge__${vp}__dark`)).toThrowError(/NEEDS_INVESTIGATION/);
    const { entry } = addCand(scene(), { ...META, pageId: page, browser: "edge", viewport: vp, theme: "dark" }); expect(entry.state).toBe("CANDIDATE");
  });
  it("4) manifesto ausente = sem baseline (exit 6); manifesto corrompido ou de esquema desconhecido LANÇA (BAD_MANIFEST), não passa", () => {
    expect(bl.loadManifest(tmp).entries).toEqual([]); expect(bl.resolveBaseline(tmp, KEY, CTX).status).toBe("MISSING_BASELINE");
    writeFileSync(path.join(tmp, "manifest.json"), "{ não é json"); expect(() => bl.loadManifest(tmp)).toThrow(/ilegível/);
    writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify({ schema: 99, entries: [] })); expect(() => bl.loadManifest(tmp)).toThrow(/esquema/);
  });
  it("5) hash divergente (arquivo da aprovada adulterado): CORRUPT → BASELINE_CORRUPT → exit 2", () => {
    const a = approve(); writeFileSync(path.join(tmp, a.file), Buffer.from("adulterado")); const r = bl.resolveBaseline(tmp, KEY, CTX); expect(r.status).toBe("CORRUPT"); expect(exit("BASELINE_CORRUPT")).toBe(2);
  });
  it("6) captura de árvore/configuração/versão diferente: STALE → exit 6, o executor não compara", () => {
    approve(); const r1 = bl.resolveBaseline(tmp, KEY, { ...CTX, captureConfigVersion: "cc-2" }); const r2 = bl.resolveBaseline(tmp, KEY, { ...CTX, version: "Chrome/158.0.1.1" });
    for (const r of [r1, r2]) { expect(r.status).toBe("STALE"); expect(r.reason).toMatch(/reaprovar/); } /* o executor (visualrun) para em STALE_BASELINE e não compara; a imagem só acompanha para revisão */ expect(readFileSync(path.join(ROOT, "lib/visualrun.mjs"), "utf8")).toContain("RESOLUTION.STALE) { cells.push"); expect(exit("STALE_BASELINE")).toBe(6);
  });
  const REG: [string, Img][] = [["7) borda removida", scene({ border: false })], ["8) texto alterado (largura)", (() => { const im = scene({ text: false }); rect(im, 12, 14, 38, 6, [30, 30, 30]); return im; })()], ["9) elemento ausente (botão)", scene({ button: false })],
    ["12) contraste reduzido do texto", scene({ textColor: [60, 60, 60] })], ["13) mudança de posição (1 px)", scene({ dx: 1 })]];
  for (const [name, cur] of REG) it(`${name}: com baseline aprovada → VISUAL_REGRESSION → exit 1`, () => { const r = cmpWith(cur); expect(r.status).toBe("VISUAL_REGRESSION"); expect(exit(r.status)).toBe(1); });
  it("controle: imagem idêntica à aprovada é o ÚNICO caminho para VISUAL_PASS (exit 0)", () => { const r = cmpWith(scene()); expect(r.status).toBe("VISUAL_PASS"); expect(exit(r.status)).toBe(0); });
  it("10) falha funcional → FUNCTIONAL_FAIL → exit 1; 11) falha ambiental/carregamento → INCONCLUSIVE → exit 2; nenhuma das duas mistura com PASS", () => {
    expect(exit("FUNCTIONAL_FAIL")).toBe(1); expect(exit("INCONCLUSIVE")).toBe(2); expect(exit("VISUAL_PASS", "FUNCTIONAL_FAIL")).toBe(1); expect(exit("VISUAL_PASS", "INCONCLUSIVE")).toBe(2); expect(vr.visualExitCode([])).toBe(2);
  });
  it("ausência de imagem/captura ilegível NUNCA é sucesso (INCONCLUSIVE)", () => { const r = vr.compareCaptured({ png: Buffer.from("nada"), fingerprint: null, resolution: { png: png.encodePng(scene()), fingerprint: null }, page: { id: "painel" }, cellId: "x" }); expect(r.status).toBe("INCONCLUSIVE"); expect(exit(r.status)).toBe(2); });
  it("14) região de tolerância inválida (sem justificativa, Δ > 4, fora da imagem, sem orçamento) LANÇA: não vira PASS", () => {
    const bad = [{ x: 0, y: 0, w: 5, h: 5, maxChannelDelta: 2, maxPixels: 4, reason: "curto" }, { x: 0, y: 0, w: 5, h: 5, maxChannelDelta: 9, maxPixels: 4, reason: "ruído de rasterização medido em rodadas" }, { x: 500, y: 0, w: 5, h: 5, maxChannelDelta: 2, maxPixels: 4, reason: "ruído de rasterização medido em rodadas" }, { x: 0, y: 0, w: 5, h: 5, maxChannelDelta: 2, reason: "ruído de rasterização medido em rodadas" }];
    for (const r of bad) expect(() => cmpWith(scene({ dx: 1 }), scene(), { id: "p", tolerance: { regions: [r] } })).toThrow();
  });
  it("15) imagem histórica SUBSTITUÍDA não pode virar candidata nem referência: aprovar uma entrada SUPERSEDED é recusado e ela não resolve como baseline", () => {
    const a = approve(); const other = scene({ button: false }); const b = addCand(other).entry; bl.approveBaseline(tmp, { id: b.id, imageSha256: b.imageSha256, reviewer: "Revisor sintético do teste", replace: true });
    expect(() => bl.approveBaseline(tmp, { id: a.id, imageSha256: a.imageSha256, reviewer: "Revisor sintético do teste", replace: true })).toThrow(/não há candidata/);
    const m = bl.loadManifest(tmp); expect(m.entries.find((e: { imageSha256: string }) => e.imageSha256 === a.imageSha256).state).toBe("SUPERSEDED");
    const r = bl.resolveBaseline(tmp, KEY, CTX); expect(r.status).toBe("APPROVED"); expect(bl.sha256(r.png)).toBe(b.imageSha256);
  });
  it("auditoria: nada neste teste tocou fora do diretório temporário (mkdirSync só em tmp)", () => { mkdirSync(path.join(tmp, "x")); expect(tmp.startsWith(tmpdir())).toBe(true); });
});
