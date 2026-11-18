/**
 * G7 — gate do `npm audit` com exceção NOMINAL (scripts/audit-gate.mjs). Relatórios sintéticos no formato real do npm 10 (auditReportVersion 2).
 * Princípio: um único alerta fora da exceção, qualquer dado ausente/inválido ou a exceção vencida = REPROVA.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error módulo .mjs sem tipos
import { evaluateAudit, main } from "../scripts/audit-gate.mjs";

const EXC = JSON.parse(readFileSync("scripts/audit-exceptions.json", "utf8"));
const ADV = { source: 1247710, name: "picomatch", dependency: "picomatch", title: "ReDoS", url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf", severity: "high", cwe: [], cvss: { score: 0 }, range: "<=4.0.7" };
const lock = (extra: Record<string, unknown> = {}) => ({ packages: { "": {}, "node_modules/picomatch": { version: "4.0.7", dev: true }, "node_modules/fdir": { version: "6.5.0", dev: true }, "node_modules/vite": { version: "6.4.5", dev: true }, "node_modules/express": { version: "5.0.0" }, ...extra } });
const v = (name: string, via: unknown[], nodes: string[], severity = "high") => ({ name, severity, isDirect: false, via, effects: [], range: "*", nodes, fixAvailable: false });
const rep = (vulns: Record<string, unknown>) => ({ auditReportVersion: 2, vulnerabilities: vulns, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: Object.keys(vulns).length, critical: 0, total: Object.keys(vulns).length } } });
const base = () => rep({ picomatch: v("picomatch", [ADV], ["node_modules/picomatch"]), fdir: v("fdir", ["picomatch"], ["node_modules/fdir"]), vite: v("vite", ["fdir", "picomatch"], ["node_modules/vite"]) });
const NOW = new Date("2026-11-20T12:00:00Z");
const run = (report: unknown, over: Record<string, unknown> = {}) => evaluateAudit({ report, lock: lock(), exceptions: EXC, now: NOW, ...over });

describe("G7 — gate do audit com exceção nominal do picomatch (GHSA-fc5q-39xc-vjpf)", () => {
  it("o arquivo de exceções é nominal, em escopo dev, com dono, prazo ≤ 30 dias e condição de encerramento", () => {
    expect(EXC.exceptions).toHaveLength(1); const e = EXC.exceptions[0];
    expect(e).toMatchObject({ advisory: "GHSA-fc5q-39xc-vjpf", source: 1247710, package: "picomatch", scope: "dev", affectedRange: "<=4.0.7", installedVersions: ["4.0.7"] });
    expect(e.owner).toMatch(/jlsheik/); expect(e.closeWhen).toMatch(/REMOVER/); expect(e.justification.length).toBeGreaterThan(200);
    expect((Date.parse(e.expires) - Date.parse(e.decidedAt)) / 86400000).toBeLessThanOrEqual(30);
  });

  it("nenhuma vulnerabilidade → aprova, com aviso de que a exceção deixou de ser usada (remover)", () => {
    const r = run(rep({})); expect(r.ok).toBe(true); expect(r.excepcionados).toEqual([]); expect(r.avisos.join()).toContain("REMOVER");
  });

  it("somente o advisory permitido, na cadeia e em dev → aprova E lista cada pacote excepcionalizado (nunca esconde)", () => {
    const r = run(base()); expect(r.ok).toBe(true);
    expect(r.excepcionados).toEqual(["picomatch (high) ← GHSA-fc5q-39xc-vjpf", "fdir (high) ← GHSA-fc5q-39xc-vjpf", "vite (high) ← GHSA-fc5q-39xc-vjpf"]);
    const out = main(["--input", (() => { const d = mkdtempSync(path.join(tmpdir(), "ag-")); const f = path.join(d, "r.json"); writeFileSync(f, JSON.stringify(base())); return f; })()], { now: NOW });
    expect(out.ok).toBe(true); expect(out.saida).toContain("EXCEPCIONALIZADAS"); expect(out.saida).toContain("NÃO foram escondidas"); expect(out.saida).toContain("2026-12-17");
  });

  it("advisory permitido + QUALQUER outra vulnerabilidade moderate+ → reprova (nova, na mesma cadeia ou em outro pacote)", () => {
    const outro = { ...ADV, source: 999, url: "https://github.com/advisories/GHSA-xxxx-yyyy-zzzz", name: "picomatch" };
    const naCadeia = base(); (naCadeia.vulnerabilities as any).vite = v("vite", [outro], ["node_modules/vite"]);
    const rc = run(naCadeia); expect(rc.ok).toBe(false); expect(rc.falhas.join()).toContain("OUTRO advisory na cadeia");
    const fora = base(); (fora.vulnerabilities as any).lodash = v("lodash", [{ ...ADV, source: 5, name: "lodash", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }], ["node_modules/lodash"], "moderate"); fora.metadata.vulnerabilities.total = 4;
    const rf = run(fora, { lock: lock({ "node_modules/lodash": { version: "4.0.0", dev: true } }) }); expect(rf.ok).toBe(false); expect(rf.falhas.join()).toMatch(/lodash.*fora da cadeia/);
    const baixa = base(); (baixa.vulnerabilities as any).x = v("x", [], [], "low"); baixa.metadata.vulnerabilities.total = 4; expect(run(baixa, { lock: lock() }).ok).toBe(true); // low/info não reprovam (política moderate+)
  });

  it("vulnerabilidade crítica em produção → reprova", () => {
    const r = rep({ express: v("express", [{ ...ADV, source: 7, name: "express", url: "https://github.com/advisories/GHSA-crit-crit-crit", severity: "critical" }], ["node_modules/express"], "critical") });
    const out = run(r); expect(out.ok).toBe(false); expect(out.falhas.join()).toContain("express (critical)");
  });

  it("o MESMO advisory no runtime (nó sem dev:true no lockfile, ou pacote em dependências opcionais/peer) → reprova", () => {
    const r1 = run(base(), { lock: lock({ "node_modules/picomatch": { version: "4.0.7" } }) }); expect(r1.ok).toBe(false); expect(r1.falhas.join()).toContain("NÃO é exclusivamente de desenvolvimento");
    const r2 = run(base(), { lock: lock({ "node_modules/picomatch": { version: "4.0.7", dev: true, optional: true } }) }); expect(r2.ok).toBe(false);
  });

  it("exceção vencida → reprova (um dia depois do prazo); no último dia ainda vale", () => {
    expect(run(base(), { now: new Date("2026-12-18T00:00:01Z") }).falhas.join()).toContain("VENCIDA");
    expect(run(base(), { now: new Date("2026-12-17T23:00:00Z") }).ok).toBe(true);
  });

  it("exceção malformada (sem dono, escopo prod, prazo > 30 dias, faixa fora do formato, duas exceções) → reprova", () => {
    const e = EXC.exceptions[0];
    for (const mut of [{ owner: "" }, { scope: "prod" }, { expires: "2027-03-01" }, { affectedRange: "*" }, { installedVersions: ["4.x"] }, { chain: [] }]) {
      const r = run(base(), { exceptions: { exceptions: [{ ...e, ...mut }] } }); expect(r.ok, JSON.stringify(mut)).toBe(false);
    }
    expect(run(base(), { exceptions: { exceptions: [e, { ...e, advisory: "GHSA-outro" }] } }).ok).toBe(false);
    expect(run(base(), { exceptions: null }).ok).toBe(false); expect(run(base(), { exceptions: { exceptions: [] } }).ok).toBe(false);
  });

  it("pacote ou versão fora do escopo permitido → reprova (picomatch 4.0.8 não é coberto; nó desconhecido do lockfile também não)", () => {
    expect(run(base(), { lock: lock({ "node_modules/picomatch": { version: "4.0.8", dev: true } }) }).falhas.join()).toContain("fora das versões autorizadas");
    const r = base(); (r.vulnerabilities as any).fdir.nodes = ["node_modules/nao-existe"]; expect(run(r).falhas.join()).toContain("ausente do package-lock.json");
    expect(run(base(), { lock: null }).ok).toBe(false);
  });

  it("relatório inválido, ausente ou incompleto → reprova", () => {
    for (const r of [null, undefined, [], "texto", {}, { auditReportVersion: 2 }, { auditReportVersion: 2, vulnerabilities: {} }, { vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }]) expect(run(r as any).ok, JSON.stringify(r)).toBe(false);
    const inconsistente = base(); inconsistente.metadata.vulnerabilities.total = 1; expect(run(inconsistente).falhas.join()).toContain("inconsistente");
  });

  it("falha de comunicação da auditoria (objeto de erro do npm, saída vazia, arquivo inexistente ou JSON quebrado) → reprova, nunca 'sem alertas'", () => {
    const e = run({ error: { code: "ENOTFOUND", summary: "audit endpoint unreachable" } }); expect(e.ok).toBe(false); expect(e.falhas.join()).toContain("não pôde ser feita");
    const d = mkdtempSync(path.join(tmpdir(), "ag-")); const vazio = path.join(d, "vazio.json"); writeFileSync(vazio, ""); const quebrado = path.join(d, "q.json"); writeFileSync(quebrado, "{nao-json");
    for (const f of [vazio, quebrado, path.join(d, "nao-existe.json")]) { const r = main(["--input", f], { now: NOW }); expect(r.ok, f).toBe(false); expect(r.saida).toContain("REPROVADO"); }
  });

  it("severidade desconhecida conta como relevante (fail-closed) e `high` é a única severidade analisada na exceção", () => {
    const r = base(); (r.vulnerabilities as any).fdir = v("fdir", ["picomatch"], ["node_modules/fdir"], "critical"); expect(run(r).ok).toBe(false);
    const u = base(); (u.vulnerabilities as any).fdir = v("fdir", ["picomatch"], ["node_modules/fdir"], "???"); expect(run(u).ok).toBe(false);
  });

  it("o workflow roda os DOIS gates: produção (`--omit=dev`) e completo com exceção; nenhum `npm audit` foi trocado nem silenciado", () => {
    const wf = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(wf).toContain("npm audit --omit=dev --audit-level=moderate"); expect(wf).toContain("node scripts/audit-gate.mjs");
    expect(wf).not.toMatch(/npm audit[^\n]*(\|\|\s*true|continue-on-error)/); expect(wf).not.toMatch(/continue-on-error/); expect(wf).not.toMatch(/audit fix/);
  });
});
