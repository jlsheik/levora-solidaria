/**
 * G2 — progresso e prazo máximo do `qa:visual`, e as garantias do workflow que os usam. Valida lógica pura e CONFIGURAÇÃO; não substitui uma execução real
 * no runner do GitHub (Chrome, Docker, serviço PostgreSQL), que continua sendo o único jeito de provar o `qa-browser` verde.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
// @ts-ignore js-yaml vem transitivamente (sem tipos garantidos); só leitura de configuração
import yaml from "js-yaml";
// @ts-expect-error módulos .mjs sem tipos
import { Progress, countCells, fmtDuration, startDeadline, parseMaxMinutes } from "../scripts/qa-visual/lib/progress.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { SCENARIOS, CI_PROFILE_IDS, THEMES } from "../scripts/qa-visual/scenarios.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { VIEWPORTS } from "../scripts/qa-visual/lib/viewport.mjs";

describe("progresso do qa:visual", () => {
  it("conta as células como cenário × viewports × temas × navegadores (o perfil ci tem 568 para 71 cenários em 1 navegador)", () => {
    const chosen = SCENARIOS.filter((s: any) => CI_PROFILE_IDS.includes(s.id));
    expect(countCells([{}, {}], VIEWPORTS, THEMES, 1)).toBe(2 * VIEWPORTS.length * THEMES.length);
    expect(countCells([{ viewports: [VIEWPORTS[0]] }], VIEWPORTS, THEMES, 2)).toBe(1 * 1 * THEMES.length * 2);
    expect(countCells(chosen, VIEWPORTS, THEMES, 1)).toBeGreaterThan(0);
  });
  it("imprime a primeira célula, no máximo uma linha por intervalo e a última; só contagens e nomes", () => {
    let t = 0; const lines: string[] = [];
    const p = new Progress({ total: 5, everyMs: 60000, now: () => t, log: (l: string) => lines.push(l) });
    t = 1000; p.cell("a @375x812 light", 900);   // primeira: imprime
    t = 2000; p.cell("a @375x812 dark", 1000);    // dentro do intervalo: não imprime
    t = 3000; p.cell("b @390x844 light", 1000);   // idem
    t = 70000; p.cell("b @390x844 dark", 1200);   // passou o intervalo: imprime
    t = 71000; p.cell("c @768x1024 light", 1000); // última (5/5): imprime
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("progresso: 1/5");
    expect(lines[2]).toContain("progresso: 5/5");
    expect(lines.join("\n")).not.toMatch(/token|senha|cookie|postgres:\/\//i);
  });
  it("o diagnóstico do prazo diz quantas células terminaram, qual foi a última e a mais lenta", () => {
    let t = 0;
    const p = new Progress({ total: 10, everyMs: 1e9, now: () => t, log: () => {} });
    expect(p.describe()).toContain("0 de 10 células");
    expect(p.describe()).toContain("nenhuma");
    t = 5000; p.cell("x @1280x900 light", 400);
    t = 9000; p.cell("y @1280x900 dark", 2500);
    t = 20000;
    const d = p.describe();
    expect(d).toContain("2 de 10 células");
    expect(d).toContain("última concluída: y @1280x900 dark");
    expect(d).toContain("há 11 s");
    expect(d).toContain("célula mais lenta: y @1280x900 dark");
    expect(fmtDuration(3725000)).toBe("1 h 2 min 5 s");
  });
});

describe("prazo máximo do próprio script", () => {
  it("dispara uma vez, não segura o processo vivo (unref) e pode ser cancelado", () => {
    const calls: string[] = []; let fire: (() => void) | undefined; let unrefd = false; let cleared = false;
    const timer = { unref() { unrefd = true; } };
    const d = startDeadline({ maxMs: 1500000, onExpire: (r: string) => calls.push(r), setTimer: (f: () => void) => { fire = f; return timer; }, clearTimer: () => { cleared = true; } });
    expect(unrefd).toBe(true);
    fire!(); fire!();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("25 min");
    d.cancel(); expect(cleared).toBe(true);
    // cancelado antes de expirar: nunca dispara
    const calls2: string[] = []; let fire2: (() => void) | undefined;
    const d2 = startDeadline({ maxMs: 1000, onExpire: (r: string) => calls2.push(r), setTimer: (f: () => void) => { fire2 = f; return timer; }, clearTimer: () => {} });
    d2.cancel(); fire2!(); expect(calls2).toHaveLength(0);
  });
  it("sem prazo (0 ou omitido) não cria temporizador; valores inválidos são recusados, não ignorados", () => {
    let created = false;
    startDeadline({ maxMs: 0, onExpire: () => {}, setTimer: () => { created = true; return {}; } });
    expect(created).toBe(false);
    expect(parseMaxMinutes(undefined)).toBe(0);
    expect(parseMaxMinutes("25")).toBe(1500000);
    expect(parseMaxMinutes("0.5")).toBe(30000);
    for (const bad of ["0", "-3", "abc", "NaN", "601", ""]) expect(() => parseMaxMinutes(bad), bad).toThrow(/--max-minutes inválido/);
  });
  it("o qa:visual recusa --max-minutes inválido com código 3 antes de tocar em banco ou navegador", () => {
    const r = spawnSync(process.execPath, ["scripts/qa-visual/run.mjs", "--profile", "ci", "--max-minutes", "abc"], { encoding: "utf8", timeout: 60000 });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("--max-minutes inválido");
  });
});

describe("workflow ci.yml — prazos e diagnóstico (G2)", () => {
  const wf = yaml.load(readFileSync(".github/workflows/ci.yml", "utf8")) as any;
  const test = wf.jobs.test; const qa = wf.jobs["qa-browser"];
  const step = (job: any, name: string) => job.steps.find((s: any) => s.name === name);

  it("o job test cobre o tempo medido do conjunto cumulativo (≈31,5 min) com folga, sem ultrapassar o teto de 60 min dos testes de configuração", () => {
    expect(test["timeout-minutes"]).toBeGreaterThanOrEqual(40);
    expect(test["timeout-minutes"]).toBeLessThanOrEqual(60);
    const run = step(test, "Run tests");
    expect(run.run).toBe("npm test"); // a suíte inteira, sem filtro, sem fatiamento, sem --bail que esconda falhas
    expect(run["timeout-minutes"]).toBeLessThan(test["timeout-minutes"]);
    expect(run["timeout-minutes"]).toBeGreaterThan(31.5);
  });
  it("o qa:visual tem prazo do script < prazo do passo < prazo do job, diagnóstico por célula e relatório publicado", () => {
    const v = step(qa, "qa:visual (reduced profile, Chrome only)");
    const m = /--max-minutes (\d+)/.exec(v.run);
    expect(m).toBeTruthy();
    const scriptMin = Number(m![1]);
    expect(v.run).toContain("--browser chrome --profile ci");
    expect(v.run).toContain("--diagnostics reports/qa-visual-diagnostics");
    expect(scriptMin).toBeGreaterThan(14.5 * 1.5);          // bem acima do normal medido (~14,5 min) para não cortar uma execução válida
    expect(v["timeout-minutes"]).toBeGreaterThan(scriptMin); // o script encerra e diagnostica antes da rede de segurança do passo
    expect(v["timeout-minutes"]).toBeLessThan(qa["timeout-minutes"]);
    const up = step(qa, "Upload reports");
    expect(up.with.path).toContain("reports/qa-visual-diagnostics/");
    expect(step(qa, "qa:security (all parts, Chrome only)")["timeout-minutes"]).toBeLessThan(qa["timeout-minutes"]);
  });
  it("nada foi enfraquecido: sem continue-on-error, sem filtro de testes, gates do test e do qa-browser preservados", () => {
    const raw = readFileSync(".github/workflows/ci.yml", "utf8").split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(raw).not.toMatch(/continue-on-error/);
    expect(raw).not.toMatch(/--shard|--bail|--exclude|\.skip|--passWithNoTests|-t ["']/);
    expect(raw).not.toMatch(/secrets\.|pull_request_target|contents:\s*write|workflow_dispatch/);
    for (const n of ["Type check", "Run tests", "Build", "Build server (production backend artifact)", "Verify server build artifact", "Dependency audit (fails on moderate+ severity)"]) expect(step(test, n), n).toBeTruthy();
    for (const n of ["Record and assert environment", "Pull Docker images for the nginx header checks", "qa:visual (reduced profile, Chrome only)", "qa:security (all parts, Chrome only)", "Audit reports and write summary", "Cleanup leftovers", "Upload reports"]) expect(step(qa, n), n).toBeTruthy();
    expect(qa["timeout-minutes"]).toBe(40);
  });
});
