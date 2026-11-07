/**
 * Testes UNITÁRIOS da M04 (QA visual): relógio de teste congelado (servidor, banco, navegador), configuração de captura com relógio e captura SEGMENTADA de páginas longas
 * (costura, continuidade verificada, região omitida). Sem navegador e sem banco. QA_VISUAL_ROOT (opcional) aponta para uma cópia sabotada (mutantes).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

const ROOT = process.env.QA_VISUAL_ROOT ?? path.resolve(__dirname, "../scripts/qa-visual");
const load = (rel: string) => import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href);
const clk = await load("lib/clock.mjs");
const cap = await load("lib/capture.mjs");
const png = await load("lib/png.mjs");
const T0 = Date.parse(clk.FROZEN_CLOCK.iso);

describe("relógio de teste congelado", () => {
  it("o instante é fixo, no passado do calendário real e nunca 'hoje'; fuso e idioma definidos", () => {
    expect(clk.FROZEN_CLOCK.iso).toBe("2026-03-16T15:00:00.000Z");
    expect(clk.FROZEN_CLOCK.timezone).toBe("America/Sao_Paulo");
    expect(clk.FROZEN_CLOCK.locale).toBe("pt-BR");
  });

  it("banco: now() e as variantes de transação/instrução/relógio ficam no instante fixo e o search_path do banco coloca qa_clock ANTES de pg_catalog (senão o now() real venceria)", () => {
    const sql: string[] = clk.clockSql("levora_x_qa");
    const all = sql.join("\n");
    for (const fn of ["now", "transaction_timestamp", "statement_timestamp", "clock_timestamp"]) expect(all).toContain(`qa_clock.${fn}()`);
    expect(all).toContain("'2026-03-16T15:00:00.000Z'::timestamptz");
    const sp = sql.find((s) => s.includes("search_path"))!;
    expect(sp).toContain('ALTER DATABASE "levora_x_qa" SET search_path = qa_clock, pg_catalog, public');
    expect(sp.indexOf("qa_clock")).toBeLessThan(sp.indexOf("pg_catalog"));
    expect(sql.some((s) => s.includes("SET timezone = 'America/Sao_Paulo'"))).toBe(true);
    expect(clk.clockSql('a"b').join(' ')).toContain('"a""b"'); // nome do banco sempre escapado
    expect(all).not.toContain('nextval'); // fase de execução: constante, sem sequência
  });

  it("M05 semente: cada now() avança 1 s a partir de (instante − janela), VOLATILE, sequência reiniciada; ao fim volta a constante (instantes distintos e ordem estável)", () => {
    const seed: string[] = clk.clockSql("levora_x_qa", clk.FROZEN_CLOCK, { seedTicks: 3600 });
    const all = seed.join("\n");
    expect(all).toContain("SELECT setval('qa_clock.tick', 1, false);");
    expect(all).toContain("interval '3600 seconds'");
    expect(all).toContain("nextval('qa_clock.tick') * interval '1 second'");
    for (const fn of ["now", "transaction_timestamp", "statement_timestamp", "clock_timestamp"]) expect(all).toMatch(new RegExp(`qa_clock\\.${fn}\\(\\) RETURNS timestamptz LANGUAGE sql VOLATILE`));
    expect(all).not.toMatch(/LANGUAGE sql STABLE/);
    const run: string[] = clk.clockSql("levora_x_qa");
    expect(run.join("\n")).toMatch(/LANGUAGE sql STABLE/);
    expect(run.join("\n")).not.toContain("setval");
    expect(clk.FROZEN_CLOCK.seedWindowSeconds).toBeGreaterThan(0);
    expect(clk.FROZEN_CLOCK.version).toBe("clock-v2");
  });

  it("servidor: NODE_OPTIONS ganha --import do pré-carregamento, preserva o valor anterior, fixa TZ e QA_CLOCK_ISO", () => {
    const e = clk.clockEnv(clk.FROZEN_CLOCK, { NODE_OPTIONS: "--max-old-space-size=256" });
    expect(e.QA_CLOCK_ISO).toBe(clk.FROZEN_CLOCK.iso);
    expect(e.TZ).toBe("America/Sao_Paulo");
    expect(e.NODE_OPTIONS.startsWith("--max-old-space-size=256 --import file:///")).toBe(true);
    expect(e.NODE_OPTIONS).toContain("clock-preload.mjs");
  });

  it("servidor: um processo Node com o pré-carregamento vê Date.now() e new Date() congelados; new Date(args) e Date.UTC seguem normais; timers continuam andando", () => {
    const env = { ...process.env, ...clk.clockEnv(clk.FROZEN_CLOCK, {}) };
    const code = `const a=Date.now();const b=new Date().toISOString();const c=new Date(2020,0,2,3,4,5).getFullYear();const d=Date.UTC(2020,0,1);const t0=performance.now();setTimeout(()=>{console.log(JSON.stringify({a,b,c,d,ok:performance.now()-t0>=15,inst:new Date() instanceof Date,name:Date.name}))},20)`;
    const r = spawnSync(process.execPath, ["-e", code], { env, encoding: "utf8" });
    expect(r.status).toBe(0);
    const o = JSON.parse(r.stdout);
    expect(o.a).toBe(T0); expect(o.b).toBe(clk.FROZEN_CLOCK.iso); expect(o.c).toBe(2020); expect(o.d).toBe(Date.UTC(2020, 0, 1)); expect(o.ok).toBe(true); expect(o.inst).toBe(true); expect(o.name).toBe("Date");
  });

  it("M05 semente: com QA_CLOCK_SEED_TICKS o relógio parte de (instante − janela), NÃO anda sozinho entre leituras e só avança por __qaClockAdvance; passar da janela é erro", () => {
    const env = { ...process.env, ...clk.clockEnv(clk.FROZEN_CLOCK, {}), QA_CLOCK_SEED_TICKS: "3600" };
    const code = `const a=Date.now();let x=0;for(let i=0;i<500;i++){x+=new Date().getTime();Date.now()}const b=Date.now();globalThis.__qaClockAdvance(1000);const c=Date.now();let over=false;try{globalThis.__qaClockAdvance(3600*1000)}catch(e){over=/janela/.test(e.message)}console.log(JSON.stringify({a,b,c,over}))`;
    const r = spawnSync(process.execPath, ["-e", code], { env, encoding: "utf8" });
    expect(r.status).toBe(0);
    const o = JSON.parse(r.stdout);
    expect(o.a).toBe(T0 - 3600 * 1000); expect(o.b).toBe(o.a); expect(o.c).toBe(o.a + 1000); expect(o.over).toBe(true);
    const run = spawnSync(process.execPath, ["-e", "console.log(Date.now(), typeof globalThis.__qaClockAdvance)"], { env: { ...process.env, ...clk.clockEnv(clk.FROZEN_CLOCK, {}) }, encoding: "utf8" });
    expect(run.stdout.trim()).toBe(`${T0} undefined`); // a API em execução não recebe a variável: relógio constante e sem avanço
  });

  it("sem QA_CLOCK_ISO o pré-carregamento não altera nada (produção/ambiente real intactos)", () => {
    const env = { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(clk.clockPreloadFile).href}` } as Record<string, string | undefined>; delete env.QA_CLOCK_ISO;
    const r = spawnSync(process.execPath, ["-e", "console.log(Math.abs(Date.now()-new Date().getTime())<5, Date.now()>Date.parse('2026-04-01'))"], { env, encoding: "utf8" });
    expect(r.stdout.trim()).toBe("true true");
  });

  it("navegador: o script injetado congela Date/Date.now sem quebrar Date(args), parse, UTC e instanceof", () => {
    const ctx: any = { console }; vm.createContext(ctx); vm.runInContext(clk.browserClockScript(clk.FROZEN_CLOCK), ctx);
    const out = vm.runInContext("JSON.stringify({a:Date.now(),b:new Date().toISOString(),c:new Date(5).getTime(),d:Date.parse('2020-01-01T00:00:00Z'),e:Date.UTC(2020,0,1),f:new Date() instanceof Date,g:Date.name})", ctx);
    const o = JSON.parse(out);
    expect(o.a).toBe(T0); expect(o.b).toBe(clk.FROZEN_CLOCK.iso); expect(o.c).toBe(5); expect(o.d).toBe(Date.parse("2020-01-01T00:00:00Z")); expect(o.e).toBe(Date.UTC(2020, 0, 1)); expect(o.f).toBe(true); expect(o.g).toBe("Date");
    vm.runInContext(clk.browserClockScript(clk.FROZEN_CLOCK), ctx); // injetar duas vezes não empilha classes
    expect(vm.runInContext("Date.now()", ctx)).toBe(T0);
  });

  it("configuração de captura: com relógio a normalização de texto é DESLIGADA, o instante entra na identidade (versão diferente) e o relógio é parte do registro", () => {
    const base = cap.configFor(null), frozen = cap.configFor(clk.FROZEN_CLOCK);
    expect(base.dynamicText).toBeTruthy(); expect(base.clock).toBeUndefined();
    expect(frozen.dynamicText).toBeNull(); expect(frozen.clock.iso).toBe(clk.FROZEN_CLOCK.iso);
    expect(cap.captureConfigVersion(frozen)).not.toBe(cap.captureConfigVersion(base));
    expect(cap.captureConfigVersion(cap.configFor({ ...clk.FROZEN_CLOCK, iso: "2026-03-17T15:00:00.000Z" }))).not.toBe(cap.captureConfigVersion(frozen)); // outro instante = outra configuração
    expect(Object.isFrozen(frozen)).toBe(true);
  });
});

// ---- captura segmentada (página longa) ----
const W = 6;
const rowPx = (y: number) => [y & 255, (y >> 8) & 255, (y * 7) & 255, 255];
function synthetic(h: number) { const data = Buffer.alloc(W * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; const p = rowPx(y); data[o] = p[0]; data[o + 1] = (p[1] + x) & 255; data[o + 2] = p[2]; data[o + 3] = 255; } return { width: W, height: h, data }; }
function fakeCdp(H: number, opts: { short?: boolean; mutate?: (row: number, top: number) => boolean } = {}) {
  const img = synthetic(H); const calls: any[] = [];
  return { calls, async send(method: string, params: any) {
    if (method === "Page.getLayoutMetrics") return { cssContentSize: { width: W, height: H } };
    if (method === "Page.captureScreenshot") {
      const { y, height } = params.clip; calls.push({ y, height }); let hh = height; if (opts.short && y > 6000) hh = height - 3;
      const data = Buffer.from(img.data.subarray(y * W * 4, (y + hh) * W * 4)); if (opts.mutate) for (let r = 0; r < hh; r++) if (opts.mutate(y + r, y)) data[r * W * 4 + 1] ^= 0xff;
      return { data: png.encodePng({ width: W, height: hh, data }).toString("base64") };
    }
    throw new Error("método inesperado " + method);
  }, img };
}
const CFG = { fullPage: true, maxHeight: 40000, segmentHeight: 6000, segmentOverlap: 8 };

describe("captura segmentada de páginas longas", () => {
  it("página curta: uma só captura, sem segmentos, completa", async () => {
    const c = fakeCdp(900); const r = await cap.shoot(c, CFG);
    expect(r.segments).toBeNull(); expect(r.truncated).toBe(false); expect(r.docHeight).toBe(900); expect(c.calls).toHaveLength(1);
    expect(png.decodePng(r.png).height).toBe(900);
  });

  it("página de 15.000 px: 3 segmentos, continuidade verificada nas 2 emendas e imagem costurada IDÊNTICA ao original (sem linha repetida nem faltando)", async () => {
    const c = fakeCdp(15000); const r = await cap.shoot(c, CFG);
    expect(r.segments.count).toBe(3); expect(r.segments.continuityChecked).toBe(2); expect(r.truncated).toBe(false); expect(r.segments.list.map((s: any) => s.y)).toEqual([0, 5992, 11992]);
    const out = png.decodePng(r.png); expect(out.height).toBe(15000); expect(out.width).toBe(W);
    expect(Buffer.compare(Buffer.from(out.data), c.img.data)).toBe(0);
    expect(r.segments.list.every((s: any) => /^[0-9a-f]{64}$/.test(s.sha256))).toBe(true);
  });

  it("emenda com conteúdo diferente nas linhas sobrepostas (a página mudou durante a captura) → erro de continuidade, nunca imagem 'completa'", async () => {
    const c = fakeCdp(15000, { mutate: (row, top) => top > 0 && row === 5995 }); // uma linha da faixa de sobreposição
    await expect(cap.shoot(c, CFG)).rejects.toThrow(/continuidade quebrada/);
  });

  it("segmento devolvido mais curto que o pedido (região não capturada) → erro explícito", async () => {
    const c = fakeCdp(15000, { short: true });
    await expect(cap.shoot(c, CFG)).rejects.toThrow(/não capturada/);
  });

  it("documento maior que o limite duro: a imagem é marcada TRUNCADA (nunca declarada completa)", async () => {
    const c = fakeCdp(14000); const r = await cap.shoot(c, { ...CFG, maxHeight: 9000 });
    expect(r.truncated).toBe(true); expect(r.docHeight).toBe(14000); expect(png.decodePng(r.png).height).toBe(9000);
  });
});
