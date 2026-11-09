// M06 — segurança de processos do QA. Reproduz o risco (limpeza que atinge navegadores/processos EXTERNOS) com PROCESSOS SINTÉTICOS: nenhum navegador real do usuário é tocado.
// Os "externos" são processos node.exe descartáveis, alguns com o nome de imagem chrome.exe/msedge.exe (cópia do node.exe em uma pasta temporária) e com linha de comando
// idêntica à de um navegador do QA. A suíte exige que eles SOBREVIVAM e que só o que a execução criou e ainda prova ser seu seja encerrado.
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";

// QA_VISUAL_ROOT (opcional) aponta para uma CÓPIA sabotada de scripts/qa-visual — é assim que os mutantes testam esta suíte.
const ROOT = process.env.QA_VISUAL_ROOT ?? path.resolve(__dirname, "../scripts/qa-visual");
const load = (rel: string) => import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href);
const po = await load("lib/procowner.mjs"); const orp = await load("lib/orphans.mjs"); const brw = await load("lib/browser.mjs");
const { OWNER_MARKER, captureIdentity, descendantsOf, killOwned, killTree, listProcesses, parsePsTable, parseWinTable, verifyOwnership } = po;
const { RunState, canRemoveProfile, installSignalHandlers, planRecovery, readState, recoverOrphans } = orp;
const { launchBrowser } = brw;

const SLEEP = "setInterval(()=>{},1000)";
const base = mkdtempSync(path.join(tmpdir(), "qa-procsafe-"));
const decoys: ChildProcess[] = [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === "EPERM"; } };
const waitGone = async (pid: number, ms = 5000) => { const t = Date.now(); while (alive(pid) && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 100)); return !alive(pid); };
function decoy(extra: string[] = [], exe = process.execPath): ChildProcess { const c = spawn(exe, ["-e", SLEEP, "--", ...extra], { stdio: "ignore", windowsHide: true }); decoys.push(c); return c; }
const noopActions = { removeDir: async () => {}, dropDb: async () => {} };
async function rec(c: ChildProcess, extra: Record<string, unknown> = {}) { const id = await captureIdentity(c.pid!); expect(id).not.toBeNull(); return { pid: c.pid!, kind: "browser", start: id!.start, exe: id!.exe, ...extra }; }
const runDir = () => mkdtempSync(path.join(base, "runs-"));
const writeRun = (dir: string, runId: string, orchestrator: any, children: any[], profiles: string[] = [], database: string | null = null) => { writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify({ runId, orchestrator, children, profiles, containers: [], database })); };
const DEAD_ORCH = { pid: 2147480000, start: "1", exe: "" };

beforeAll(() => { mkdirSync(base, { recursive: true }); });
afterAll(async () => { for (const c of decoys) { try { c.kill("SIGKILL"); } catch { /* ok */ } } for (const c of decoys) if (c.pid) await waitGone(c.pid, 3000); try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* binários sintéticos ainda liberando: o diretório é do próprio teste e fica no tmp */ } });

describe("identidade e propriedade (funções puras)", () => {
  const T = [{ pid: 10, ppid: 1, start: "100", exe: "C:\\a\\chrome.exe", cmd: "chrome --user-data-dir=P" }, { pid: 11, ppid: 10, start: "150", exe: "x", cmd: "" }, { pid: 12, ppid: 10, start: "50", exe: "y", cmd: "" }];
  it("verifyOwnership: só confere com PID + instante de criação (+ executável, + perfil exclusivo)", () => {
    expect(verifyOwnership({ pid: 10, start: "100", exe: "c:\\A\\CHROME.exe", profile: "P" }, T).owned).toBe(true);
    expect(verifyOwnership({ pid: 10, start: "999" }, T)).toMatchObject({ owned: false, reason: expect.stringMatching(/reutilizado/) });
    expect(verifyOwnership({ pid: 10, start: "100", exe: "outro.exe" }, T).owned).toBe(false);
    expect(verifyOwnership({ pid: 10, start: "100", profile: "OUTRO" }, T).owned).toBe(false);
    expect(verifyOwnership({ pid: 10 }, T)).toMatchObject({ owned: false, reason: expect.stringMatching(/sem instante/) }); // sem identidade registrada: nunca
    expect(verifyOwnership({ pid: 10, start: "100" }, null).owned).toBe(false); // tabela indisponível: preserva
    expect(verifyOwnership({ pid: 77, start: "1" }, T)).toMatchObject({ owned: false, gone: true });
  });
  it("descendantsOf: PPID reciclado (filho mais velho que o pai) NÃO entra; folhas primeiro", () => {
    expect(descendantsOf(10, T).map((p) => p.pid)).toEqual([11]);
    const deep = [...T, { pid: 20, ppid: 11, start: "160", exe: "", cmd: "" }];
    expect(descendantsOf(10, deep).map((p) => p.pid)).toEqual([20, 11]);
  });
  it("killTree recusa PID solto e processo que já terminou", () => {
    expect(killTree(12345 as any, { list: () => [], kill: () => { throw new Error("não deveria matar"); } }).preserved[0].reason).toMatch(/PID solto/);
    expect(killTree({ pid: 5, exitCode: 0, kill: () => { throw new Error("não"); } } as any, { list: () => [], kill: () => {} }).killed).toEqual([]);
  });
  it("parsers: Windows (JSON do CIM) e ps", () => {
    expect(parseWinTable(JSON.stringify([{ ProcessId: 4, ParentProcessId: 1, ExecutablePath: "a.exe", CommandLine: "a", c: 123 }]))).toEqual([{ pid: 4, ppid: 1, start: "123", exe: "a.exe", cmd: "a" }]);
    expect(parseWinTable("lixo")).toBeNull();
    expect(parsePsTable("  42     1 Mon Nov  5 00:19:33 2026 /usr/bin/node a b")[0]).toMatchObject({ pid: 42, ppid: 1, start: "Mon Nov 5 00:19:33 2026", exe: "/usr/bin/node" });
  });
});

