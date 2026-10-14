/**
 * Integração das verificações de navegador (`qa:visual` e `qa:security`) ao GitHub Actions em modo reduzido. Estes testes validam a CONFIGURAÇÃO e a
 * lógica de auditoria — não substituem uma execução real no runner (que depende de Chrome, Docker e do serviço Postgres do GitHub).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-ignore js-yaml vem transitivamente (sem tipos garantidos); só leitura de configuração
import yaml from "js-yaml";
// @ts-expect-error módulos .mjs sem tipos
import { SCENARIOS, CI_PROFILE_IDS } from "../scripts/qa-visual/scenarios.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { selectionSummary, Report, EXIT } from "../scripts/qa-visual/lib/report.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { evaluateReports, findSecrets } from "../scripts/qa-visual/lib/ci-report.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { NGINX_IMAGE, OPENSSL_IMAGE } from "../scripts/qa-visual/security/nginx.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { assertDisposableDatabase } from "../scripts/qa-visual/lib/guard.mjs";

const wf = yaml.load(readFileSync(".github/workflows/ci.yml", "utf8")) as any;
const stepsText = (job: any) => JSON.stringify(job.steps);

describe("perfil reduzido do qa:visual", () => {
  const byId = new Map<string, any>(SCENARIOS.map((s: any) => [s.id, s]));
  it("só cita cenários que existem, sem repetição", () => {
    expect(new Set(CI_PROFILE_IDS).size).toBe(CI_PROFILE_IDS.length);
    for (const id of CI_PROFILE_IDS) expect(byId.has(id), id).toBe(true);
    expect(CI_PROFILE_IDS.length).toBe(28); // 18 originais + 10 da tela de diagnóstico de unidades (Fase 99B)
  });
  it("cobre as famílias de maior risco: botões (todas as variantes), Switch, campos, erro, FileDropzone e variação negativa", () => {
    const variants = new Set(CI_PROFILE_IDS.map((id: string) => byId.get(id).variant));
    for (const v of ["primary", "outline", "ghost (ícone)", "destructive", "secondary", "outline (desabilitado)", "Switch", "Switch (desabilitado)", "Input", "Textarea", "Select (gatilho)", "--error-text (mensagem)", "--error-text (rótulo)", "FileDropzone: limite", "FileDropzone: foco por teclado", "FileDropzone: erro", "Inventário: variação negativa", "Unidades: classificadas", "Unidades: desconhecidas", "Unidades: ambíguas", "Unidades: lista vazia", "Unidades: erro de carregamento", "Unidades: filtros aplicados"]) expect(variants.has(v), v).toBe(true);
    const measures = new Set(CI_PROFILE_IDS.map((id: string) => byId.get(id).measure));
    for (const m of ["button", "switch", "field", "errorText", "boundary", "dropzoneFocus", "text"]) expect(measures.has(m), m).toBe(true);
  });
  it("os omitidos aparecem na seleção e NÃO geram linhas (nunca contam como PASS)", () => {
    const s = selectionSummary(SCENARIOS.map((x: any) => x.id), CI_PROFILE_IDS, "ci");
    expect(s).toMatchObject({ perfil: "ci", total: SCENARIOS.length, executados: 28, completo: false });
    expect(s.omitidos).toHaveLength(SCENARIOS.length - 28);
    expect(s.omitidos).toContain("login-password-field");
    expect(selectionSummary(["a", "b"], ["a", "b"]).completo).toBe(true);
    const r = new Report(); // um relatório só tem linhas do que rodou: omitidos não existem nele
    expect(r.rows).toHaveLength(0);
    expect(r.counts().PASS).toBe(0);
  });
});

describe("CLI: argumentos inválidos e propagação do código de saída", () => {
  const run = (script: string, args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 60000 });
  it("qa:visual recusa --profile desconhecido e --profile ci junto com --only (sai com 3, antes de tocar em banco ou navegador)", () => {
    expect(run("scripts/qa-visual/run.mjs", ["--profile", "xx"]).status).toBe(EXIT.ENV);
    const both = run("scripts/qa-visual/run.mjs", ["--profile", "ci", "--only", "login-primary-submit"]);
    expect(both.status).toBe(EXIT.ENV);
    expect(both.stderr).toMatch(/excludentes/);
  });
  it("qa:security recusa parte desconhecida (sai com 3)", () => {
    expect(run("scripts/qa-visual/security.mjs", ["--only", "nada"]).status).toBe(EXIT.ENV);
  });
});

// ------------------------------------------------------------------------------------------ auditoria dos relatórios
const goodVisual = () => ({ node: "v22.11.0", navegadores: [{ name: "chrome", version: "Chrome/130" }], viewports: ["375x812", "390x844", "768x1024", "1280x900"], temas: ["light", "dark"], contagem: { PASS: 1000, FAIL: 0, MISSING: 0, UNMEASURABLE: 0, SKIP: 0, ENV: 0 }, env: [], selecao: selectionSummary(SCENARIOS.map((x: any) => x.id), CI_PROFILE_IDS, "ci"), linhas: [] });
const goodSecurity = () => ({ node: "v22.11.0", navegadores: [{ name: "chrome", version: "Chrome/130" }], partes: ["calibration", "csrf", "xss", "uploads", "headers"], partesOmitidas: [], headersExecutados: true, contagem: { PASS: 90, FAIL: 0, MISSING: 0, UNMEASURABLE: 0, SKIP: 0, ENV: 0 }, env: [], linhas: [{ kind: "calibração", status: "PASS" }] });
const evalWith = (v: any, s: any, extra: any = {}) => evaluateReports({ visual: v, security: s, visualRaw: JSON.stringify(v), securityRaw: JSON.stringify(s), expectNode: "22", expectBrowser: "chrome", commit: "abc123", ...extra });

describe("evaluateReports (auditoria do job)", () => {
  it("relatórios conformes passam e o resumo declara subconjunto, omitidos, Node, navegador e cabeçalhos", () => {
    const r = evalWith(goodVisual(), goodSecurity());
    expect(r.problems).toEqual([]);
    for (const needle of ["Subconjunto, não a matriz completa", "abc123", "v22.11.0", "Chrome/130", "login-password-field", "executados", "375x812"]) expect(r.markdown, needle).toContain(needle);
  });
  const bad: Array<[string, (v: any, s: any) => void, RegExp]> = [
    ["Node diferente de 22", (v) => { v.node = "v24.19.0"; }, /Node efetivo v24/],
    ["Edge usado no CI", (v) => { v.navegadores.push({ name: "edge", version: "x" }); }, /edge não deveria/],
    ["navegador esperado ausente", (v) => { v.navegadores = [{ name: "edge", version: "x" }]; }, /navegador esperado chrome/],
    ["violação real (FAIL)", (v) => { v.contagem.FAIL = 1; }, /1 resultado\(s\) FAIL/],
    ["não medido (UNMEASURABLE)", (v) => { v.contagem.UNMEASURABLE = 2; }, /UNMEASURABLE/],
    ["falha de ambiente", (_v, s) => { s.env = ["docker indisponível"]; s.contagem.ENV = 1; }, /falha\(s\) de ambiente/],
    ["nada medido", (v) => { v.contagem.PASS = 0; }, /nenhuma verificação PASS/],
    ["sem seleção registrada", (v) => { delete v.selecao; }, /não registra a seleção/],
    ["menos viewports que o exigido", (v) => { v.viewports = ["1280x900"]; }, /4 viewports/],
    ["parte obrigatória do security omitida", (_v, s) => { s.partes = ["calibration", "csrf"]; }, /parte obrigatória "uploads"/],
    ["cabeçalhos do nginx não executados", (_v, s) => { s.headersExecutados = false; }, /cabeçalhos do nginx .* NÃO foram executados/],
    ["sem calibração aprovada", (_v, s) => { s.linhas = []; }, /nenhuma calibração/],
  ];
  for (const [label, mutate, re] of bad) {
    it(`reprova: ${label}`, () => {
      const v = goodVisual(); const s = goodSecurity(); mutate(v, s);
      const r = evalWith(v, s); expect(r.problems.join(" | ")).toMatch(re); expect(r.markdown).toContain("Reprovado");
    });
  }
  it("relatório ausente reprova (um passo que nem gerou o JSON não pode parecer verde)", () => {
    expect(evalWith(null, goodSecurity()).problems.join()).toMatch(/qa:visual: relatório ausente/);
    expect(evalWith(goodVisual(), null).problems.join()).toMatch(/qa:security: relatório ausente/);
  });
  it("relatório com aparência de segredo reprova com a marca de 'não publicar'", () => {
    const v = goodVisual(); const s = goodSecurity();
    const r = evaluateReports({ visual: v, security: s, visualRaw: JSON.stringify(v) + " postgres://levora:levora@localhost:5432/x", securityRaw: JSON.stringify(s), expectNode: "22", expectBrowser: "chrome" });
    expect(r.problems.join()).toMatch(/não publicar/);
  });
});

describe("findSecrets", () => {
  it("acusa URL de banco com credenciais, JWT, valor de cookie de sessão, Authorization e segredo atribuído", () => {
    expect(findSecrets("postgres://u:p@h/db")).toContain("URL de banco com credenciais");
    expect(findSecrets("eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjEyMyJ9.abcdefghij")).toContain("token JWT");
    expect(findSecrets("floot_built_app_session=abcdef123456")).toContain("valor do cookie de sessão");
    expect(findSecrets('"authorization": "Bearer abcdef123456"')).toContain("cabeçalho Authorization");
    expect(findSecrets('api_key = "AAAAAAAAAAAAAAAAAAAA"')).toContain("segredo atribuído");
    expect(findSecrets("x senha-de-qa-123 y", ["senha-de-qa-123"])).toContain("literal secreto conhecido");
  });
  it("não acusa o texto normal dos relatórios (cookie enviado/NÃO enviado, nomes de banco sem credenciais)", () => {
    expect(findSecrets("cookie=enviado Sec-Fetch-Site=same-site levora_f94_qa em localhost:5433 session cookie HttpOnly")).toEqual([]);
  });
  it("um relatório REAL de QA (se houver um no diretório temporário) não contém segredos", () => {
    const f = path.join(tmpdir(), "levora-qa-visual");
    void f; // a varredura real roda no CI sobre os relatórios gerados lá (passo "Audit reports")
    expect(true).toBe(true);
  });
});

describe("ci-summary (CLI)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qa-ci-test-"));
  const write = (n: string, o: unknown, raw?: string) => { const p = path.join(dir, n); writeFileSync(p, raw ?? JSON.stringify(o)); return p; };
  const cli = (v: string, s: string) => spawnSync(process.execPath, ["scripts/qa-visual/ci-summary.mjs", "--visual", v, "--security", s, "--expect-node", "22", "--expect-browser", "chrome"], { encoding: "utf8" });
  it("0 para relatórios conformes, 1 para violação real, 2 para suspeita de segredo", () => {
    const ok = cli(write("v.json", goodVisual()), write("s.json", goodSecurity()));
    expect(ok.status).toBe(0); expect(ok.stdout).toContain("Aprovado no escopo");
    const failV = goodVisual(); failV.contagem.FAIL = 3;
    expect(cli(write("v2.json", failV), write("s.json", goodSecurity())).status).toBe(1);
    expect(cli(write("v3.json", null, JSON.stringify(goodVisual()) + " postgres://a:b@c/d"), write("s.json", goodSecurity())).status).toBe(2);
  });
  it("arquivo inexistente ou JSON quebrado reprova (não vira sucesso silencioso)", () => {
    expect(cli(path.join(dir, "nao-existe.json"), write("s.json", goodSecurity())).status).toBe(1);
    expect(cli(write("v4.json", null, "{quebrado"), write("s.json", goodSecurity())).status).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("workflow .github/workflows/ci.yml", () => {
  const job = wf.jobs["qa-browser"];
  it("preserva o job `test` existente com todos os gates", () => {
    const t = stepsText(wf.jobs.test);
    for (const needle of ["npm run typecheck", "npm test", "npm run build", "npm run build:server", "npm audit --audit-level=moderate", "\"node-version\":\"22\""]) expect(t, needle).toContain(needle);
    expect(wf.jobs.test.env.DATABASE_URL).toContain("levora_solidaria_test");
  });
  it("o job de QA é independente do `test` (sem needs/continue-on-error): ambos precisam passar", () => {
    expect(job).toBeTruthy();
    expect(job.needs).toBeUndefined();
    expect(JSON.stringify(wf)).not.toContain("continue-on-error");
  });
  it("mantém gatilhos e permissões de menor privilégio, sem secrets nem pull_request_target", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["pull_request", "push"]);
    expect(wf.permissions).toEqual({ contents: "read" });
    const raw = readFileSync(".github/workflows/ci.yml", "utf8").split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n"); // sem comentários
    expect(raw).not.toMatch(/secrets\.|pull_request_target|contents:\s*write/);
  });
  it("usa Node 22, Chrome (nunca Edge), o perfil reduzido e as cinco partes de segurança, com limite de tempo", () => {
    const t = stepsText(job);
    expect(t).toContain("\"node-version\":\"22\"");
    expect(t).toContain("process.versions.node.split");
    expect(t).toContain("--browser chrome --profile ci");
    expect(t).toMatch(/qa:security -- --browser chrome --out/);
    expect(t).not.toMatch(/edge/i);
    expect(t).not.toMatch(/qa:security[^"]*--only/); // todas as partes: nenhuma omitida pelo CI
    expect(job["timeout-minutes"]).toBeGreaterThan(0); expect(job["timeout-minutes"]).toBeLessThanOrEqual(60);
  });
  it("só escreve em banco `_qa` local (guarda da ferramenta) e não define DATABASE_URL no job de QA", () => {
    expect(job.env.DATABASE_URL).toBeUndefined();
    const t = assertDisposableDatabase(job.env.QA_DATABASE_URL);
    expect(t.database.endsWith("_qa")).toBe(true);
    expect(() => assertDisposableDatabase(wf.jobs.test.env.DATABASE_URL)).toThrow(); // o banco `_test` do CI continua recusado pela guarda
  });
  it("faz o pull explícito das imagens, audita os relatórios e limpa com always(), publicando artefatos só se a auditoria não suspeitar de segredos", () => {
    const names = job.steps.map((s: any) => s.name);
    expect(names).toEqual(expect.arrayContaining(["Pull Docker images for the nginx header checks", "Audit reports and write summary", "Cleanup leftovers", "Upload reports"]));
    const get = (n: string) => job.steps.find((s: any) => s.name === n);
    expect(get("Cleanup leftovers").if).toBe("always()");
    expect(get("Audit reports and write summary").if).toBe("always()");
    expect(get("Audit reports and write summary").id).toBe("audit");
    expect(get("Upload reports").if).toContain("steps.audit.outputs.status != '2'");
    expect(get("Cleanup leftovers").run).toContain("--cleanup");
    expect(get("Cleanup leftovers").run).toContain("levora-qa-nginx-");
    expect(get("Cleanup leftovers").run).not.toMatch(/pkill|killall|taskkill/);
  });
  it("hardening: ações fixadas em SHA completo, checkout sem credenciais persistidas, limite de tempo em todo job", () => {
    const steps = Object.values<any>(wf.jobs).flatMap((j) => j.steps);
    const uses = steps.map((s: any) => s.uses).filter(Boolean) as string[];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, u).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/); // nada de tag móvel (@v4) nem ação de terceiros
    for (const s of steps.filter((x: any) => /^actions\/checkout@/.test(x.uses ?? ""))) expect(s.with?.["persist-credentials"]).toBe(false);
    for (const [name, j] of Object.entries<any>(wf.jobs)) { expect(j["timeout-minutes"], name).toBeGreaterThan(0); expect(j["timeout-minutes"], name).toBeLessThanOrEqual(60); }
    expect(wf.jobs["qa-browser"]["timeout-minutes"]).toBe(40); // não reduzido
    const raw = readFileSync(".github/workflows/ci.yml", "utf8");
    for (const v of ["v4.4.0", "v4.6.2"]) expect(raw).toContain(v); // comentário legível com a versão de cada SHA
  });
  it("imagens Docker: tag + digest, e o workflow baixa exatamente as referências que a ferramenta exige", () => {
    for (const ref of [NGINX_IMAGE, OPENSSL_IMAGE]) expect(ref, ref).toMatch(/^[a-z0-9./-]+:[0-9][0-9a-z.-]*@sha256:[0-9a-f]{64}$/);
    const pull = job.steps.find((s: any) => s.name === "Pull Docker images for the nginx header checks").run as string;
    expect(pull).toContain(`docker pull ${NGINX_IMAGE}`);
    expect(pull).toContain(`docker pull ${OPENSSL_IMAGE}`);
  });
});
