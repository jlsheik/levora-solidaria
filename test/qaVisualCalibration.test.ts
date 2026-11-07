/**
 * M12 — calibração e proteção do gate visual contra aprovação falsa (sem navegador, sem banco).
 * (1) `visual-calibration.mjs` (gerado da bateria pré-registrada) recusa aprovar célula de grupo em NEEDS_INVESTIGATION e deixa passar CALIBRATED/NOT_VALIDATED;
 * (2) `visual.mjs approve` chama a verificação ANTES de aprovar; (3) o gate de produção está DESABILITADO e nenhum workflow/CI usa o modo visual;
 * (4) nada no repositório é uma baseline aprovada; (5) candidatas jamais produzem homologação (exit 0) nem `homologado`.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = process.env.QA_VISUAL_ROOT ?? path.resolve(__dirname, "../scripts/qa-visual");
const REPO = path.resolve(__dirname, ".."); // raiz do repositório REAL (os mutantes copiam só scripts/qa-visual para uma pasta temporária: o teste não pode depender de ROOT/../..)
const load = (rel: string) => import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href);
const cal = await load("visual-calibration.mjs");
const vr = await load("lib/visualrun.mjs");

describe("visual-calibration.mjs", () => {
  const groups = Object.entries(cal.CALIBRATION.groups) as [string, { status: string; foraDasRegioes: number }][];
  it("gate de produção DESABILITADO, com motivo, e a tabela cobre grupos de páginas oficiais e da dropzone", () => {
    expect(cal.CALIBRATION.productionGate).toBe("DISABLED"); expect(String(cal.CALIBRATION.reason).length).toBeGreaterThan(20);
    expect(groups.length).toBeGreaterThanOrEqual(40); expect(groups.some(([k]) => k.startsWith("dropzone-"))).toBe(true); expect(groups.some(([k]) => !k.startsWith("dropzone-"))).toBe(true);
  });
  it("coerência: NEEDS_INVESTIGATION ⇔ pelo menos um par fora das regiões; CALIBRATED ⇔ nenhum", () => {
    for (const [, v] of groups) expect(v.status === "CALIBRATED").toBe(v.foraDasRegioes === 0);
  });
  it("célula de grupo em NEEDS_INVESTIGATION NÃO pode ser aprovada (código UNCALIBRATED_CELL); as demais passam", () => {
    const bad = groups.filter(([, v]) => v.status === "NEEDS_INVESTIGATION"); expect(bad.length).toBeGreaterThan(0);
    for (const [g] of bad) { const [page, vp] = g.split("|"); expect(() => cal.assertApprovable(`${page}__chrome__${vp}__light`)).toThrowError(/NEEDS_INVESTIGATION/);
      try { cal.assertApprovable(`${page}__edge__${vp}__dark`); } catch (e) { expect((e as { code: string }).code).toBe("UNCALIBRATED_CELL"); } }
    const ok = groups.find(([, v]) => v.status === "CALIBRATED")!; const [page, vp] = ok[0].split("|"); expect(cal.assertApprovable(`${page}__chrome__${vp}__light`).status).toBe("CALIBRATED");
    expect(cal.assertApprovable("pagina-que-nao-entrou-na-bateria__chrome__1280x900__light").status).toBe("NOT_VALIDATED");
  });
  it("groupOf entende o id da célula e ignora ids malformados", () => { expect(cal.groupOf("dropzone-enviando__chrome__375x812__dark")).toBe("dropzone-enviando|375x812"); expect(cal.groupOf("sem-separador")).toBeNull(); });
});

describe("proteção contra aprovação falsa", () => {
  it("`visual.mjs approve` verifica a calibração ANTES de chamar approveBaseline e continua exigindo --yes e --reviewer", () => {
    const src = readFileSync(path.join(ROOT, "visual.mjs"), "utf8"); const a = src.indexOf("assertApprovable(o.id)"), b = src.indexOf("approveBaseline(path.resolve");
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a); expect(src).toContain("approve exige --yes");
    const bl = readFileSync(path.join(ROOT, "lib/baseline.mjs"), "utf8"); expect(bl).toContain("NO_REVIEWER");
  });
  it("nenhum workflow do GitHub usa o modo visual (--visual, approve, compare); o CI roda o perfil funcional", () => {
    const dir = path.join(REPO, ".github/workflows"); if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) { const t = readFileSync(path.join(dir, f), "utf8"); expect(t, f).not.toMatch(/--visual\s+(capture|compare)\b|--visual-(only|dir|out|matrix)\b|visual\.mjs\s+(approve|compare|capture)|--reviewer/); }
  });
  it("nenhum manifesto de baselines (aprovadas ou não) está versionado no repositório", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = path.join(d, n); if (n === "node_modules" || n === ".git" || n === "dist" || n === "dist-server") return []; return statSync(p).isDirectory() ? walk(p) : [p]; });
    const hits = [...walk(ROOT), ...walk(path.join(REPO, "test"))].filter((p) => /baselines?[\/]manifest\.json$|(^|[\/])manifest\.json$/.test(p));
    expect(hits).toEqual([]);
  });
  it("candidata sozinha nunca homologa: exit 6, `homologado` falso, para qualquer mistura sem aprovada", () => {
    const C = (s: string) => ({ status: s });
    for (const mix of [["CANDIDATE_ONLY"], ["CANDIDATE_CREATED"], ["MISSING_BASELINE"], ["STALE_BASELINE", "CANDIDATE_ONLY"], ["VISUAL_PASS", "CANDIDATE_ONLY"]]) expect(vr.visualExitCode(mix.map(C))).toBe(6);
    expect(vr.visualExitCode([C("VISUAL_PASS")])).toBe(0); expect(vr.visualExitCode([C("VISUAL_REGRESSION"), C("CANDIDATE_ONLY")])).toBe(1);
  });
});
