// Registro em disco POR EXECUÇÃO + recuperação de órfãos (M06: reescrito sobre propriedade explícita de processos).
// Cada execução grava `<tmp>/levora-qa-visual/runs/<runId>.json` com a IDENTIDADE (PID + instante de criação + executável [+ perfil exclusivo]) de tudo o que criou.
// Se o orquestrador morrer à força, a próxima execução só encerra um processo se a identidade registrada AINDA conferir; só apaga um diretório se ele tiver
// o marcador desta execução e nenhum processo estiver usando-o; nunca age por nome de processo nem por trecho de linha de comando; nunca toca em execução viva.
// O que não puder ser comprovado é PRESERVADO e fica registrado em `incertos.log`. Nunca guarda credenciais.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { OWNER_MARKER, captureIdentity, killOwned, listProcesses, verifyOwnership } from "./procowner.mjs";

/** Contêineres Docker criados por `qa:security` (nginx real): só estes nomes são removidos na recuperação. */
export const OUR_CONTAINER = /^levora-qa-nginx-[a-z0-9-]+$/;
export const PROFILE_PREFIX = "levora-qa-profile-";

export const stateDir = () => path.join(tmpdir(), "levora-qa-visual", "runs");
export const newRunId = () => `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;

export function readState(file) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } }
export function writeState(state, file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}
export function clearState(file) { try { rmSync(file, { force: true }); } catch { /* ok */ } }
export function isAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }

/**
 * Decide (PURA, testada): execução anterior viva (identidade do orquestrador confere) = { busy } e NADA é tocado;
 * orquestrador com PID vivo mas sem identidade registrada = incerto = também { busy } (conservador);
 * senão devolve os registros a verificar/encerrar, os diretórios a considerar e o banco a derrubar.
 */
export function planRecovery(state, { table, alive = isAlive }) {
  const empty = { busy: false, children: [], profiles: [], database: null, containers: [] };
  if (!state) return empty;
  const o = state.orchestrator;
  if (o && Number.isInteger(o.pid)) {
    if (o.start) { if (verifyOwnership(o, table).owned) return { ...empty, busy: true, pid: o.pid }; }
    else if (alive(o.pid)) return { ...empty, busy: true, pid: o.pid, uncertain: true };
  }
  return { busy: false, children: state.children ?? [], profiles: state.profiles ?? [], database: state.database ?? null, containers: (state.containers ?? []).filter((n) => OUR_CONTAINER.test(n)) };
}

/** Estado da execução atual, persistido a cada mudança. */
export class RunState {
  constructor(file, runId = newRunId()) {
    this.runId = runId; this.file = file ?? path.join(stateDir(), `${runId}.json`); this.pending = [];
    this.s = { runId, orchestrator: { pid: process.pid, start: null, exe: null }, children: [], profiles: [], containers: [], database: null, startedAt: new Date().toISOString() };
  }
  save() { writeState(this.s, this.file); }
  begin({ list = listProcesses } = {}) { this.save(); this.pending.push(captureIdentity(process.pid, { list }).then((id) => { if (id) { this.s.orchestrator = { pid: id.pid, start: id.start, exe: id.exe }; this.save(); } })); }
  /** Registra um filho criado por esta execução; a identidade é capturada em seguida (`settle()` aguarda). */
  addChild(pid, kind, extra = {}, { list = listProcesses } = {}) {
    if (!pid) return; const rec = { pid, kind, start: null, exe: null, ...(extra.profile ? { profile: extra.profile } : {}) };
    this.s.children.push(rec); this.save();
    this.pending.push(captureIdentity(pid, { list }).then((id) => { if (id) { rec.start = id.start; rec.exe = id.exe; this.save(); } }));
  }
  async settle() { const p = this.pending; this.pending = []; await Promise.all(p); }
  dropChild(pid) { this.s.children = this.s.children.filter((c) => c.pid !== pid); this.save(); }
  /** Diretório ou arquivo temporário exclusivo desta execução. Diretórios recebem o marcador com o runId. */
  addProfile(dir) {
    this.s.profiles.push(dir); this.save();
    try { if (existsSync(dir) && statSync(dir).isDirectory()) writeFileSync(path.join(dir, OWNER_MARKER), this.runId); } catch { /* sem marcador = nunca será apagado na recuperação */ }
  }
  dropProfile(dir) { this.s.profiles = this.s.profiles.filter((d) => d !== dir); this.save(); }
  addContainer(name) { this.s.containers = [...(this.s.containers ?? []), name]; this.save(); }
  dropContainer(name) { this.s.containers = (this.s.containers ?? []).filter((n) => n !== name); this.save(); }
  setDatabase(name) { this.s.database = name; this.save(); }
  clearDatabase() { this.s.database = null; this.save(); }
  end() { clearState(this.file); }
}

/** Decide se um diretório/arquivo registrado pode ser apagado (puro, testado). */
export function canRemoveProfile(dir, { runId, tmp = tmpdir(), exists = existsSync, isDir = (d) => { try { return statSync(d).isDirectory(); } catch { return false; } }, readMarker = (d) => { try { return readFileSync(path.join(d, OWNER_MARKER), "utf8"); } catch { return null; } }, table, uncertainProfiles = [] }) {
  if (!dir || !exists(dir)) return { ok: false, reason: "não existe" };
  const base = path.basename(dir);
  if (!base.startsWith("levora-qa-") ) return { ok: false, reason: "nome fora do padrão de diretório de QA" };
  if (path.resolve(path.dirname(dir)).toLowerCase() !== path.resolve(tmp).toLowerCase()) return { ok: false, reason: "fora do diretório temporário" };
  if (isDir(dir)) { const m = readMarker(dir); if (m === null) return { ok: false, reason: "sem marcador de propriedade (pode pertencer a outra execução)" }; if (m.trim() !== runId) return { ok: false, reason: "marcador pertence a outra execução" }; }
  if (uncertainProfiles.includes(dir)) return { ok: false, reason: "usado por processo de identidade incerta (preservado)" };
  if (table && table.some((p) => (p.cmd || "").includes(dir))) return { ok: false, reason: "ainda em uso por um processo em execução" };
  return { ok: true };
}

/**
 * Recupera órfãos de execuções anteriores MORTAS. `actions` = { removeDir(dir), dropDb(name), removeContainer?(name) }.
 * `list`/`kill` injetáveis (testes com processos sintéticos). Execução viva (identidade confere) → { busy } sem tocar em nada.
 */
export async function recoverOrphans({ dir = stateDir(), tmp = tmpdir(), ownRunId = null, list = listProcesses, alive = isAlive, kill, actions }) {
  const out = { busy: false, killed: [], preserved: [], profiles: [], profilesPreserved: [], containers: [], database: null, errors: [], runs: 0 };
  let files = []; try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return out; }
  for (const f of files) {
    const file = path.join(dir, f); const state = readState(file); if (!state || state.runId === ownRunId) continue;
    let table = null; try { table = list(); } catch { table = null; }
    const plan = planRecovery(state, { table, alive });
    if (plan.busy) return { ...out, busy: true, pid: plan.pid };
    out.runs++;
    const ko = await killOwned(plan.children, { list, ...(kill ? { kill } : {}) });
    out.killed.push(...ko.killed); out.errors.push(...ko.errors);
    const unsure = ko.preserved.filter((p) => !p.gone);
    out.preserved.push(...unsure);
    const uncertainProfiles = plan.children.filter((c) => unsure.some((u) => u.pid === c.pid)).map((c) => c.profile).filter(Boolean);
    let after = null; try { after = list(); } catch { after = null; }
    for (const d of plan.profiles) {
      const c = canRemoveProfile(d, { runId: state.runId, tmp, table: after ?? [{ cmd: d }], uncertainProfiles }); // sem tabela: assume "em uso"
      if (!c.ok) { if (c.reason !== "não existe") out.profilesPreserved.push({ dir: d, reason: c.reason }); continue; }
      try { await actions.removeDir(d); out.profiles.push(d); } catch (e) { out.errors.push(`perfil: ${e.message}`); }
    }
    for (const name of plan.containers) { try { await actions.removeContainer?.(name); out.containers.push(name); } catch (e) { out.errors.push(`contêiner: ${e.message}`); } }
    if (plan.database) { try { await actions.dropDb(plan.database); out.database = plan.database; } catch (e) { out.errors.push(`banco: ${e.message}`); } }
    if (unsure.length || out.profilesPreserved.length) { try { appendFileSync(path.join(dir, "incertos.log"), `${new Date().toISOString()} run=${state.runId} preservados=${JSON.stringify([...unsure, ...out.profilesPreserved])}\n`); } catch { /* ok */ } }
    clearState(file);
  }
  return out;
}

/** SIGINT/SIGTERM: executa a limpeza da PRÓPRIA execução (só o que ela criou), apaga o registro e sai. Injetável (testes usam um EventEmitter). */
export function installSignalHandlers({ cleanups, state, proc = process, exitCode }) {
  let started = false;
  for (const sig of ["SIGINT", "SIGTERM"]) proc.on(sig, async () => { if (started) return; started = true; try { await cleanups.runAll(); } catch { /* erros de limpeza já ficam no registro do Cleanups */ } state.end(); proc.exit(exitCode); });
}
