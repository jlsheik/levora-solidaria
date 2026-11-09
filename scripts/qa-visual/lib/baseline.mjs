// Baselines visuais versionáveis (módulo testado). Diretório: <dir>/manifest.json + <dir>/images/** + <dir>/fingerprints/**.
//
// Regras (cada uma tem teste e mutante):
//  - Uma captura NUNCA vira referência por si só: nasce CANDIDATE. Só `approveBaseline` (comando explícito, com revisor) cria APPROVED.
//  - Nada é sobrescrito: os arquivos têm o SHA-256 no nome; uma nova candidata para uma célula que já tem APPROVED é só uma candidata (a aprovada continua valendo);
//    trocar a referência exige `replace: true` e mantém a antiga como SUPERSEDED (histórico).
//  - A referência é usada somente se o arquivo existe e o SHA-256 confere com o manifesto (senão: CORRUPT, nunca "aprovado").
//  - STALE: a referência foi feita com outra configuração de captura ou outra versão principal do navegador; precisa de nova aprovação, não é regressão.
//  - A identidade da célula inclui página, navegador, viewport e tema: não existe "comparar com a referência de outro viewport/tema".
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendApproval, assertLedgerIndependent, ledgerPathFromEnv, verifyApproval } from "./approvals.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const BASELINE_STATE = Object.freeze({ CANDIDATE: "CANDIDATE", APPROVED: "APPROVED", SUPERSEDED: "SUPERSEDED" });
export const RESOLUTION = Object.freeze({ APPROVED: "APPROVED", CANDIDATE_ONLY: "CANDIDATE_ONLY", STALE: "STALE", MISSING_BASELINE: "MISSING_BASELINE", CORRUPT: "CORRUPT", UNVERIFIED: "APPROVAL_UNVERIFIED" }); // M19: APPROVED no manifesto sem registro de aprovação independente = UNVERIFIED (nunca PASS)
export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
export const cellId = ({ pageId, browser, viewport, theme }) => `${pageId}__${browser}__${viewport}__${theme}`;
export const browserMajor = (version) => { const m = /(\d+)\./.exec(String(version ?? "")); return m ? Number(m[1]) : null; };

/** M19 (A3): caminhos vindos do manifesto precisam ficar DENTRO da pasta de baselines (sem "..", absoluto ou junction que escape). */
export function safeJoin(dir, rel) {
  if (typeof rel !== "string" || rel === "" || rel.includes("\0") || path.isAbsolute(rel)) throw new BaselineError("PATH_ESCAPE", `caminho inválido no manifesto: ${String(rel).slice(0, 60)}`);
  const base = path.resolve(dir); const full = path.resolve(base, rel); const r = path.relative(base, full);
  if (r === "" || r.startsWith("..") || path.isAbsolute(r)) throw new BaselineError("PATH_ESCAPE", `o caminho do manifesto escapa da pasta de baselines: ${rel.slice(0, 60)}`);
  return full;
}

export class BaselineError extends Error { constructor(code, message) { super(message); this.name = "BaselineError"; this.code = code; } }

// Metadados vão para o disco e para o relatório: nunca podem carregar segredo.
const SECRET_PATTERNS = [/floot_built_app_session=\S+/i, /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, /\bgh[pousr]_[A-Za-z0-9]{16,}/, /password\s*[:=]\s*\S+/i, /set-cookie\s*:/i, /authorization\s*:/i, /[\w.+-]+@[\w-]+\.[\w.-]+/];
export function assertNoSecrets(value, extraSecrets = []) {
  const text = JSON.stringify(value);
  for (const re of SECRET_PATTERNS) if (re.test(text)) throw new BaselineError("SECRET_IN_METADATA", `os metadados contêm algo com formato de segredo (${re.source.slice(0, 30)}…); recusado`);
  for (const s of extraSecrets) if (s && text.includes(s)) throw new BaselineError("SECRET_IN_METADATA", "os metadados contêm um valor de segredo conhecido; recusado");
}

