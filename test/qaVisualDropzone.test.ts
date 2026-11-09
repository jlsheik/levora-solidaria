/**
 * M08 (R5): testes UNITÁRIOS da cobertura COMPLEMENTAR da dropzone: a matriz `visual-matrix-dropzone.mjs` (estados reais do FileDropzone) e os passos novos do
 * executor (setFile com bytes/tamanho, waitFor, scrollEnd, network, block). Sem navegador e sem banco; fixtures sintéticas. QA_VISUAL_ROOT (opcional) aponta para uma cópia sabotada.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ALLOWED_CONTENT_TYPES, FILE_MAX_SIZE_BYTES } from "../src/endpoints/files-upload_POST.schema";

const ROOT = process.env.QA_VISUAL_ROOT ?? path.resolve(__dirname, "../scripts/qa-visual");
const load = (rel: string) => import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href);
const dz = await load("visual-matrix-dropzone.mjs");
const official = await load("visual-matrix.mjs");
const runner = await load("lib/runner.mjs");
const cap = await load("lib/capture.mjs");
const fn = await load("visual-matrix-dropzone-func.mjs");
const pr = await load("lib/probes.mjs");

const KNOWN_STEPS = ["click", "setFile", "select", "type", "waitFor", "scrollEnd", "network", "block", "dragFile", "holdRequest", "fulfillHeld", "releaseHold"];


describe("matriz complementar da dropzone (R5)", () => {
  it("é separada da matriz oficial: ids únicos, nenhum id repetido e a oficial continua com 14 páginas", () => {
    const ids = dz.VISUAL_PAGES.map((p: any) => p.id); expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(official.VISUAL_PAGES.some((p: any) => p.id === id)).toBe(false);
    expect(official.VISUAL_PAGES.length).toBe(14);
  });
  it("cobre os estados REAIS do FileDropzone: fim ocioso, arquivo aceito, erro de tipo, erro de tamanho, falha do servidor, falha de rede, arrastando e enviando (M09)", () => {
    expect(dz.VISUAL_PAGES.map((p: any) => p.id)).toEqual(["dropzone-fim-ocioso", "dropzone-arquivo-aceito", "dropzone-erro-tipo", "dropzone-erro-tamanho", "dropzone-falha-servidor", "dropzone-falha-rede", "dropzone-falha-servidor-5xx", "dropzone-arrastando", "dropzone-enviando"]);
  });
  it("M09: 'enviando' e 'arrastando' agora têm página própria; 'arrastando' é só desktop (arrastar-e-soltar não existe em toque) e não move o mouse", () => {
    const env = dz.VISUAL_PAGES.find((p: any) => p.id === "dropzone-enviando"), arr = dz.VISUAL_PAGES.find((p: any) => p.id === "dropzone-arrastando");
    expect(env.capture).toEqual({ fullPage: false, expectPending: { urlIncludes: "files-upload", method: "POST" } });
    expect(env.steps.findIndex((x: any) => x.holdRequest)).toBeLessThan(env.steps.findIndex((x: any) => x.setFile)); // a interceptação liga ANTES de enviar
    expect(env.steps.some((x: any) => x.waitFor && /Enviando/.test(x.waitFor.text))).toBe(true); // o estado é COMPROVADO na interface, não presumido
    expect(arr.capture).toEqual({ fullPage: false, keepPointer: true });
    expect(arr.viewports.map((v: any) => v.w)).toEqual([1280]);
    expect(arr.steps.some((x: any) => x.dragFile && x.dragFile.phase === "enter")).toBe(true);
    for (const pg of dz.VISUAL_PAGES.filter((x: any) => !["dropzone-enviando", "dropzone-arrastando"].includes(x.id))) { expect(pg.capture.expectPending).toBeUndefined(); expect(pg.capture.keepPointer).toBeUndefined(); } // o resto segue no portão estrito
  });
  it("todo passo usa o vocabulário conhecido; todo setFile tem exatamente UMA fonte de bytes; toda página termina rolando ao FIM do diálogo e é captura do viewport", () => {
    for (const p of dz.VISUAL_PAGES) {
      expect(p.capture.fullPage).toBe(false); expect(p.target).toEqual({ css: '[role="dialog"]' }); expect(p.user).toBe("owner"); expect(p.path.startsWith("/")).toBe(true);
      for (const s of p.steps) { expect(Object.keys(s).length).toBe(1); expect(KNOWN_STEPS).toContain(Object.keys(s)[0]); }
      for (const s of p.steps.filter((x: any) => x.setFile)) { const f = s.setFile; expect([f.content, f.contentBase64, f.padBytes].filter((v) => v !== undefined).length).toBe(1); }
      if (p.id !== "dropzone-arrastando") expect(Object.keys(p.steps[p.steps.length - 1])[0]).toBe("scrollEnd"); // arrastando termina no waitFor do estado (rolar não pode soltar o gesto)
    }
  });
  it("fixtures são sintéticas e conferem com as regras do produto: PNG válido minúsculo; .txt fora da lista aceita; arquivo acima do limite de 8MB; 'falso.png' com conteúdo de texto", () => {
    const files = dz.VISUAL_PAGES.flatMap((p: any) => p.steps.filter((s: any) => s.setFile).map((s: any) => s.setFile));
    const png = files.find((f: any) => f.contentBase64); const bytes = Buffer.from(png.contentBase64, "base64"); expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); expect(bytes.length).toBeLessThan(200);
    expect(png.fileName.endsWith(".png")).toBe(true);
    const txt = files.find((f: any) => f.fileName.endsWith(".txt")); expect((ALLOWED_CONTENT_TYPES as readonly string[]).includes("text/plain")).toBe(false); expect(txt.content).toBeTruthy();
    const big = files.find((f: any) => f.padBytes); expect(big.padBytes).toBeGreaterThan(FILE_MAX_SIZE_BYTES); expect(big.padBytes).toBeLessThan(FILE_MAX_SIZE_BYTES + 64 * 1024);
    const fake = files.find((f: any) => f.fileName.startsWith("falso")); expect(fake.fileName.endsWith(".png")).toBe(true); expect(fake.content).toBeTruthy();
    for (const f of files) expect(f.fileName).toMatch(/sintetico|invalido/);
  });
  it("falha de rede bloqueia só a URL de upload; o passo de bloqueio vem antes do envio do arquivo", () => {
    const p = dz.VISUAL_PAGES.find((x: any) => x.id === "dropzone-falha-rede"); const keys = p.steps.map((s: any) => Object.keys(s)[0]);
    expect(keys.indexOf("block")).toBeGreaterThan(-1); expect(keys.indexOf("block")).toBeLessThan(keys.indexOf("setFile")); expect(p.steps.find((s: any) => s.block).block).toEqual(["*files-upload*"]);
  });
});

describe("matrizes da dropzone: R9 e matriz funcional (M09)", () => {
  it("TODA página da dropzone (visual e funcional) proíbe o inglês residual dos três textos corrigidos", () => {
    for (const p of [...dz.VISUAL_PAGES, ...fn.VISUAL_PAGES]) for (const t of ["Invalid file type", "File size exceeds", "Failed to fetch"]) expect(p.assert.excludes).toContain(t);
  });
  it("as páginas de erro afirmam o texto EXATO em português (tipo, tamanho, rede, servidor 5xx com o corpo técnico proibido)", () => {
    const a = (id: string) => dz.VISUAL_PAGES.find((p: any) => p.id === id).assert;
    expect(a("dropzone-erro-tipo").includes).toEqual(["Tipo de arquivo não permitido. Selecione um formato aceito."]);
    expect(a("dropzone-erro-tamanho").includes).toEqual(["O arquivo excede o limite de 8 MB."]);
    expect(a("dropzone-falha-rede").includes).toEqual(["Não foi possível enviar o arquivo. Verifique sua conexão e tente novamente."]);
    expect(a("dropzone-falha-servidor-5xx").includes).toEqual(["Não foi possível concluir o envio. Tente novamente mais tarde."]);
    expect(a("dropzone-falha-servidor-5xx").excludes).toContain("ECONNREFUSED");
  });
  it("o limite afirmado (8 MB) confere com o contrato do produto", () => { expect(FILE_MAX_SIZE_BYTES / 1024 / 1024).toBe(8); expect(ALLOWED_CONTENT_TYPES).toContain("image/png"); });
  it("a matriz funcional é marcada como funcional (imagens não são candidatas), usa só passos conhecidos e cobre recuperação, nova seleção, sair do arrasto, arrasto inválido e soltar (inválido/válido)", () => {
    expect(fn.VISUAL_PAGES.map((p: any) => p.id)).toEqual(["func-recuperacao-apos-erro", "func-nova-selecao-apos-falha", "func-arrasto-sair", "func-arrasto-invalido-mesmo-destaque", "func-soltar-invalido", "func-soltar-valido", "func-r10-toast-sucesso", "func-r10-toast-erro-curto", "func-r10-toast-erro-longo", "func-r10-dois-toasts"]);
    for (const p of fn.VISUAL_PAGES) { expect(p.funcional).toBe(true); for (const s of p.steps) expect(KNOWN_STEPS).toContain(Object.keys(s)[0]); }
    expect(fn.VISUAL_PAGES.find((p: any) => p.id === "func-nova-selecao-apos-falha").steps.some((s: any) => s.releaseHold)).toBe(true);
  });
});

describe("sondas e condições da página — matrizes da dropzone (R10/R12)", () => {
  it("a matriz da dropzone liga a sonda em TODAS as páginas e a funcional R10 usa a de interação em 4 viewports", () => {
    for (const p of dz.VISUAL_PAGES) expect(p.probe).toBe("dropzone");
    const r10 = fn.VISUAL_PAGES.filter((p: any) => /^func-r10/.test(p.id)); expect(r10).toHaveLength(4);
    for (const p of r10) { expect(p.probe).toBe("dropzone-interact"); expect(p.viewports.map((v: any) => v.w)).toEqual([375, 390, 768, 1280]); expect(p.assert.evalTrue.length).toBeGreaterThan(0); }
  });
  it("TODA página da dropzone afirma o diálogo com x e largura inteiros (R12), inclusive as que já tinham outras condições", () => {
    for (const p of dz.VISUAL_PAGES) expect((p.assert.evalTrue ?? []).some((e: any) => /^R12:/.test(e.name))).toBe(true);
    const env = dz.VISUAL_PAGES.find((p: any) => p.id === "dropzone-enviando"); expect(env.assert.evalTrue.length).toBeGreaterThanOrEqual(3); // R11 (opacidade), região viva e R12
  });
  it("a condição R10 das páginas funcionais é REAL (M11): reprova toast sobre QUALQUER parte do diálogo ou diálogo fora da janela, aprova toast fora do diálogo e reprova sem toast", () => {
    const js = fn.VISUAL_PAGES.find((p: any) => p.id === "func-r10-toast-sucesso").assert.evalTrue[0].js as string;
    const el = (l: number, t: number, w: number, h: number) => ({ getBoundingClientRect: () => ({ left: l, top: t, right: l + w, bottom: t + h }) });
    const doc = (dialog: any, toasts: any[]) => ({ querySelector: (q: string) => (q.includes("dialog") ? dialog : null), querySelectorAll: (q: string) => (q.includes("sonner") ? toasts : []) });
    const run = (d: any, w = 375, h = 812) => new Function("document", "innerWidth", "innerHeight", "return " + js)(d, w, h);
    const dlg = el(16, 16, 343, 570); // diálogo medido depois da correção (375×812, erro longo)
    expect(run(doc(dlg, [el(16, 594, 343, 202)]))).toBe(true); // toast abaixo do diálogo
    expect(run(doc(el(18, 37, 339, 738), [el(16, 505, 343, 202)]))).toBe(false); // M10: toast sobre a dica e o campo de link (cobertura medida de 100%)
    expect(run(doc(el(18, 37, 339, 738), [el(16, 649, 343, 58)]))).toBe(false); // M10: até o toast de sucesso sobrepunha o corpo do diálogo
    expect(run(doc(el(16, 16, 343, 570), [el(16, 570, 343, 202)]))).toBe(false); // 16 px de sobreposição vertical já reprova
    expect(run(doc(el(16, -4, 343, 570), [el(16, 594, 343, 202)]))).toBe(false); // diálogo saindo da janela
    expect(run(doc(dlg, [el(16, 594, 343, 202), el(24, 580, 325, 190)]))).toBe(false); // um dos dois toasts sobrepõe
    expect(run(doc(dlg, []))).toBe(false); // sem toast a condição não prova nada
    expect(run(doc(null, [el(16, 594, 343, 202)]))).toBe(false); // sem diálogo
  });
});

describe("regiões de ruído nas matrizes da dropzone (M11 / R14)", async () => {
  const nr = await load("visual-noise-regions.mjs");
  it("só as páginas da dropzone com ruído medido têm tolerância (por região, com justificativa); as matrizes funcionais não têm", () => {
    for (const p of dz.VISUAL_PAGES) { const has = (nr.NOISE_REGIONS[p.id] ?? []).length > 0; expect(!!p.tolerance?.regions, p.id).toBe(has); if (has) expect(p.why, p.id).toBeTruthy(); expect(p.masks ?? [], p.id).toEqual([]); }
    for (const p of fn.VISUAL_PAGES) expect(p.tolerance, p.id).toBeUndefined();
  });
});