describe("processos sintéticos reais", () => {
  it("1) uma execução com seus próprios processos: encerra o que é dela, inclusive o descendente, e confirma que sumiram", async () => {
    const parent = spawn(process.execPath, ["-e", `const {spawn}=require("child_process");const c=spawn(process.execPath,["-e","${SLEEP}"],{stdio:"ignore"});console.log(c.pid);${SLEEP}`], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); decoys.push(parent);
    const childPid = await new Promise<number>((res) => parent.stdout!.once("data", (d) => res(Number(String(d).trim()))));
    const r = await rec(parent);
    const out = await killOwned([r]);
    expect(out.errors).toEqual([]);
    expect(out.killed).toEqual(expect.arrayContaining([parent.pid!, childPid]));
    expect(await waitGone(parent.pid!)).toBe(true); expect(await waitGone(childPid)).toBe(true);
  }, 60000);

  it("3/4/5/9) externos com NOME e LINHA DE COMANDO de navegador do QA (chrome.exe, msedge.exe, não registrados) sobrevivem à limpeza de outro processo registrado", async () => {
    const dirx = path.join(base, "fakebin"); mkdirSync(dirx, { recursive: true });
    copyFileSync(process.execPath, path.join(dirx, "chrome.exe")); copyFileSync(process.execPath, path.join(dirx, "msedge.exe"));
    const prof = path.join(base, "levora-qa-profile-shared");
    const mine = decoy([`--user-data-dir=${prof}`, "qa-visual"]);
    const lookalike = decoy(["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${prof}`, "qa-visual", "levora-qa-profile"]); // MESMA linha de comando, não registrado
    const chrome = decoy(["--remote-debugging-port=0", "levora-qa-profile-x"], path.join(dirx, "chrome.exe"));
    const edge = decoy(["--remote-debugging-port=0", "levora-qa-profile-y"], path.join(dirx, "msedge.exe"));
    const r = await rec(mine, { profile: prof });
    const out = await killOwned([r]);
    expect(out.killed).toContain(mine.pid!); for (const e of ["lookalike"]) void e;
    await waitGone(mine.pid!);
    for (const c of [lookalike, chrome, edge]) expect(alive(c.pid!)).toBe(true); // intocados
  }, 60000);

  it("6/7) filho que terminou antes da limpeza e PID inexistente: nada é encerrado, nenhum sucesso falso", async () => {
    const c = decoy(); const r = await rec(c); c.kill("SIGKILL"); await waitGone(c.pid!);
    const bystander = decoy();
    const out = await killOwned([r, { pid: 2147480001, start: "1", exe: "" }]);
    expect(out.killed).toEqual([]); expect(out.errors).toEqual([]);
    expect(out.preserved.every((p: any) => p.gone)).toBe(true);
    expect(alive(bystander.pid!)).toBe(true);
  }, 60000);

  it("8/11) PID reutilizado (instante de criação diferente) ou registro que deixou de pertencer à execução (executável/perfil diferentes): PRESERVADO", async () => {
    const victim = decoy(["--user-data-dir=/outro/perfil"]);
    const r = await rec(victim);
    const out = await killOwned([{ ...r, start: "1" }, { ...r, exe: "C:\\Outro\\app.exe" }, { ...r, profile: path.join(base, "levora-qa-profile-meu") }]);
    expect(out.killed).toEqual([]); expect(out.preserved).toHaveLength(3);
    expect(out.preserved.map((p: any) => p.reason).join("|")).toMatch(/reutilizado/); expect(out.preserved.map((p: any) => p.reason).join("|")).toMatch(/executável diferente/); expect(out.preserved.map((p: any) => p.reason).join("|")).toMatch(/perfil exclusivo/);
    expect(alive(victim.pid!)).toBe(true);
  }, 60000);

  it("10) registro sem identidade (processo iniciado e não identificado a tempo): PRESERVADO e a incerteza é devolvida", async () => {
    const c = decoy(); const out = await killOwned([{ pid: c.pid!, kind: "api", start: null, exe: null }]);
    expect(out.killed).toEqual([]); expect(out.preserved[0].reason).toMatch(/identidade não comprovada/); expect(alive(c.pid!)).toBe(true);
  }, 60000);

  it("tabela de processos indisponível: nada é encerrado (identidade incerta)", async () => {
    const c = decoy(); const r = await rec(c);
    const out = await killOwned([r], { list: () => null as any });
    expect(out.killed).toEqual([]); expect(out.preserved[0].reason).toMatch(/indisponível/); expect(alive(c.pid!)).toBe(true);
  }, 60000);

  it("15) falha durante o encerramento: o erro é registrado e NÃO se declara sucesso", async () => {
    const c = decoy(); const r = await rec(c);
    const out = await killOwned([r], { kill: () => { const e: any = new Error("negado"); e.code = "EPERM"; throw e; }, settleMs: 50 });
    expect(out.killed).toEqual([]); expect(out.errors.join(" ")).toMatch(/EPERM/); expect(out.errors.join(" ")).toMatch(/continua em execução/); expect(alive(c.pid!)).toBe(true);
  }, 60000);

  it("2/16) duas execuções: a recuperação de uma execução MORTA não toca na execução VIVA (nem em seus processos) e uma execução viva bloqueia (busy)", async () => {
    const dir = runDir();
    const aChild = decoy(); const aRec = await rec(aChild);
    const bOrch = decoy(); const bOrchId = await captureIdentity(bOrch.pid!); const bChild = decoy(); const bRec = await rec(bChild);
    writeRun(dir, "run-a", DEAD_ORCH, [aRec]);
    writeRun(dir, "run-b", { pid: bOrch.pid, start: bOrchId!.start, exe: bOrchId!.exe }, [bRec]);
    const out = await recoverOrphans({ dir, ownRunId: "run-c", actions: noopActions });
    expect(out.busy).toBe(true); expect(out.pid).toBe(bOrch.pid); // há execução viva: o chamador recusa continuar
    // a execução MORTA foi recuperada (filho verificado encerrado, registro consumido) e a VIVA ficou intacta
    expect(out.killed).toContain(aChild.pid!); expect(out.killed).not.toContain(bChild.pid!); expect(out.killed).not.toContain(bOrch.pid!);
    expect(await waitGone(aChild.pid!)).toBe(true); expect(alive(bChild.pid!)).toBe(true); expect(alive(bOrch.pid!)).toBe(true);
    expect(readState(path.join(dir, "run-a.json"))).toBeNull(); expect(existsSync(path.join(dir, "run-b.json"))).toBe(true);
  }, 90000);

  it("16) reinício com registros antigos: processo ainda nosso é encerrado; PID reaproveitado e processo externo são preservados e a incerteza fica em incertos.log", async () => {
    const dir = runDir(); const mine = decoy(); const reused = decoy(); const external = decoy(["qa-visual", "levora-qa-profile-z"]);
    const rMine = await rec(mine); const rReused = { ...(await rec(reused)), start: "42" };
    writeRun(dir, "old", DEAD_ORCH, [rMine, rReused]);
    const out = await recoverOrphans({ dir, ownRunId: "novo", actions: noopActions });
    expect(out.killed).toContain(mine.pid!); expect(out.killed).not.toContain(reused.pid!); expect(out.preserved.map((p: any) => p.pid)).toEqual([reused.pid!]);
    expect(await waitGone(mine.pid!)).toBe(true); expect(alive(reused.pid!)).toBe(true); expect(alive(external.pid!)).toBe(true);
    expect(readFileSync(path.join(dir, "incertos.log"), "utf8")).toMatch(/reutilizado/);
  }, 90000);

  it("orquestrador anterior VIVO mas sem identidade registrada: tratado como ocupado (nada é tocado)", async () => {
    const dir = runDir(); const o = decoy(); const ch = decoy(); const r = await rec(ch);
    writeRun(dir, "old", { pid: o.pid, start: null, exe: null }, [r]);
    const out = await recoverOrphans({ dir, ownRunId: "novo", actions: noopActions });
    expect(out.busy).toBe(true); expect(alive(ch.pid!)).toBe(true);
  }, 60000);
});

describe("diretórios temporários", () => {
  const tmp = base;
  const mk = (name: string, marker?: string) => { const d = path.join(tmp, name); mkdirSync(d, { recursive: true }); if (marker !== undefined) writeFileSync(path.join(d, OWNER_MARKER), marker); return d; };
  it("17/18) só apaga diretório com o marcador DESTA execução, no tmp, com nome de QA e sem processo usando-o", () => {
    const own = mk("levora-qa-profile-own", "run-1"), other = mk("levora-qa-profile-other", "run-2"), nomark = mk("levora-qa-profile-nomark"), foreign = mk("projeto-de-outro", "run-1");
    const ctx = { runId: "run-1", tmp };
    expect(canRemoveProfile(own, { ...ctx, table: [] }).ok).toBe(true);
    expect(canRemoveProfile(other, { ...ctx, table: [] })).toMatchObject({ ok: false, reason: expect.stringMatching(/outra execução/) });
    expect(canRemoveProfile(nomark, { ...ctx, table: [] })).toMatchObject({ ok: false, reason: expect.stringMatching(/sem marcador/) });
    expect(canRemoveProfile(foreign, { ...ctx, table: [] }).ok).toBe(false); // nome fora do padrão
    expect(canRemoveProfile(own, { ...ctx, table: [{ cmd: `chrome --user-data-dir=${own}` }] })).toMatchObject({ ok: false, reason: expect.stringMatching(/em uso/) });
    expect(canRemoveProfile(own, { ...ctx, table: [], uncertainProfiles: [own] }).ok).toBe(false);
    expect(canRemoveProfile(path.join(path.dirname(tmp), "levora-qa-profile-fora"), { ...ctx, table: [], exists: () => true, isDir: () => false }).ok).toBe(false); // fora do tmp
    expect(canRemoveProfile(own, { ...ctx, table: [] }).ok).toBe(true);
  });
  it("recoverOrphans nunca apaga diretório de outra execução, sem marcador ou em uso por processo externo; apaga o que é nosso", async () => {
    const dir = runDir(); const own = mk("levora-qa-profile-r-own", "oldrun"), other = mk("levora-qa-profile-r-other", "alheia"), used = mk("levora-qa-profile-r-used", "oldrun");
    const user = decoy([`--user-data-dir=${used}`]);
    writeRun(dir, "oldrun", DEAD_ORCH, [], [own, other, used]);
    const removed: string[] = [];
    const out = await recoverOrphans({ dir, tmp, ownRunId: "novo", actions: { ...noopActions, removeDir: async (d: string) => { removed.push(d); rmSync(d, { recursive: true, force: true }); } } });
    expect(removed).toEqual([own]); expect(existsSync(other)).toBe(true); expect(existsSync(used)).toBe(true); expect(alive(user.pid!)).toBe(true);
    expect(out.profilesPreserved.map((p: any) => p.dir).sort()).toEqual([other, used].sort());
  }, 60000);
  it("RunState grava o marcador do runId nos diretórios registrados", () => {
    const d = mk("levora-qa-profile-state"); const rs = new RunState(path.join(runDir(), "x.json"), "run-xyz"); rs.addProfile(d);
    expect(readFileSync(path.join(d, OWNER_MARKER), "utf8")).toBe("run-xyz");
  });
});

describe("sinais e falhas de inicialização", () => {
  it("12/13) SIGTERM e SIGINT: o manipulador executa a limpeza (encerra o filho da própria execução), remove o registro e sai — sem tocar em externos", async () => {
    for (const sig of ["SIGTERM", "SIGINT"]) {
      const fake: any = new EventEmitter(); fake.exit = (code: number) => { fake.exited = code; };
      const own = decoy(); const external = decoy(["qa-visual"]);
      const file = path.join(runDir(), "s.json"); const state = new RunState(file, `sig-${sig}`); state.begin(); state.addChild(own.pid!, "browser"); await state.settle();
      let ran = 0; const cleanups = { runAll: async () => { ran++; killTree(own); } };
      installSignalHandlers({ cleanups, state, proc: fake, exitCode: 3 });
      fake.emit(sig); await new Promise((r) => setTimeout(r, 1500));
      expect(ran).toBe(1); expect(fake.exited).toBe(3); expect(readState(file)).toBeNull();
      expect(await waitGone(own.pid!)).toBe(true); expect(alive(external.pid!)).toBe(true);
    }
  }, 60000);
  it("14) falha na inicialização do navegador: o perfil exclusivo é removido, nada fica rodando e o erro sobe", async () => {
    const before = new Set(listProcesses()!.map((p: any) => p.pid)); const registered: any[] = []; const profiles: string[] = []; const gone: string[] = [];
    await expect(launchBrowser(process.execPath, { onSpawn: (pid: number, kind: string, extra: any) => registered.push({ pid, kind, extra }), onProfile: (d: string) => profiles.push(d), onProfileGone: (d: string) => gone.push(d) })).rejects.toThrow(/encerrou ao iniciar/);
    expect(registered).toHaveLength(1); expect(registered[0].extra.profile).toBe(profiles[0]);
    expect(existsSync(profiles[0])).toBe(false); expect(gone).toEqual(profiles);
    expect(await waitGone(registered[0].pid)).toBe(true); expect(before.has(registered[0].pid)).toBe(false);
  }, 60000);
  it("planRecovery é puro: sem registro = nada; com execução viva = busy", () => {
    expect(planRecovery(null, { table: [] })).toEqual({ busy: false, children: [], profiles: [], database: null, containers: [] });
    expect(planRecovery({ orchestrator: { pid: 5, start: "7" } }, { table: [{ pid: 5, ppid: 0, start: "7", exe: "", cmd: "" }] })).toMatchObject({ busy: true, pid: 5 });
    expect(planRecovery({ orchestrator: { pid: 5, start: "7" }, children: [{ pid: 1 }] }, { table: [{ pid: 5, ppid: 0, start: "8", exe: "", cmd: "" }] })).toMatchObject({ busy: false, children: [{ pid: 1 }] }); // PID 5 reutilizado: a execução anterior está morta
  });
});

describe("varredura estática: nenhum encerramento global/por nome no código do QA", () => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "visual-baselines" || e.name === "node_modules" ? [] : walk(path.join(d, e.name))) : /\.(mjs|ts|sh)$/.test(e.name) ? [path.join(d, e.name)] : []));
  // remove comentários de bloco e de linha antes de procurar (os comentários explicam o que NÃO existe)
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/ .*$/, "")).join("\n");
  const FORBIDDEN: [RegExp, string][] = [[/\btaskkill\b/i, "taskkill"], [/\bwmic\b/i, "wmic"], [/Stop-Process/i, "Stop-Process"], [/\bpkill\b/, "pkill"], [/\bkillall\b/, "killall"], [/(Win32_Process|Get-CimInstance)[^\n]*\b(Terminate|Invoke-CimMethod)/i, "CIM Terminate"], [/process\.kill\(\s*-/, "process.kill de grupo sem verificação"]];
  const files = walk(ROOT).filter((f) => !/visual-mutants\.mjs$/.test(f));
  it("nenhum arquivo de scripts/qa-visual usa comandos de encerramento global (taskkill, wmic, Stop-Process, pkill, killall, grupo)", () => {
    const hits: string[] = [];
    for (const f of files) { const code = strip(readFileSync(f, "utf8")); for (const [re, name] of FORBIDDEN) if (re.test(code)) hits.push(`${path.relative(ROOT, f)}: ${name}`); }
    expect(hits).toEqual([]);
  });
  it("process.kill com SIGKILL/SIGTERM só existe em lib/procowner.mjs (único ponto de encerramento, protegido por verificação de identidade)", () => {
    const hits: string[] = [];
    for (const f of files) { if (/procowner\.mjs$/.test(f)) continue; const code = strip(readFileSync(f, "utf8")); if (/process\.kill\([^)]*SIG(KILL|TERM|INT|HUP)/.test(code)) hits.push(path.relative(ROOT, f)); }
    expect(hits).toEqual([]);
  });
  it("o conjunto de arquivos varridos é não vazio e inclui o executor", () => {
    expect(files.some((f) => /lib[\\/]procowner\.mjs$/.test(f))).toBe(true); expect(files.some((f) => /lib[\\/]browser\.mjs$/.test(f))).toBe(true); expect(files.length).toBeGreaterThan(20);
  });
});
