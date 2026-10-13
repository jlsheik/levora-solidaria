/**
 * Testes UNITÁRIOS da lógica da verificação visual (scripts/qa-visual): aritmética de contraste, limites WCAG por tipo de elemento, guarda do
 * banco descartável, códigos de saída, descoberta de navegador e consistência dos cenários. NÃO abrem navegador nem banco: a medição real de
 * componentes renderizados é feita por `npm run qa:visual` (Edge/Chrome), que não roda no CI.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error módulo .mjs sem tipos (script de QA, fora do tsconfig)
import { contrastRatio, relativeLuminance, compositeOver, requiredRatio, isLargeText, evaluateContrast, STATUS, THRESHOLDS, round2 } from "../scripts/qa-visual/lib/contrast.mjs";
// @ts-expect-error módulo .mjs sem tipos
import { assertDisposableDatabase, deriveQaUrlFromTestUrl, readEnvValue } from "../scripts/qa-visual/lib/guard.mjs";
// @ts-expect-error módulo .mjs sem tipos
import { Report, EXIT, comboKey, expectedCombos, coverageGaps } from "../scripts/qa-visual/lib/report.mjs";
// @ts-expect-error módulo .mjs sem tipos
import { VIEWPORTS, viewportKey, viewportMatches, emulationParams, parseViewportsOption } from "../scripts/qa-visual/lib/viewport.mjs";
// @ts-expect-error módulo .mjs sem tipos
import { Cleanups } from "../scripts/qa-visual/lib/cleanup.mjs";
// @ts-expect-error módulo .mjs sem tipos
import { planRecovery, recoverOrphans, RunState, readState, OURS } from "../scripts/qa-visual/lib/orphans.mjs";
// @ts-expect-error módulo .mjs sem tipos
import { candidatePaths, findBrowser } from "../scripts/qa-visual/lib/browser.mjs";
// @ts-expect-error módulo .mjs sem tipos
import { SCENARIOS, REQUIRED_COVERAGE, THEMES } from "../scripts/qa-visual/scenarios.mjs";
// @ts-expect-error módulo .mjs sem tipos
import { MUTATIONS, SENTINELS } from "../scripts/qa-visual/selftest.mjs";

describe("contraste WCAG (valores de referência conhecidos)", () => {
  it("preto sobre branco = 21:1; mesma cor = 1:1; simétrico", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([120, 80, 40], [120, 80, 40])).toBeCloseTo(1, 10);
    expect(contrastRatio([10, 20, 30], [200, 210, 220])).toBeCloseTo(contrastRatio([200, 210, 220], [10, 20, 30]), 12);
  });
  it("fronteira conhecida: #767676 sobre branco passa 4,5:1 (4,54) e #777777 não (4,48)", () => {
    expect(round2(contrastRatio([0x76, 0x76, 0x76], [255, 255, 255]))).toBe(4.54);
    expect(round2(contrastRatio([0x77, 0x77, 0x77], [255, 255, 255]))).toBe(4.48);
    expect(evaluateContrast({ fg: [0x76, 0x76, 0x76, 1], bg: [255, 255, 255], kind: "text" }).status).toBe(STATUS.PASS);
    expect(evaluateContrast({ fg: [0x77, 0x77, 0x77, 1], bg: [255, 255, 255], kind: "text" }).status).toBe(STATUS.FAIL);
  });
  it("luminância relativa: extremos e verde dominante", () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 10);
    expect(relativeLuminance([0, 255, 0])).toBeCloseTo(0.7152, 4);
  });
  it("composição com alfa sobre um fundo opaco", () => {
    expect(compositeOver([0, 0, 0, 0.5], [255, 255, 255])).toEqual([127.5, 127.5, 127.5]);
    expect(compositeOver([10, 20, 30, 1], [255, 255, 255])).toEqual([10, 20, 30]);
    expect(compositeOver([200, 0, 0, 0], [1, 2, 3])).toEqual([1, 2, 3]);
  });
  it("a decisão usa o valor SEM arredondar (4,496 arredonda para 4,5 mas reprova)", () => {
    // procura um cinza cujo valor exato fique em [4,495; 4,5)
    let found = false;
    for (let g = 100; g < 140 && !found; g += 0.05) {
      const r = contrastRatio([g, g, g], [255, 255, 255]);
      if (r >= 4.495 && r < 4.5) { found = true; const ev = evaluateContrast({ fg: [g, g, g, 1], bg: [255, 255, 255], kind: "text" }); expect(ev.ratio).toBe(4.5); expect(ev.status).toBe(STATUS.FAIL); }
    }
    expect(found).toBe(true);
  });
});

describe("limites por tipo de elemento", () => {
  it("texto 4,5; texto grande 3; ícone, limite de componente e anel de foco 3", () => {
    expect(requiredRatio("text", { fontSizePx: 14, fontWeight: 400 })).toBe(4.5);
    expect(requiredRatio("text", { fontSizePx: 24, fontWeight: 400 })).toBe(3);
    expect(requiredRatio("text", { fontSizePx: 18.66, fontWeight: 700 })).toBe(3);
    expect(requiredRatio("text", { fontSizePx: 18.66, fontWeight: 400 })).toBe(4.5);
    for (const k of ["icon", "boundary", "ring"]) expect(requiredRatio(k)).toBe(3);
    expect(THRESHOLDS.text).toBe(4.5);
  });
  it("texto grande: 24px, ou 18,66px com peso >= 700", () => {
    expect(isLargeText(24, 400)).toBe(true);
    expect(isLargeText(23.9, 400)).toBe(false);
    expect(isLargeText(18.66, 700)).toBe(true);
    expect(isLargeText(18.65, 700)).toBe(false);
  });
  it("tipo desconhecido é erro (não vira PASS silencioso)", () => {
    expect(() => requiredRatio("qualquer")).toThrow(/desconhecido/);
  });
  it("o mesmo par pode passar como ícone (3:1) e falhar como texto (4,5:1)", () => {
    const fg = [0x94, 0x94, 0x94, 1]; // ~3,0:1 sobre branco
    expect(evaluateContrast({ fg, bg: [255, 255, 255], kind: "icon" }).status).toBe(STATUS.PASS);
    expect(evaluateContrast({ fg, bg: [255, 255, 255], kind: "text", fontSizePx: 14, fontWeight: 400 }).status).toBe(STATUS.FAIL);
  });
  it("reproduz as medições históricas da Fase 94 (valores já medidos no navegador)", () => {
    // ghost no escuro, ícone preto sobre o diálogo escuro: 1,35:1 — falha como ícone
    expect(evaluateContrast({ fg: [0, 0, 0, 1], bg: [42, 34, 29], kind: "icon" })).toMatchObject({ ratio: 1.35, status: STATUS.FAIL });
    // texto de erro antigo no escuro (221,85,75 sobre 42,34,29): 4,07:1; token novo (237,137,130): 6,32:1
    expect(evaluateContrast({ fg: [221, 85, 75, 1], bg: [42, 34, 29], kind: "text", fontSizePx: 12, fontWeight: 500 })).toMatchObject({ ratio: 4.07, status: STATUS.FAIL });
    expect(evaluateContrast({ fg: [237, 137, 130, 1], bg: [42, 34, 29], kind: "text", fontSizePx: 12, fontWeight: 500 })).toMatchObject({ ratio: 6.32, status: STATUS.PASS });
  });
});

describe("guarda do banco descartável", () => {
  it("aceita só banco local terminando em _qa e não devolve credenciais", () => {
    const r = assertDisposableDatabase("postgres://u:senha@localhost:5433/levora_f94_qa");
    expect(r).toEqual({ host: "localhost", port: "5433", database: "levora_f94_qa" });
    expect(JSON.stringify(r)).not.toContain("senha");
    expect(assertDisposableDatabase("postgresql://u:p@127.0.0.1/x_qa").port).toBe("5432");
  });
  it.each([
    ["banco de desenvolvimento", "postgres://u:p@localhost:5433/levora_solidaria"],
    ["banco de teste (não _qa)", "postgres://u:p@localhost:5433/levora_f94_test"],
    ["dev com sufixo parecido", "postgres://u:p@localhost:5433/levora_f94_dev"],
    ["host remoto", "postgres://u:p@db.exemplo.com:5432/algo_qa"],
    ["nome só '_qa' sem prefixo válido", "postgres://u:p@localhost:5432/QA"],
    ["protocolo errado", "mysql://u:p@localhost:3306/x_qa"],
    ["URL inválida", "isto-nao-e-url"],
    ["vazia", ""],
  ])("recusa: %s", (_n, url) => {
    expect(() => assertDisposableDatabase(url)).toThrow();
  });
  it("deriva _qa de _test, recusa derivar de outro nome e lê .env sem dotenv", () => {
    expect(deriveQaUrlFromTestUrl("postgres://u:p@localhost:5433/levora_f94_test")).toBe("postgres://u:p@localhost:5433/levora_f94_qa");
    expect(() => deriveQaUrlFromTestUrl("postgres://u:p@localhost:5433/levora_solidaria")).toThrow();
    expect(readEnvValue("# c\nA=1\r\nDATABASE_URL='postgres://x/y_test'\n", "DATABASE_URL")).toBe("postgres://x/y_test");
    expect(readEnvValue("A=1", "DATABASE_URL")).toBeUndefined();
  });
});

describe("relatório e códigos de saída", () => {
  const row = (status: string) => ({ browser: "edge", version: "v", scenario: "s", target: "t", variant: "x", theme: "light", state: "normal", kind: "text", status });
  it("distingue violação, não medido e ambiente indisponível", () => {
    const ok = new Report(); ok.add(row(STATUS.PASS)); ok.add(row(STATUS.SKIP));
    expect(ok.exitCode()).toBe(EXIT.OK);
    const fail = new Report(); fail.add(row(STATUS.PASS)); fail.add(row(STATUS.FAIL)); fail.add(row(STATUS.MISSING));
    expect(fail.exitCode()).toBe(EXIT.FAIL);
    const miss = new Report(); miss.add(row(STATUS.PASS)); miss.add(row(STATUS.MISSING));
    expect(miss.exitCode()).toBe(EXIT.UNMEASURED);
    const unm = new Report(); unm.add(row(STATUS.UNMEASURABLE));
    expect(unm.exitCode()).toBe(EXIT.UNMEASURED);
    const env = new Report(); env.add(row(STATUS.PASS)); env.add(row(STATUS.FAIL)); env.addEnv("navegador ausente");
    expect(env.exitCode()).toBe(EXIT.ENV);
    expect(new Set(Object.values(EXIT)).size).toBe(Object.values(EXIT).length);
  });
  it("rejeita status inválido e mostra falhas antes dos PASS", () => {
    const r = new Report();
    expect(() => r.add(row("TALVEZ"))).toThrow(/status inválido/);
    r.add({ ...row(STATUS.PASS), scenario: "aprovado" }); r.add({ ...row(STATUS.FAIL), scenario: "reprovado", ratio: 1.35, required: 3 });
    const lines = r.format();
    expect(lines.some((l: string) => l.includes("reprovado") && l.startsWith("FAIL"))).toBe(true);
    expect(lines.some((l: string) => l.includes("aprovado") && l.startsWith("PASS"))).toBe(false); // PASS só com --verbose
    expect(r.format({ verbose: true }).some((l: string) => l.includes("aprovado"))).toBe(true);
    expect(r.counts()).toMatchObject({ PASS: 1, FAIL: 1, MISSING: 0, UNMEASURABLE: 0 });
  });
});

describe("descoberta de navegador", () => {
  it("caminhos padrão por plataforma e override explícito como único candidato", () => {
    const win = candidatePaths("edge", { "PROGRAMFILES(X86)": "C:\\Pf86", PROGRAMFILES: "C:\\Pf" }, "win32");
    expect(win.some((p: string) => p.endsWith("msedge.exe"))).toBe(true);
    expect(candidatePaths("chrome", {}, "darwin")).toEqual(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]);
    expect(candidatePaths("chrome", { QA_CHROME_PATH: "/x/chrome" }, "linux")).toEqual(["/x/chrome"]);
  });
  it("findBrowser devolve o primeiro existente ou undefined", () => {
    expect(findBrowser("chrome", (p: string) => p.includes("chromium"), {}, "linux")).toBe("/usr/bin/chromium");
    expect(findBrowser("edge", () => false, {}, "linux")).toBeUndefined();
    expect(findBrowser("chrome", () => false, { QA_CHROME_PATH: "/nao/existe" }, "linux")).toBeUndefined();
  });
});

describe("consistência dos cenários e do autoteste", () => {
  const scenarioIds = new Set(SCENARIOS.map((s: { id: string }) => s.id));
  it("ids únicos; campos obrigatórios; estados e medidas válidos", () => {
    expect(scenarioIds.size).toBe(SCENARIOS.length);
    const states: Record<string, string[]> = { button: ["normal", "hover", "active", "focus"], switch: ["off", "off-focus", "on", "on-focus", "disabled"] };
    for (const s of SCENARIOS) {
      expect(["guest", "owner", "volunteer"]).toContain(s.user);
      expect(s.path.startsWith("/")).toBe(true);
      expect(["button", "switch", "field", "errorText", "text", "boundary", "dropzoneFocus"]).toContain(s.measure);
      for (const step of s.steps) expect(Object.keys(step).length === 1 && ("click" in step || "setFile" in step)).toBe(true);
      for (const vp of s.viewports ?? []) expect(VIEWPORTS.some((v: { w: number }) => v.w === vp.w)).toBe(true);
      expect(typeof s.target.css).toBe("string");
      if (states[s.measure]) for (const st of s.states) expect(states[s.measure]).toContain(st);
      if (s.info) expect(s.states.every((st: string) => ["normal", "disabled"].includes(st))).toBe(true);
    }
  });
  it("cobre as variantes e tokens protegidos e os dois temas", () => {
    const variants = new Set(SCENARIOS.map((s: { variant: string }) => s.variant));
    for (const need of REQUIRED_COVERAGE) expect(variants.has(need), `cobertura de "${need}"`).toBe(true);
    expect(THEMES).toEqual(["light", "dark"]);
    const buttonStates = (v: string) => new Set(SCENARIOS.filter((s: { variant: string }) => s.variant === v).flatMap((s: { states?: string[] }) => s.states ?? []));
    for (const v of ["primary", "outline", "ghost (ícone)", "destructive"]) for (const st of ["normal", "hover", "active", "focus"]) expect(buttonStates(v).has(st), `${v}/${st}`).toBe(true);
    const sw = buttonStates("Switch"); for (const st of ["off", "off-focus", "on", "on-focus"]) expect(sw.has(st)).toBe(true);
    expect(buttonStates("Switch (desabilitado)").has("disabled")).toBe(true);
  });
  it("cada mutação do autoteste aponta para cenários reais; há sentinelas de ausência e de estado impossível", () => {
    for (const m of MUTATIONS) { expect(((m.css ?? m.js) as string).length).toBeGreaterThan(5); for (const w of m.viewports ?? [1280]) expect(VIEWPORTS.some((v: { w: number }) => v.w === w), `${m.id} viewport ${w}`).toBe(true); for (const id of m.scenarios) expect(scenarioIds.has(id), `${m.id} → ${id}`).toBe(true); }
    expect(new Set(MUTATIONS.map((m: { id: string }) => m.id)).size).toBe(MUTATIONS.length);
    expect(SENTINELS.map((s: { expect: string }) => s.expect).sort()).toEqual(["MISSING", "UNMEASURABLE"]);
    // cobertura das correções: ghost, primary, destructive, outline, switch, borda, tamanho e erro têm uma regressão injetável
    const covered = new Set(MUTATIONS.flatMap((m: { scenarios: string[] }) => m.scenarios));
    for (const id of ["needs-ghost-edit-icon", "needs-primary-new", "matching-destructive-confirm", "needs-edit-dialog-cancel", "matching-switch", "login-field-border-sizing", "login-error-text"]) expect(covered.has(id), id).toBe(true);
  });
});

describe("viewports (375×812, 390×844, 768×1024, 1280×900) e conferência das dimensões úteis", () => {
  it("a matriz tem exatamente os 4 viewports pedidos; só os de telefone usam emulação mobile", () => {
    expect(VIEWPORTS.map(viewportKey)).toEqual(["375x812", "390x844", "768x1024", "1280x900"]);
    expect(VIEWPORTS.map((v: { mobile: boolean }) => v.mobile)).toEqual([true, true, false, false]);
    expect(emulationParams(VIEWPORTS[0])).toEqual({ width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  });
  it("as dimensões registradas precisam bater com o que a PÁGINA enxerga (tolerância de 1px)", () => {
    const vp = { w: 390, h: 844 };
    expect(viewportMatches(vp, { innerWidth: 390, innerHeight: 844 })).toBe(true);
    expect(viewportMatches(vp, { innerWidth: 391, innerHeight: 843 })).toBe(true);
    expect(viewportMatches(vp, { innerWidth: 980, innerHeight: 2121 })).toBe(false); // layout de 980px sem meta viewport / emulação não aplicada
    expect(viewportMatches(vp, { innerWidth: 390, innerHeight: 700 })).toBe(false);
  });
  it("--viewports aceita largura ou WxH, rejeita desconhecido e vazio", () => {
    expect(parseViewportsOption("375,1280x900").map(viewportKey)).toEqual(["375x812", "1280x900"]);
    expect(parseViewportsOption(undefined)).toHaveLength(4);
    expect(() => parseViewportsOption("320")).toThrow(/desconhecido/);
    expect(() => parseViewportsOption(" , ")).toThrow(/vazio/);
  });
  it("todo cenário roda nos 4 viewports, salvo declaração explícita", () => {
    const sub = SCENARIOS.filter((s: { viewports?: unknown[] }) => s.viewports);
    expect(sub.map((s: { id: string }) => s.id)).toEqual([]); // nenhum cenário atual restringe viewports: cobertura integral
  });
});

describe("cobertura da matriz: o que não aparece no relatório é lacuna, nunca aprovação", () => {
  const scenarios = [{ id: "a" }, { id: "b" }];
  const expected = expectedCombos({ browsers: ["edge", "chrome"], scenarios, viewports: ["375x812", "1280x900"], themes: ["light", "dark"] });
  const row = (browser: string, scenario: string, viewport: string, theme: string) => ({ browser, scenario, viewport, theme, status: "PASS" });
  it("gera navegador × cenário × viewport × tema (2×2×2×2 = 16) e respeita viewports do cenário", () => {
    expect(expected).toHaveLength(16);
    expect(expected).toContain(comboKey("chrome", "b", "1280x900", "dark"));
    expect(expectedCombos({ browsers: ["edge"], scenarios: [{ id: "x", viewports: ["375x812"] }], viewports: ["375x812", "1280x900"], themes: ["light"] })).toEqual(["edge|x|375x812|light"]);
  });
  it("combinação sem nenhuma linha vira lacuna; com uma linha (mesmo FAIL/MISSING) está coberta", () => {
    const rows = expected.filter((k: string) => k !== comboKey("edge", "a", "375x812", "dark")).map((k: string) => { const [b, s, v, t] = k.split("|"); return row(b, s, v, t); });
    expect(coverageGaps(rows, expected)).toEqual(["edge|a|375x812|dark"]);
    const missing = { ...row("edge", "a", "375x812", "dark"), status: "MISSING" };
    expect(coverageGaps([...rows, missing], expected)).toEqual([]);
  });
  it("um cenário que só gerou erro NÃO conta como aprovado: o código de saída reflete UNMEASURABLE/MISSING", () => {
    const r = new Report();
    r.add({ browser: "edge", version: "v", scenario: "s", target: "t", variant: "x", viewport: "375x812", theme: "light", state: "execução", kind: "estado", status: "UNMEASURABLE" });
    expect(r.counts().PASS).toBe(0);
    expect(r.exitCode()).toBe(EXIT.UNMEASURED);
  });
  it("o resumo separa verificações por navegador e viewport (não são componentes independentes)", () => {
    const r = new Report();
    r.add({ ...row("edge", "a", "375x812", "light"), version: "v", target: "t", variant: "x", state: "n", kind: "text" });
    r.add({ ...row("chrome", "a", "375x812", "light"), version: "v", target: "t", variant: "x", state: "n", kind: "text", status: "FAIL" });
    expect(r.byBrowserViewport()).toEqual(["edge 375x812: 1 PASS", "chrome 375x812: 0 PASS, 1 outros"]);
    expect(r.format().join("\n")).toMatch(/não componentes independentes/);
  });
});

describe("limpeza de recursos (sucesso, falha e execução morta à força)", () => {
  it("Cleanups roda em ordem inversa, continua depois de uma falha e é idempotente", async () => {
    const order: string[] = []; const c = new Cleanups();
    c.add("banco", async () => { order.push("banco"); });
    c.add("api", async () => { order.push("api"); throw new Error("falhou ao parar a API"); });
    c.add("navegador", async () => { order.push("navegador"); });
    const errors = await c.runAll();
    expect(order).toEqual(["navegador", "api", "banco"]); // o banco só cai depois de parar o resto, mesmo com a falha no meio
    expect(errors).toEqual([{ name: "api", message: "falhou ao parar a API" }]);
    await c.runAll(); // segunda chamada (Ctrl+C + fim normal) não repete nada
    expect(order).toHaveLength(3);
  });
  it("planRecovery: execução anterior viva e nossa = ocupado; órfãos só se o PID ainda for processo NOSSO", () => {
    const state = { orchestrator: 10, children: [{ pid: 11, kind: "api" }, { pid: 12, kind: "browser" }, { pid: 13, kind: "vite" }], profiles: ["/tmp/levora-qa-profile-x"], database: "levora_qa" };
    const cmd: Record<number, string> = { 10: "node scripts/qa-visual/run.mjs", 11: "node tsx scripts/qa-visual/api.ts", 12: "msedge --user-data-dir=/tmp/levora-qa-profile-x", 13: "notepad.exe" };
    const busy = planRecovery(state, { alive: () => true, cmdline: (p: number) => cmd[p] });
    expect(busy).toMatchObject({ busy: true, pid: 10 });
    const dead = planRecovery(state, { alive: (p: number) => p !== 10, cmdline: (p: number) => cmd[p] });
    expect(dead).toMatchObject({ busy: false, kill: [11, 12], database: "levora_qa", profiles: ["/tmp/levora-qa-profile-x"] }); // 13 (PID reaproveitado por outro programa) NÃO é encerrado
    expect(planRecovery(null, { alive: () => true, cmdline: () => "" })).toEqual({ busy: false, kill: [], profiles: [], database: null, containers: [] });
    expect(OURS.test("qa-visual")).toBe(true);
    expect(OURS.test("notepad.exe")).toBe(false);
  });
  it("recoverOrphans: encerra, apaga só perfis levora-qa-profile-*, derruba o banco e limpa o registro", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qa-orphans-test-"));
    const file = path.join(dir, "active.json");
    const profile = path.join(dir, "levora-qa-profile-abc"); mkdirSync(profile);
    const alien = path.join(dir, "outra-pasta"); mkdirSync(alien);
    const rs = new RunState(file); rs.s.orchestrator = 99999991; // um PID que não existe
    rs.addChild(99999992, "browser"); rs.addProfile(profile); rs.addProfile(alien); rs.setDatabase("levora_f94_qa");
    const killed: number[] = []; const dropped: string[] = [];
    const out = await recoverOrphans({ file, alive: (p: number) => p === 99999992, cmdline: () => "msedge levora-qa-profile-abc", actions: { killTree: async (p: number) => { killed.push(p); }, removeDir: async (d: string) => { rmSync(d, { recursive: true, force: true }); }, dropDb: async (n: string) => { dropped.push(n); } } });
    expect(out).toMatchObject({ busy: false, killed: [99999992], database: "levora_f94_qa" });
    expect(killed).toEqual([99999992]); expect(dropped).toEqual(["levora_f94_qa"]);
    expect(existsSync(profile)).toBe(false); // perfil nosso: apagado
    expect(existsSync(alien)).toBe(true); // diretório que não é nosso: preservado
    expect(readState(file)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
  it("RunState persiste cada recurso e remove o registro no fim", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qa-state-test-")); const file = path.join(dir, "s.json");
    const rs = new RunState(file); rs.begin(); rs.addChild(5, "api"); rs.addProfile("p"); rs.setDatabase("x_qa");
    expect(readState(file)).toMatchObject({ children: [{ pid: 5, kind: "api" }], profiles: ["p"], database: "x_qa" });
    expect(JSON.stringify(readState(file))).not.toMatch(/postgres:\/\//); // nunca guarda credenciais
    rs.dropChild(5); rs.dropProfile("p"); rs.clearDatabase();
    expect(readState(file)).toMatchObject({ children: [], profiles: [], database: null });
    rs.end(); expect(readState(file)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("novos cenários: variação negativa do inventário e FileDropzone", () => {
  const byId = new Map(SCENARIOS.map((s: { id: string }) => [s.id, s]));
  it("existem, com semente que os alimenta (saída de 1 kg e atribuição aceita)", () => {
    for (const id of ["inventory-delta-negative", "inventory-delta-positive", "inventory-delta-icon-out", "dropzone-title", "dropzone-subtitle", "dropzone-border", "dropzone-keyboard-focus", "dropzone-error-text", "dropzone-error-clear"]) expect(byId.has(id), id).toBe(true);
    const neg = byId.get("inventory-delta-negative") as { sign: string };
    expect(new RegExp(neg.sign).test("-1 kg")).toBe(true); expect(new RegExp(neg.sign).test("1 kg")).toBe(false); // o sinal precisa estar no texto, não só na cor
    const err = byId.get("dropzone-error-text") as { steps: Array<Record<string, { fileName?: string }>> };
    expect(err.steps.some((st) => st.setFile && /invalido/.test(st.setFile.fileName ?? ""))).toBe(true);
  });
});
