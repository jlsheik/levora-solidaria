// Registro em disco da execução em andamento + recuperação de ÓRFÃOS. Se o orquestrador for morto à força (taskkill /F, queda de energia), os filhos
// (navegador, API, Vite), o perfil temporário e o banco `_qa` podem sobrar. A próxima execução (ou `--cleanup`) encontra o registro, confirma que
// cada PID ainda é um processo NOSSO (linha de comando) antes de encerrá-lo, apaga os perfis e derruba o banco. Nunca guarda credenciais.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Marcadores que identificam processos criados por esta rotina (linha de comando). */
export const OURS = /qa-visual|levora-qa-profile/;
/** Contêineres Docker criados por `qa:security` (nginx real): só estes nomes são removidos na recuperação. */
export const OUR_CONTAINER = /^levora-qa-nginx-[a-z0-9-]+$/;

export const stateDir = () => path.join(tmpdir(), "levora-qa-visual");
export const stateFile = () => path.join(stateDir(), "active.json");

export function readState(file = stateFile()) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
export function writeState(state, file = stateFile()) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}
export function clearState(file = stateFile()) { try { rmSync(file, { force: true }); } catch { /* ok */ } }

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Linha de comando de um PID (Windows: PowerShell/CIM; demais: ps). Vazio se não existir. */
export function commandLineOf(pid) {
  try {
    if (process.platform === "win32") {
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 15000 });
      return (r.stdout || "").trim();
    }
    return (spawnSync("ps", ["-p", String(Number(pid)), "-o", "args="], { encoding: "utf8" }).stdout || "").trim();
  } catch { return ""; }
}

/**
 * Decide o que fazer com um registro anterior (função PURA, testada):
 *  - se o orquestrador anterior ainda está vivo e é nosso → { busy: true } (não mexe em nada; evita duas execuções recriando o mesmo banco);
 *  - senão devolve os PIDs nossos ainda vivos a encerrar, os perfis a apagar e o banco a derrubar.
 */
export function planRecovery(state, { alive, cmdline }) {
  if (!state) return { busy: false, kill: [], profiles: [], database: null, containers: [] };
  const orch = state.orchestrator;
  if (orch && alive(orch) && OURS.test(cmdline(orch))) return { busy: true, pid: orch, kill: [], profiles: [], database: null, containers: [] };
  const kill = (state.children ?? []).filter((c) => alive(c.pid) && OURS.test(cmdline(c.pid))).map((c) => c.pid);
  return { busy: false, kill, profiles: state.profiles ?? [], database: state.database ?? null, containers: (state.containers ?? []).filter((n) => OUR_CONTAINER.test(n)) };
}

/** Estado da execução atual, persistido a cada mudança. */
export class RunState {
  constructor(file = stateFile()) { this.file = file; this.s = { orchestrator: process.pid, children: [], profiles: [], containers: [], database: null, startedAt: new Date().toISOString() }; }
  save() { writeState(this.s, this.file); }
  begin() { this.save(); }
  addChild(pid, kind) { if (pid) { this.s.children.push({ pid, kind }); this.save(); } }
  dropChild(pid) { this.s.children = this.s.children.filter((c) => c.pid !== pid); this.save(); }
  addProfile(dir) { this.s.profiles.push(dir); this.save(); }
  dropProfile(dir) { this.s.profiles = this.s.profiles.filter((d) => d !== dir); this.save(); }
  addContainer(name) { this.s.containers = [...(this.s.containers ?? []), name]; this.save(); }
  dropContainer(name) { this.s.containers = (this.s.containers ?? []).filter((n) => n !== name); this.save(); }
  setDatabase(name) { this.s.database = name; this.save(); }
  clearDatabase() { this.s.database = null; this.save(); }
  end() { clearState(this.file); }
}

/** Recupera órfãos de uma execução anterior. `actions` = { killTree(pid), removeDir(dir), dropDb(name) }. Retorna um resumo. */
export async function recoverOrphans({ file = stateFile(), alive = isAlive, cmdline = commandLineOf, actions }) {
  const state = readState(file);
  const plan = planRecovery(state, { alive, cmdline });
  if (plan.busy) return { busy: true, pid: plan.pid };
  const done = { killed: [], profiles: [], containers: [], database: null, errors: [] };
  for (const pid of plan.kill) { try { await actions.killTree(pid); done.killed.push(pid); } catch (e) { done.errors.push(`pid ${pid}: ${e.message}`); } }
  for (const dir of plan.profiles) { try { if (existsSync(dir) && path.basename(dir).startsWith("levora-qa-profile-")) { await actions.removeDir(dir); done.profiles.push(dir); } } catch (e) { done.errors.push(`perfil: ${e.message}`); } }
  for (const name of plan.containers) { try { await actions.removeContainer?.(name); done.containers.push(name); } catch (e) { done.errors.push(`contêiner: ${e.message}`); } }
  if (plan.database) { try { await actions.dropDb(plan.database); done.database = plan.database; } catch (e) { done.errors.push(`banco: ${e.message}`); } }
  if (state) clearState(file);
  return { busy: false, ...done };
}
