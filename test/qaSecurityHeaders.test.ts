/**
 * Lógica pura da parte "headers" e "uploads" do `npm run qa:security`: análise de CSP, conferência de cabeçalhos por tipo de resposta, adaptação
 * da configuração do nginx, casos de upload e recuperação de contêineres órfãos. Não provam o app: provam que a ferramenta classifica certo.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error módulos .mjs sem tipos
import { parseCsp, analyzeDocumentCsp, analyzeApiCsp, checkHeaders, headerCount } from "../scripts/qa-visual/security/csp.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { adaptProductionConf } from "../scripts/qa-visual/security/nginx.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { uploadCases } from "../scripts/qa-visual/security/uploads.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { readReferenceCsp, INJECTION_JS } from "../scripts/qa-visual/security/headers.mjs";
// @ts-expect-error módulos .mjs sem tipos
import { planRecovery, recoverOrphans, RunState } from "../scripts/qa-visual/lib/orphans.mjs";
import { DOCUMENT_CSP_WITH_FRAME_ANCESTORS } from "../src/helpers/securityHeaders";

const GOOD_DOC = {
  "content-security-policy": DOCUMENT_CSP_WITH_FRAME_ANCESTORS, "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=()", "strict-transport-security": "max-age=15552000; includeSubDomains", "cache-control": "no-cache",
};
const raw = (h: Record<string, string>) => Object.entries(h).flat();
const res = (headers: Record<string, string>, status = 200) => ({ status, headers, rawHeaders: raw(headers) });

describe("analyzeDocumentCsp", () => {
  it("a CSP de produção do projeto não tem problemas e registra a exceção documentada de style-src", () => {
    const a = analyzeDocumentCsp(DOCUMENT_CSP_WITH_FRAME_ANCESTORS);
    expect(a.problems).toEqual([]);
    expect(a.notes.join(" ")).toMatch(/style-src.*unsafe-inline/);
  });
  it("acusa as políticas frouxas: unsafe-inline/eval em script, curinga, esquema solto, sem frame-ancestors, sem política", () => {
    const base = DOCUMENT_CSP_WITH_FRAME_ANCESTORS;
    expect(analyzeDocumentCsp(base.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")).problems.join()).toMatch(/unsafe-inline/);
    expect(analyzeDocumentCsp(base.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'")).problems.join()).toMatch(/unsafe-eval/);
    expect(analyzeDocumentCsp(base.replace("connect-src 'self'", "connect-src *")).problems.join()).toMatch(/curinga/);
    expect(analyzeDocumentCsp(base.replace("connect-src 'self'", "connect-src 'self' https:")).problems.join()).toMatch(/esquema solto/);
    expect(analyzeDocumentCsp(base.replace("; frame-ancestors 'none'", "")).problems.join()).toMatch(/frame-ancestors/);
    expect(analyzeDocumentCsp("img-src 'self'").problems.join()).toMatch(/scripts livres/);
    expect(analyzeDocumentCsp(undefined).problems).toEqual(["sem Content-Security-Policy"]);
  });
  it("parseCsp usa a primeira ocorrência de uma diretiva repetida", () => {
    expect(parseCsp("a x; a y").get("a")).toEqual(["x"]);
  });
  it("analyzeApiCsp exige default-src 'none' e frame-ancestors 'none'", () => {
    expect(analyzeApiCsp("default-src 'none'; frame-ancestors 'none'").problems).toEqual([]);
    expect(analyzeApiCsp("default-src 'self'").problems).toHaveLength(2);
  });
});

describe("checkHeaders", () => {
  it("documento conforme passa; cada cabeçalho que falta ou diverge é apontado", () => {
    expect(checkHeaders("document", res(GOOD_DOC))).toEqual([]);
    for (const drop of ["x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy", "strict-transport-security", "content-security-policy"]) {
      const h = { ...GOOD_DOC } as Record<string, string>; delete h[drop];
      expect(checkHeaders("document", res(h)).length, drop).toBeGreaterThan(0);
    }
    expect(checkHeaders("document", res({ ...GOOD_DOC, "strict-transport-security": "max-age=10" })).join()).toMatch(/strict-transport-security/);
  });
  it("Report-Only sozinho NÃO conta como política que bloqueia", () => {
    const h = { ...GOOD_DOC } as Record<string, string>; const csp = h["content-security-policy"]; delete h["content-security-policy"]; h["content-security-policy-report-only"] = csp;
    expect(checkHeaders("document", res(h)).join()).toMatch(/Report-Only/);
  });
  it("cabeçalho DUPLICADO (ex.: CSP do Express + do nginx na mesma resposta) é acusado", () => {
    const r = { status: 200, headers: GOOD_DOC, rawHeaders: [...raw(GOOD_DOC), "Content-Security-Policy", "default-src 'none'"] };
    expect(checkHeaders("document", r).join()).toMatch(/content-security-policy DUPLICADO/i);
    expect(headerCount(r.rawHeaders, "content-security-policy")).toBe(2);
  });
  it("asset: 200 exige cache imutável; erro não pode ser imutável; ambos exigem nosniff e HSTS", () => {
    const ok = { "x-content-type-options": "nosniff", "strict-transport-security": "max-age=15552000", "cache-control": "public, max-age=31536000, immutable" };
    expect(checkHeaders("asset", res(ok))).toEqual([]);
    expect(checkHeaders("asset", res({ ...ok }, 404)).join()).toMatch(/imutável/);
    const { "cache-control": _c, ...no } = ok; void _c;
    expect(checkHeaders("asset", res(no, 404))).toEqual([]);
    expect(checkHeaders("asset", res({ "cache-control": ok["cache-control"] })).join()).toMatch(/nosniff|x-content-type-options/i);
  });
  it("api: CSP none + nosniff + X-Frame-Options + HSTS; tipo desconhecido lança", () => {
    const api = { "content-security-policy": "default-src 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "strict-transport-security": "max-age=15552000" };
    expect(checkHeaders("api", res(api))).toEqual([]);
    expect(() => checkHeaders("xx", res(api))).toThrow();
  });
});

describe("adaptProductionConf", () => {
  const conf = readFileSync("deploy/nginx.conf", "utf8");
  it("troca só domínio, certificado e porta da API, e conserva CSP, HSTS e locations", () => {
    const out = adaptProductionConf(conf, { apiPort: 4321 });
    expect(out).toContain("server_name localhost;");
    expect(out).toContain("ssl_certificate     /certs/c.pem;");
    expect(out).toContain("proxy_pass http://host.docker.internal:4321/_api/;");
    expect(out).not.toContain("exemplo.org.br;");
    for (const keep of ["Strict-Transport-Security", "Content-Security-Policy", "location /assets/", "map $status $levora_assets_cache"]) expect(out).toContain(keep);
  });
  it("se a configuração mudar e a troca não se aplicar, FALHA em vez de testar outra coisa", () => {
    expect(() => adaptProductionConf(conf.replace("server_name app.exemplo.org.br;", "server_name outro.org;"), { apiPort: 1 })).toThrow(/mudou/);
    expect(() => adaptProductionConf(conf.replace("proxy_pass http://127.0.0.1:3001/_api/;", "proxy_pass http://x/;"), { apiPort: 1 })).toThrow(/mudou/);
    expect(() => adaptProductionConf(conf.replace("root /opt/levora-solidaria/dist;", "root /x;"), { apiPort: 1 })).toThrow(/root/);
  });
});

describe("referência de CSP e injeção", () => {
  it("lê DOCUMENT_CSP de src/helpers/securityHeaders.ts (a cópia do nginx é conferida contra ela)", () => {
    const ref = readReferenceCsp(process.cwd());
    expect(ref.withFrameAncestors).toBe(DOCUMENT_CSP_WITH_FRAME_ANCESTORS);
  });
  it("a injeção de teste cobre script inline, handler inline, script externo, new Function, conexão externa e troca de <base>", () => {
    const js = INJECTION_JS("http://127.0.0.1:9");
    for (const needle of ["inline-script", "inline-handler", "/fx/ext.js", "new Function", "CSP@connect", "createElement('base')"]) expect(js).toContain(needle);
  });
});

describe("casos de upload", () => {
  const cases = uploadCases("http://127.0.0.1:9") as Array<{ id: string; expect: string; bytes?: Buffer; contentType: string; rawBase64?: string }>;
  it("cobre tipos válidos, conteúdo ativo declarado como imagem/PDF, tipos proibidos, base64 inválido e nomes hostis", () => {
    const ids = cases.map((c) => c.id);
    for (const id of ["png-valido", "jpeg-valido", "webp-valido", "pdf-valido", "svg-ativo-declarado-png", "html-ativo-declarado-pdf", "tipo-svg", "tipo-html", "base64-invalido", "nome-traversal", "nome-unicode", "nome-com-html"]) expect(ids, id).toContain(id);
    expect(cases.filter((c) => c.expect === "rejected").length).toBeGreaterThanOrEqual(7);
  });
  it("o conteúdo ativo de teste só pede uma imagem ao coletor local informado", () => {
    for (const c of cases.filter((x) => x.id.includes("ativo") || x.id.startsWith("tipo-"))) {
      const text = c.bytes!.toString("utf8");
      expect(text).toContain("http://127.0.0.1:9/h?id=");
      expect(text).not.toMatch(/document\.cookie|localStorage|XMLHttpRequest|fetch\(/);
    }
  });
});

describe("recuperação de contêineres órfãos", () => {
  it("planRecovery inclui só contêineres com o nome da rotina; recoverOrphans os remove e limpa o registro", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qa-orph-test-")); const file = path.join(dir, "active.json");
    try {
      writeFileSync(file, JSON.stringify({ orchestrator: 99999991, children: [], profiles: [], containers: ["levora-qa-nginx-1-abc", "postgres-de-outra-coisa", "levora-qa-nginx-2-x; rm -rf"], database: null }));
      const removed: string[] = [];
      const plan = planRecovery(JSON.parse(readFileSync(file, "utf8")), { alive: () => false, cmdline: () => "" });
      expect(plan.containers).toEqual(["levora-qa-nginx-1-abc"]);
      const out = await recoverOrphans({ file, alive: () => false, cmdline: () => "", actions: { killTree: async () => {}, removeDir: async () => {}, dropDb: async () => {}, removeContainer: async (n: string) => { removed.push(n); } } });
      expect(removed).toEqual(["levora-qa-nginx-1-abc"]);
      expect(out.containers).toEqual(["levora-qa-nginx-1-abc"]);
      expect(() => readFileSync(file)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("RunState registra e remove contêineres sem guardar segredos", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qa-orph-test-")); const file = path.join(dir, "active.json");
    try {
      const s = new RunState(file); s.begin(); s.addContainer("levora-qa-nginx-9-z");
      expect(JSON.parse(readFileSync(file, "utf8")).containers).toEqual(["levora-qa-nginx-9-z"]);
      s.dropContainer("levora-qa-nginx-9-z");
      expect(JSON.parse(readFileSync(file, "utf8")).containers).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
