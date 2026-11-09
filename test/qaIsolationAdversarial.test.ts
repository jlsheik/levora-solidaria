/**
 * M23 — testes ADVERSARIAIS de isolamento entre execuções do QA (diretórios temporários e banco), com diretórios/arquivos de estado SINTÉTICOS (nada real é tocado).
 * Cenários: execução viva de outro processo; execução morta; diretório sem marcador; marcador de outra execução; diretório fora do temporário; diretório inexistente;
 * nome fora do padrão; execução interrompida (estado remanescente); banco de outra execução (só a decisão de nome/marcador, sem PostgreSQL).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.env.QA_VISUAL_ROOT ?? path.resolve(__dirname, "../scripts/qa-visual");
const orph = await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, "lib/orphans.mjs")).href);
const made: string[] = []; const mk = (prefix: string, base = tmpdir()) => { const d = mkdtempSync(path.join(base, prefix)); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
const state = (dir: string, runId: string, over: Record<string, unknown>) => writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify({ runId, orchestrator: { pid: 99999999, start: null, exe: null }, children: [], profiles: [], containers: [], database: null, startedAt: new Date().toISOString(), ...over }));
const mkdirOwned = (prefix: string, runId: string | null) => { const d = mk(prefix); if (runId !== null) writeFileSync(path.join(d, ".levora-qa-owner"), runId); return d; };
const actions = () => { const removed: string[] = []; const dropped: string[] = []; return { removed, dropped, a: { removeDir: async (d: string) => { removed.push(d); rmSync(d, { recursive: true, force: true }); }, dropDb: async (n: string) => { dropped.push(n); } } }; };
const run = (dir: string, act: ReturnType<typeof actions>, over: Record<string, unknown> = {}) => orph.recoverOrphans({ dir, ownRunId: "ATUAL", list: () => [], alive: () => false, actions: act.a, ...over });

describe("isolamento entre execuções do QA (sintético)", () => {
  it("execução VIVA de outro processo: nada é tocado (diretório, banco), a recuperação devolve busy", async () => {
    const sd = mk("lvm-state-"); const other = mkdirOwned("levora-qa-profile-files-", "OUTRA"); state(sd, "OUTRA", { orchestrator: { pid: process.pid, start: null, exe: null }, profiles: [other], database: "levora_outra_qa" });
    const act = actions(); const r = await run(sd, act, { alive: () => true }); expect(r.busy).toBe(true); expect(act.removed).toEqual([]); expect(act.dropped).toEqual([]); expect(existsSync(other)).toBe(true);
  });
  it("execução MORTA: remove só o diretório com o marcador DELA e derruba só o banco registrado por ela", async () => {
    const sd = mk("lvm-state-"); const mine = mkdirOwned("levora-qa-profile-files-", "MORTA"); state(sd, "MORTA", { profiles: [mine], database: "levora_morta_qa" });
    const act = actions(); await run(sd, act); expect(act.removed).toEqual([mine]); expect(act.dropped).toEqual(["levora_morta_qa"]); expect(existsSync(mine)).toBe(false);
  });
  it("diretório SEM marcador, com marcador de OUTRA execução, fora do temporário, com nome fora do padrão ou inexistente: preservados", async () => {
    const sd = mk("lvm-state-"); const semMarca = mkdirOwned("levora-qa-profile-files-", null); const marcaOutra = mkdirOwned("levora-qa-profile-files-", "VIVA-DE-OUTRA");
    const foraPadrao = mkdirOwned("meu-projeto-", "MORTA"); const foraTmp = mkdtempSync(path.join(sd, "levora-qa-profile-")); writeFileSync(path.join(foraTmp, ".levora-qa-owner"), "MORTA"); made.push(foraTmp);
    state(sd, "MORTA", { profiles: [semMarca, marcaOutra, foraPadrao, foraTmp, path.join(tmpdir(), "levora-qa-profile-inexistente-xyz")] });
    const act = actions(); const r = await run(sd, act); expect(act.removed).toEqual([]); for (const d of [semMarca, marcaOutra, foraPadrao, foraTmp]) expect(existsSync(d)).toBe(true);
    expect(r.profilesPreserved.length).toBeGreaterThanOrEqual(4);
  });
  it("execução interrompida: o estado remanescente é consumido UMA vez (a 2ª recuperação não encontra nada e não repete a limpeza)", async () => {
    const sd = mk("lvm-state-"); const mine = mkdirOwned("levora-qa-profile-files-", "INT"); state(sd, "INT", { profiles: [mine], database: "levora_int_qa" });
    const a1 = actions(); await run(sd, a1); const a2 = actions(); await run(sd, a2); expect(a1.dropped).toEqual(["levora_int_qa"]); expect(a2.removed).toEqual([]); expect(a2.dropped).toEqual([]);
  });
  it("a própria execução (ownRunId) nunca é processada pela recuperação", async () => {
    const sd = mk("lvm-state-"); const mine = mkdirOwned("levora-qa-profile-files-", "ATUAL"); state(sd, "ATUAL", { profiles: [mine], database: "levora_atual_qa" });
    const act = actions(); await run(sd, act); expect(act.removed).toEqual([]); expect(act.dropped).toEqual([]); expect(existsSync(mine)).toBe(true);
  });
  it("duas execuções com estados distintos: a morta é limpa, a viva é preservada e a recuperação para (busy) sem tocar em NADA do restante", async () => {
    const sd = mk("lvm-state-"); const d1 = mkdirOwned("levora-qa-profile-files-", "MORTA"); const d2 = mkdirOwned("levora-qa-profile-files-", "VIVA");
    state(sd, "MORTA", { profiles: [d1] }); state(sd, "VIVA", { orchestrator: { pid: 4242, start: null, exe: null }, profiles: [d2], database: "levora_viva_qa" });
    const act = actions(); const r = await run(sd, act, { alive: (pid: number) => pid === 4242 }); expect(r.busy).toBe(true); expect(existsSync(d2)).toBe(true); expect(act.dropped).not.toContain("levora_viva_qa");
  });
});

describe("M24 — a recuperação passa o runId da execução MORTA ao descarte do banco", () => {
  it("dropDb recebe (nome, runId da morta): a limpeza só vale para o banco marcado com esse runId", async () => {
    const sd = mk("lvm-state-"); state(sd, "MORTA-7", { database: "levora_morta7_qa" }); const seen: unknown[][] = [];
    await orph.recoverOrphans({ dir: sd, ownRunId: "ATUAL", list: () => [], alive: () => false, actions: { removeDir: async () => {}, dropDb: async (...a: unknown[]) => { seen.push(a); } } });
    expect(seen).toEqual([["levora_morta7_qa", "MORTA-7"]]);
  });
});
