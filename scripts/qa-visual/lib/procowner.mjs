// M06 — PROPRIEDADE EXPLÍCITA DE PROCESSOS. Nada aqui encerra um processo por NOME ou por trecho de LINHA DE COMANDO.
// Um processo só é encerrado se (a) o executor tem o objeto ChildProcess que ele mesmo criou (propriedade por posse do handle), ou
// (b) existe um registro desta execução com a IDENTIDADE do processo (PID + instante de criação + executável [+ perfil exclusivo]) e a identidade
// atual do PID confere exatamente. PID reutilizado = instante de criação diferente = identidade incompatível = PRESERVADO.
// Se a identidade não puder ser provada (tabela de processos indisponível, registro sem identidade), o processo é PRESERVADO e a incerteza é devolvida.
// Descendentes: só os que, na tabela de processos, têm como pai um processo já verificado E foram criados depois dele (um PPID reciclado
// aponta para um filho "mais velho" que o pai e é rejeitado). Não há taskkill, wmic, pkill nem encerramento global em lugar nenhum.
import { spawnSync } from "node:child_process";

export const OWNER_MARKER = ".levora-qa-owner";

/** Converte a saída JSON do PowerShell (Win32_Process) em linhas { pid, ppid, start, exe, cmd }. Puro, testado. */
export function parseWinTable(text) {
  let j; try { j = JSON.parse(text); } catch { return null; }
  const arr = Array.isArray(j) ? j : j ? [j] : [];
  return arr.filter((r) => r && Number.isInteger(r.ProcessId)).map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId ?? 0, start: r.c == null ? "" : String(r.c), exe: r.ExecutablePath ?? "", cmd: r.CommandLine ?? "" }));
}
/** Converte `ps -eo pid=,ppid=,lstart=,args=` em linhas. Puro, testado. */
export function parsePsTable(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]{8}\s+\d{4})\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), start: m[3].replace(/\s+/g, " "), exe: (m[4] || "").split(" ")[0], cmd: m[4] || "" });
  }
  return rows;
}

/** Tabela de processos do sistema (somente leitura). Devolve null se não conseguir (o chamador trata como "identidade incerta"). */
export function listProcesses({ platform = process.platform, run = spawnSync } = {}) {
  try {
    if (platform === "win32") {
      const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{n='c';e={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks } else { $null } }} | ConvertTo-Json -Compress";
      const r = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) return null;
      return parseWinTable(r.stdout || "");
    }
    const r = run("ps", ["-eo", "pid=,ppid=,lstart=,args="], { encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
    if (r.status !== 0) return null;
    return parsePsTable(r.stdout || "");
  } catch { return null; }
}

const startOrd = (s) => { if (/^\d+$/.test(s)) return BigInt(s); const t = Date.parse(s); return Number.isNaN(t) ? null : BigInt(t); };
const sameExe = (a, b) => !a || !b || a.toLowerCase() === b.toLowerCase();

/** Identidade atual de um PID a partir de uma tabela (ou null). */
export function identityOf(pid, table) {
  const row = table?.find((p) => p.pid === pid); return row ? { pid: row.pid, start: row.start, exe: row.exe } : null;
}

/**
 * Decide se `rec` (registro desta execução: { pid, start, exe?, profile? }) ainda é EXATAMENTE o processo que a execução criou.
 * Retorna { owned, reason }. Função pura. Sem identidade registrada → nunca "owned".
 */
export function verifyOwnership(rec, table) {
  if (!rec || !Number.isInteger(rec.pid)) return { owned: false, reason: "registro inválido" };
  if (!rec.start) return { owned: false, reason: "registro sem instante de criação (identidade não comprovada)" };
  if (!table) return { owned: false, reason: "tabela de processos indisponível (identidade não comprovada)" };
  const row = table.find((p) => p.pid === rec.pid);
  if (!row) return { owned: false, reason: "PID inexistente (já encerrado)", gone: true };
  if (!row.start) return { owned: false, reason: "instante de criação ilegível (identidade não comprovada)" };
  if (row.start !== rec.start) return { owned: false, reason: "PID reutilizado por outro processo (instante de criação diferente)" };
  if (!sameExe(rec.exe, row.exe)) return { owned: false, reason: "executável diferente do registrado" };
  if (rec.profile && !(row.cmd || "").includes(`--user-data-dir=${rec.profile}`)) return { owned: false, reason: "o processo não usa o perfil exclusivo desta execução" };
  return { owned: true, reason: "identidade confere" };
}