const manifestPath = (dir) => path.join(dir, "manifest.json");
function writeAtomic(file, data) { mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp.${process.pid}`; writeFileSync(tmp, data); renameSync(tmp, file); }

export function loadManifest(dir) {
  const file = manifestPath(dir);
  if (!existsSync(file)) return { schema: 1, entries: [] };
  let m; try { m = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new BaselineError("BAD_MANIFEST", `manifest.json ilegível: ${e.message}`); }
  if (!m || m.schema !== 1 || !Array.isArray(m.entries)) throw new BaselineError("BAD_MANIFEST", "manifest.json com esquema desconhecido");
  return m;
}
export function saveManifest(dir, m) { writeAtomic(manifestPath(dir), JSON.stringify(m, null, 2) + "\n"); }

const imageRel = (e) => path.posix.join("images", e.pageId, `${e.browser}-${e.viewport}-${e.theme}.${e.imageSha256.slice(0, 12)}.png`);
const fpRel = (e) => path.posix.join("fingerprints", e.pageId, `${e.browser}-${e.viewport}-${e.theme}.${e.imageSha256.slice(0, 12)}.json`);

/**
 * Registra uma captura como CANDIDATA (nunca como aprovada).
 * meta: { pageId, browser, browserVersion, viewport, theme, sourceSha, captureConfigVersion, route, auth, capturedAt, width, height }
 */
export function addCandidate(dir, meta, png, fingerprint) {
  for (const k of ["pageId", "browser", "browserVersion", "viewport", "theme", "sourceSha", "captureConfigVersion"]) if (!meta[k]) throw new BaselineError("BAD_META", `metadado obrigatório ausente: ${k}`);
  assertNoSecrets(meta);
  const m = loadManifest(dir); const id = cellId(meta); const imageSha256 = sha256(png);
  const same = m.entries.find((e) => e.id === id && e.imageSha256 === imageSha256 && e.captureConfigVersion === meta.captureConfigVersion);
  if (same) return { entry: same, created: false };
  const approved = m.entries.find((e) => e.id === id && e.state === BASELINE_STATE.APPROVED);
  const entry = { id, pageId: meta.pageId, browser: meta.browser, browserVersion: meta.browserVersion, browserMajor: browserMajor(meta.browserVersion), viewport: meta.viewport, theme: meta.theme,
    route: meta.route ?? null, auth: meta.auth ?? null, sourceSha: meta.sourceSha, captureConfigVersion: meta.captureConfigVersion, capturedAt: meta.capturedAt ?? new Date().toISOString(),
    width: meta.width ?? null, height: meta.height ?? null, dynamicText: meta.dynamicText ?? null, captureMode: meta.captureMode ?? null, clock: meta.clock ?? null, docHeight: meta.docHeight ?? null, complete: meta.complete ?? null, segments: meta.segments ?? null, imageSha256, state: BASELINE_STATE.CANDIDATE, ...(approved ? { supersedes: approved.imageSha256 } : {}) };
  entry.file = imageRel(entry); entry.fingerprintFile = fingerprint ? fpRel(entry) : null;
  const target = path.join(dir, entry.file);
  if (existsSync(target) && sha256(readFileSync(target)) !== imageSha256) throw new BaselineError("WOULD_OVERWRITE", `${entry.file} já existe com outro conteúdo; recusado (nada é sobrescrito)`);
  writeAtomic(target, png);
  if (fingerprint) { const fpText = JSON.stringify(fingerprint); assertNoSecrets(fpText); writeAtomic(path.join(dir, entry.fingerprintFile), fpText + "\n"); entry.fingerprintSha256 = sha256(Buffer.from(fpText + "\n")); }
  m.entries.push(entry); saveManifest(dir, m);
  return { entry, created: true };
}

/** Aprovação EXPLÍCITA por uma pessoa. Verifica o arquivo da candidata; não aprova nada sozinha e não substitui uma aprovada sem `replace`. */
export function approveBaseline(dir, { id, imageSha256, reviewer, note, replace = false, now = new Date().toISOString(), ledger = ledgerPathFromEnv(), repoRoot = REPO_ROOT }) {
  if (!reviewer || String(reviewer).trim().length < 2) throw new BaselineError("NO_REVIEWER", "a aprovação exige o nome do revisor (--reviewer)");
  if (!ledger) throw new BaselineError("NO_ANCHOR", "aprovar exige uma âncora de aprovação fora do repositório (QA_APPROVAL_LEDGER); sem ela a aprovação não seria verificável");
  try { assertLedgerIndependent(ledger, { baselineDir: dir, repoRoot }); } catch (e) { throw new BaselineError("LEDGER_NOT_INDEPENDENT", e.message); }
  const m = loadManifest(dir);
  const cand = m.entries.find((e) => e.id === id && e.imageSha256 === imageSha256 && e.state === BASELINE_STATE.CANDIDATE);
  if (!cand) throw new BaselineError("NOT_A_CANDIDATE", `não há candidata ${id} com SHA-256 ${String(imageSha256).slice(0, 12)}…`);
  const file = safeJoin(dir, cand.file);
  if (!existsSync(file) || sha256(readFileSync(file)) !== cand.imageSha256) throw new BaselineError("HASH_MISMATCH", "o arquivo da candidata não existe ou não confere com o SHA-256 do manifesto; recusado");
  const prev = m.entries.find((e) => e.id === id && e.state === BASELINE_STATE.APPROVED);
  if (prev && !replace) throw new BaselineError("WOULD_REPLACE", `já existe uma referência APROVADA para ${id}; substituí-la exige --replace explícito`);
  if (prev) { prev.state = BASELINE_STATE.SUPERSEDED; prev.supersededAt = now; prev.supersededBy = cand.imageSha256; }
  cand.state = BASELINE_STATE.APPROVED; cand.approvedBy = String(reviewer).trim(); cand.approvedAt = now; if (note) cand.approvalNote = String(note).slice(0, 300);
  assertNoSecrets({ reviewer: cand.approvedBy, note: cand.approvalNote ?? "" });
  try { appendApproval(ledger, { id: cand.id, imageSha256: cand.imageSha256, captureConfigVersion: cand.captureConfigVersion, browserVersion: cand.browserVersion ?? null, sourceSha: cand.sourceSha ?? null, reviewer: cand.approvedBy, approvedAt: cand.approvedAt, note: cand.approvalNote ?? null }); } catch (e) { throw new BaselineError(e.code ?? "LEDGER_WRITE", e.message); }
  saveManifest(dir, m); return cand;
}

/** O que vale como referência para uma célula, agora. */
export function resolveBaseline(dir, cell, { captureConfigVersion, version }) {
  const m = loadManifest(dir); const id = cellId(cell);
  const approved = m.entries.find((e) => e.id === id && e.state === BASELINE_STATE.APPROVED);
  if (!approved) {
    const cand = m.entries.filter((e) => e.id === id && e.state === BASELINE_STATE.CANDIDATE);
    return cand.length ? { status: RESOLUTION.CANDIDATE_ONLY, reason: `só há candidata(s) não aprovada(s) para ${id}: nenhuma serve de referência oficial`, entry: cand[cand.length - 1] }
      : { status: RESOLUTION.MISSING_BASELINE, reason: `nenhuma baseline para ${id}`, entry: null };
  }
  let file; try { file = safeJoin(dir, approved.file); } catch (e) { return { status: RESOLUTION.CORRUPT, reason: e.message, entry: approved }; }
  if (!existsSync(file)) return { status: RESOLUTION.CORRUPT, reason: `arquivo da baseline aprovada ausente: ${approved.file}`, entry: approved };
  const buf = readFileSync(file);
  if (sha256(buf) !== approved.imageSha256) return { status: RESOLUTION.CORRUPT, reason: `SHA-256 de ${approved.file} não confere com o manifesto (arquivo alterado ou corrompido)`, entry: approved };
  if (approved.captureConfigVersion !== captureConfigVersion) return { status: RESOLUTION.STALE, reason: `configuração de captura mudou (${approved.captureConfigVersion} → ${captureConfigVersion}); reaprovar`, entry: approved, png: buf };
  const cur = browserMajor(version);
  if (approved.browserMajor == null || cur === null) return { status: RESOLUTION.STALE, reason: `versão do navegador UNKNOWN (registrada: ${approved.browserVersion ?? "?"}; atual: ${version ?? "?"}): não é possível provar que a referência vale para este navegador`, entry: approved, png: buf };
  if (approved.browserMajor !== cur) return { status: RESOLUTION.STALE, reason: `versão principal do navegador mudou (${approved.browserMajor} → ${cur}); reaprovar`, entry: approved, png: buf };
  const anchor = verifyApproval(ledgerPathFromEnv(), approved);
  if (!anchor.ok) return { status: RESOLUTION.UNVERIFIED, reason: `aprovação NÃO verificável: ${anchor.reason}`, entry: approved };
  let fingerprint = null;
  if (approved.fingerprintFile) { try { const t = readFileSync(safeJoin(dir, approved.fingerprintFile)); if (approved.fingerprintSha256 && sha256(t) !== approved.fingerprintSha256) return { status: RESOLUTION.CORRUPT, reason: "impressão digital de layout da baseline não confere com o manifesto", entry: approved }; fingerprint = JSON.parse(t.toString("utf8")); } catch { return { status: RESOLUTION.CORRUPT, reason: "impressão digital de layout da baseline ilegível", entry: approved }; } }
  return { status: RESOLUTION.APPROVED, reason: "", entry: approved, png: buf, fingerprint };
}

/** Auditoria do diretório inteiro: arquivos ausentes/alterados e estados incoerentes. */
export function auditBaselines(dir) {
  const m = loadManifest(dir); const issues = []; const approvedByCell = new Map();
  for (const e of m.entries) {
    if (e.state === BASELINE_STATE.APPROVED) { approvedByCell.set(e.id, (approvedByCell.get(e.id) ?? 0) + 1); if (!e.approvedBy || !e.approvedAt) issues.push(`${e.id}: APPROVED sem revisor/data`); }
    let f; try { f = safeJoin(dir, e.file); } catch (err) { issues.push(`${e.id}: ${err.message}`); continue; }
    if (!existsSync(f)) issues.push(`${e.id}: arquivo ausente ${e.file}`); else if (sha256(readFileSync(f)) !== e.imageSha256) issues.push(`${e.id}: SHA-256 diverge em ${e.file}`);
  }
  for (const [id, n] of approvedByCell) if (n > 1) issues.push(`${id}: ${n} referências APROVADAS simultâneas`);
  return { entries: m.entries.length, approved: m.entries.filter((e) => e.state === "APPROVED").length, candidates: m.entries.filter((e) => e.state === "CANDIDATE").length, issues };
}
