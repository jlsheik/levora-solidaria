/**
 * M19 — testes das correções da M18 no PR A: âncora de aprovação, caminhos do manifesto, versão desconhecida, diretórios de candidatas e propriedade do banco de QA.
 * Sem navegador e sem banco (funções puras / disco temporário).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.env.QA_VISUAL_ROOT ?? path.resolve(__dirname, "../scripts/qa-visual");
const load = (rel: string) => import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href);
const bl = await load("lib/baseline.mjs"); const png = await load("lib/png.mjs"); const ap = await load("lib/approvals.mjs"); const vd = await load("lib/visualdirs.mjs"); const gd = await load("lib/guard.mjs"); const vr = await load("lib/visualrun.mjs");

const mkImg = (w = 40, h = 30) => { const d = new Uint8ClampedArray(w * h * 4).fill(255); return { width: w, height: h, data: d }; };
const META = { pageId: "painel", browser: "chrome", browserVersion: "Chrome/157.0.8103.39", viewport: "1280x900", theme: "light", sourceSha: "a".repeat(40), captureConfigVersion: "cc-1", route: "/painel" };
const KEY = { pageId: "painel", browser: "chrome", viewport: "1280x900", theme: "light" }; const CTX = { captureConfigVersion: "cc-1", version: "Chrome/157.0.8103.39" };
const FP = { count: 0, elements: [], doc: { w: 1, h: 1 } };

let tmp = ""; let ledgerDir = ""; let ledger = ""; const OLD = process.env.QA_APPROVAL_LEDGER;
beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "levora-qa-anchor-")); ledgerDir = mkdtempSync(path.join(tmpdir(), "levora-qa-anchor-ledger-")); ledger = path.join(ledgerDir, "approvals.jsonl"); process.env.QA_APPROVAL_LEDGER = ledger; });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); rmSync(ledgerDir, { recursive: true, force: true }); if (OLD === undefined) delete process.env.QA_APPROVAL_LEDGER; else process.env.QA_APPROVAL_LEDGER = OLD; });
const cand = (meta = META) => bl.addCandidate(tmp, meta, png.encodePng(mkImg()), FP).entry;
const approve = (meta = META) => { const e = cand(meta); return bl.approveBaseline(tmp, { id: e.id, imageSha256: e.imageSha256, reviewer: "Revisor sintético do teste" }); };

describe("A1 — âncora de aprovação (o manifesto sozinho não prova a aprovação)", () => {
  it("aprovação normal com âncora → APPROVED", () => { approve(); expect(bl.resolveBaseline(tmp, KEY, CTX).status).toBe("APPROVED"); });
  it("aprovar SEM âncora configurada é recusado (NO_ANCHOR)", () => { delete process.env.QA_APPROVAL_LEDGER; const e = cand(); expect(() => bl.approveBaseline(tmp, { id: e.id, imageSha256: e.imageSha256, reviewer: "Revisor sintético do teste" })).toThrow(/âncora/); });
  it("manifesto editado à mão para APPROVED (sem registro) → APPROVAL_UNVERIFIED, nunca APPROVED, exit 6", () => {
    const e = cand(); const mf = path.join(tmp, "manifest.json"); const m = JSON.parse(readFileSync(mf, "utf8"));
    const x = m.entries.find((q: { id: string }) => q.id === e.id); x.state = "APPROVED"; x.approvedBy = "Revisor falso"; x.approvedAt = "2026-01-01T00:00:00.000Z"; writeFileSync(mf, JSON.stringify(m));
    const r = bl.resolveBaseline(tmp, KEY, CTX); expect(r.status).toBe("APPROVAL_UNVERIFIED"); expect(vr.visualExitCode([{ status: r.status === "APPROVAL_UNVERIFIED" ? "APPROVAL_UNVERIFIED" : "PASS" }])).toBe(6);
  });
  it("sem âncora configurada na leitura: aprovação existente fica APPROVAL_UNVERIFIED", () => { approve(); delete process.env.QA_APPROVAL_LEDGER; expect(bl.resolveBaseline(tmp, KEY, CTX).status).toBe("APPROVAL_UNVERIFIED"); });
  it("registro adulterado (linha editada) invalida a cadeia → APPROVAL_UNVERIFIED", () => {
    approve(); const raw = readFileSync(ledger, "utf8"); writeFileSync(ledger, raw.replace("Revisor sintético do teste", "Outro revisor"));
    expect(ap.readLedger(ledger).ok).toBe(false); expect(bl.resolveBaseline(tmp, KEY, CTX).status).toBe("APPROVAL_UNVERIFIED");
  });
  it("registro apagado → APPROVAL_UNVERIFIED", () => { approve(); rmSync(ledger); expect(bl.resolveBaseline(tmp, KEY, CTX).status).toBe("APPROVAL_UNVERIFIED"); });
  it("imagem trocada e SHA do manifesto reescrito para casar → sem registro para o novo SHA → APPROVAL_UNVERIFIED", () => {
    const e = approve(); const mf = path.join(tmp, "manifest.json"); const m = JSON.parse(readFileSync(mf, "utf8")); const x = m.entries.find((q: { id: string }) => q.id === e.id);
    const img = mkImg(); img.data[0] = 0; const buf = png.encodePng(img); writeFileSync(path.join(tmp, x.file), buf); x.imageSha256 = bl.sha256 ? bl.sha256(buf) : x.imageSha256; writeFileSync(mf, JSON.stringify(m));
    expect(["APPROVAL_UNVERIFIED", "CORRUPT"]).toContain(bl.resolveBaseline(tmp, KEY, CTX).status);
  });
  it("o registro dentro da pasta de baselines ou do repositório é recusado (não independente)", () => {
    const inBaselines = path.join(tmp, "ledger.jsonl"); expect(() => ap.assertLedgerIndependent(inBaselines, { baselineDir: tmp, repoRoot: path.resolve(ROOT, "..", "..") })).toThrow(/baselines/);
    expect(() => ap.assertLedgerIndependent(path.join(ROOT, "x.jsonl"), { baselineDir: tmp, repoRoot: path.resolve(ROOT, "..", "..") })).toThrow(/repositório/);
    expect(() => ap.assertLedgerIndependent(ledger, { baselineDir: tmp, repoRoot: path.resolve(ROOT, "..", "..") })).not.toThrow();
  });
  it("a autenticidade é declarada como local e NÃO criptográfica", () => { expect(ap.AUTHENTICITY).toBe("LOCAL_LEDGER_NOT_CRYPTOGRAPHIC"); approve(); const v = ap.verifyApproval(ledger, { id: bl.resolveBaseline(tmp, KEY, CTX).entry.id, imageSha256: bl.resolveBaseline(tmp, KEY, CTX).entry.imageSha256, captureConfigVersion: "cc-1" }); expect(v.authenticity).toBe("LOCAL_LEDGER_NOT_CRYPTOGRAPHIC"); });
});

describe("A3 — caminhos do manifesto ficam dentro da pasta de baselines", () => {
  it("safeJoin aceita relativo interno", () => { expect(bl.safeJoin(tmp, "files/a.png")).toBe(path.resolve(tmp, "files/a.png")); });
  it.each(["../fora.png", "..\\fora.png", "a/../../fora.png", path.resolve(tmpdir(), "abs.png"), "", "x\0y.png"])("safeJoin recusa %j", (rel) => { expect(() => bl.safeJoin(tmp, rel as string)).toThrow(); });
  it("manifesto com `file` fora da pasta → CORRUPT (não lê o arquivo externo)", () => {
    approve(); const mf = path.join(tmp, "manifest.json"); const m = JSON.parse(readFileSync(mf, "utf8")); const x = m.entries.find((q: { state: string }) => q.state === "APPROVED");
    x.file = "../../fora.png"; writeFileSync(mf, JSON.stringify(m)); expect(bl.resolveBaseline(tmp, KEY, CTX).status).toBe("CORRUPT");
  });
});

describe("A5 — versão do navegador desconhecida não vira referência válida", () => {
  it("versão atual desconhecida (null) → STALE", () => { approve(); expect(bl.resolveBaseline(tmp, KEY, { ...CTX, version: null }).status).toBe("STALE"); });
  it("versão atual sem major legível → STALE", () => { approve(); expect(bl.resolveBaseline(tmp, KEY, { ...CTX, version: "desconhecida" }).status).toBe("STALE"); });
  it("major diferente continua STALE e major igual continua APPROVED", () => { approve(); expect(bl.resolveBaseline(tmp, KEY, { ...CTX, version: "Chrome/158.0.1.1" }).status).toBe("STALE"); expect(bl.resolveBaseline(tmp, KEY, { ...CTX, version: "Chrome/157.0.9999.1" }).status).toBe("APPROVED"); });
});

describe("A2 — diretório de candidatas isolado do repositório", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "levora-qa-repo-")); const home = mkdtempSync(path.join(tmpdir(), "levora-qa-home-"));
  mkdirSync(path.join(repo, "scripts", "qa-visual", "visual-references"), { recursive: true }); mkdirSync(path.join(repo, ".qa-visual-local"), { recursive: true });
  const R = (p?: string, cwd = repo) => vd.resolveCandidateDir(p, { root: repo, cwd, home });
  it("padrão: fora do repositório (em ~/.levora-qa/visual-candidates)", () => { const d = R(undefined); expect(d.startsWith(vd.realOrSelf(home))).toBe(true); expect(d).toContain(".levora-qa"); });
  it("absoluto fora do repositório é aceito (mesmo inexistente)", () => { expect(() => R(path.join(home, "novo", "sub"))).not.toThrow(); });
  it("relativo resolvido contra o cwd (cwd fora do repositório) é aceito", () => { expect(() => R("cand", home)).not.toThrow(); });
  it("relativo que cai dentro do repositório é recusado (INSIDE_REPO)", () => { expect(() => R("scripts/qa-visual/visual-baselines")).toThrow(/dentro do reposit/); });
  it("`..` que entra no repositório é recusado", () => { expect(() => R(path.join(repo, "x", "..", "y"))).toThrow(/reposit/); });
  it("área ignorada .qa-visual-local/ é permitida", () => { expect(() => R(path.join(repo, ".qa-visual-local", "c1"))).not.toThrow(); });
  it("área de referências aprovadas nunca é destino de captura (REFERENCES_AREA)", () => { expect(() => R(path.join(repo, "scripts", "qa-visual", "visual-references"))).toThrow(/refer/); });
  it("destino existente que é arquivo → NOT_A_DIRECTORY", () => { const f = path.join(home, "arquivo.txt"); writeFileSync(f, "x"); expect(() => R(f)).toThrow(/não é um diretório/); });
  it("caminho vazio ou com NUL → BAD_PATH", () => { expect(() => R("")).toThrow(); expect(() => R("a\0b")).toThrow(); });
  it("junction/symlink de fora apontando para dentro do repositório é recusado", () => {
    const link = path.join(home, "atalho"); try { symlinkSync(path.join(repo, "scripts"), link, "junction"); } catch { return; }
    expect(() => R(path.join(link, "qa-visual", "novo"))).toThrow(/reposit/);
  });
  it(".gitignore cobre a área local e o diretório antigo de baselines", () => { const g = readFileSync(path.resolve(process.cwd(), ".gitignore"), "utf8"); expect(g).toContain("/.qa-visual-local/"); expect(g).toContain("/scripts/qa-visual/visual-baselines/"); });
  it("o diretório de referências existe só como reserva (nenhuma referência versionada hoje)", () => { expect(existsSync(path.resolve(ROOT, "visual-references", "manifest.json"))).toBe(false); });
});

describe("A8 — propriedade do banco de QA (marca, além do sufixo _qa)", () => {
  const d = gd.decideDatabaseOwnership;
  it("inexistente → create", () => { expect(d({ exists: false })).toBe("create"); });
  it("com marca → reuse", () => { expect(d({ exists: true, comment: gd.QA_DB_OWNER_MARK, publicTableCount: 40 })).toBe("reuse"); });
  it("sem marca e vazio → adopt", () => { expect(d({ exists: true, comment: null, publicTableCount: 0 })).toBe("adopt"); });
  it("sem marca e com tabelas (banco de outro uso, mesmo com sufixo _qa) → refuse", () => { expect(d({ exists: true, comment: null, publicTableCount: 12 })).toBe("refuse"); expect(d({ exists: true, comment: "outro comentario", publicTableCount: 3 })).toBe("refuse"); });
});