/** Descendentes de `pid` (folhas primeiro): filho cujo PPID é o pai E que foi criado depois dele. Puro. */
export function descendantsOf(pid, table) {
  const root = table.find((p) => p.pid === pid); if (!root) return [];
  const out = []; const seen = new Set([pid]);
  const walk = (parent) => {
    for (const c of table) {
      if (seen.has(c.pid) || c.ppid !== parent.pid) continue;
      const a = startOrd(parent.start), b = startOrd(c.start);
      if (a === null || b === null || b < a) continue; // PPID reciclado: o "filho" é mais velho que o pai
      seen.add(c.pid); walk(c); out.push(c);
    }
  };
  walk(root); return out;
}

const defaultKill = (pid) => process.kill(pid, "SIGKILL"); // Windows: TerminateProcess; só por PID já verificado
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Encerra processos REGISTRADOS cuja identidade ainda confere. Nunca lança. Devolve { killed, preserved:[{pid,reason}], errors }.
 * Não declara sucesso falso: depois de encerrar, confere na tabela que sumiram; senão registra erro.
 */
export async function killOwned(records, { list = listProcesses, kill = defaultKill, settleMs = 250 } = {}) {
  const out = { killed: [], preserved: [], errors: [] };
  for (const rec of records) {
    let snap = null; try { snap = list(); } catch { snap = null; }
    const v = verifyOwnership(rec, snap);
    if (!v.owned) { out.preserved.push({ pid: rec?.pid, reason: v.reason, gone: !!v.gone }); continue; }
    const targets = [...descendantsOf(rec.pid, snap), snap.find((p) => p.pid === rec.pid)];
    for (const t of targets) { try { kill(t.pid); } catch (e) { out.errors.push(`pid ${t.pid}: ${e.code ?? e.message}`); } }
    await sleep(settleMs);
    let after = null; try { after = list(); } catch { after = null; }
    for (const t of targets) {
      const still = after ? after.some((p) => p.pid === t.pid && p.start === t.start) : null;
      if (still === false) out.killed.push(t.pid);
      else out.errors.push(`pid ${t.pid}: ${still === null ? "não foi possível confirmar o encerramento" : "continua em execução após o encerramento"}`);
    }
  }
  return out;
}

/**
 * Encerra a árvore de um ChildProcess CRIADO POR ESTA EXECUÇÃO (propriedade pelo handle). Recusa números de PID e qualquer outro tipo.
 * Descendentes só entram se forem comprovadamente filhos (PPID + criação posterior ao pai). Síncrono. Devolve um resumo.
 */
export function killTree(child, { list = listProcesses, kill = defaultKill } = {}) {
  const res = { killed: [], preserved: [], errors: [] };
  if (!child || typeof child !== "object" || !Number.isInteger(child.pid) || typeof child.kill !== "function") { res.preserved.push({ pid: typeof child === "number" ? child : undefined, reason: "só ChildProcess criado por esta execução é aceito (PID solto não prova propriedade)" }); return res; }
  if (child.exitCode !== null || child.signalCode) return res; // já encerrou: o PID pode estar reutilizado, não tocar
  let snap = null; try { snap = list(); } catch { snap = null; }
  const desc = snap && snap.some((p) => p.pid === child.pid) ? descendantsOf(child.pid, snap) : [];
  for (const d of desc) { try { kill(d.pid); res.killed.push(d.pid); } catch (e) { res.errors.push(`pid ${d.pid}: ${e.code ?? e.message}`); } }
  try { child.kill("SIGKILL"); res.killed.push(child.pid); } catch (e) { res.errors.push(`pid ${child.pid}: ${e.code ?? e.message}`); }
  return res;
}

/** Captura a identidade de um PID recém-criado pela execução (com poucas tentativas, pois o SO pode demorar a listá-lo). */
export async function captureIdentity(pid, { list = listProcesses, tries = 6, waitMs = 150 } = {}) {
  for (let i = 0; i < tries; i++) { let t = null; try { t = list(); } catch { t = null; } const id = identityOf(pid, t); if (id && id.start) return id; await sleep(waitMs); }
  return null;
}
