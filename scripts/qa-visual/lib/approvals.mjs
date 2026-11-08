// M19 — ÂNCORA LOCAL DE APROVAÇÃO (registro de aprovações FORA dos arquivos versionados).
//
// Problema (M18/A1): `APPROVED` e o SHA-256 da imagem moram no mesmo `manifest.json` que o commit pode editar junto com a imagem; isso NÃO autentica a aprovação.
// Solução local possível sem infraestrutura externa: a aprovação só vale se existir um REGISTRO correspondente (id + SHA-256 da imagem + configuração de captura) num arquivo FORA da pasta de
// baselines e FORA da árvore do repositório, apontado por `QA_APPROVAL_LEDGER`. O registro é encadeado por hash (cada linha inclui o hash da anterior): edição, remoção ou reordenação são detectadas.
//
// LIMITES (declarados, não escondidos): é uma âncora LOCAL sob o controle de quem tem acesso à máquina — NÃO é autenticação criptográfica nem prova de identidade do revisor. Uma âncora realmente
// independente exige infraestrutura externa ainda não autorizada (ex.: aprovação em PR de revisão obrigatória com CODEOWNERS/branch protection e um atestado assinado). Sem o registro, a
// referência resolve como APPROVAL_UNVERIFIED (exit 6, nunca PASS). Nenhuma chave ou segredo é criado ou armazenado aqui.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const LEDGER_ENV = "QA_APPROVAL_LEDGER";
export const AUTHENTICITY = "LOCAL_LEDGER_NOT_CRYPTOGRAPHIC";
const GENESIS = "0".repeat(64);
const h = (s) => createHash("sha256").update(s).digest("hex");
const canon = (r) => JSON.stringify({ id: r.id, imageSha256: r.imageSha256, captureConfigVersion: r.captureConfigVersion, browserVersion: r.browserVersion ?? null, sourceSha: r.sourceSha ?? null, reviewer: r.reviewer, approvedAt: r.approvedAt, note: r.note ?? null });
export const ledgerPathFromEnv = (env = process.env) => (env[LEDGER_ENV] ? path.resolve(env[LEDGER_ENV]) : null);

const inside = (child, parent) => { const rel = path.relative(parent, child); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };
const realOrSelf = (p) => { let cur = path.resolve(p); const rest = []; for (;;) { try { return path.join(realpathSync(cur), ...rest.reverse()); } catch { const up = path.dirname(cur); if (up === cur) return path.resolve(p); rest.push(path.basename(cur)); cur = up; } } };

/** O registro precisa estar fora da pasta de baselines e fora da árvore do repositório (senão o próprio commit poderia editá-lo). */
export function assertLedgerIndependent(ledgerFile, { baselineDir, repoRoot }) {
  const L = realOrSelf(ledgerFile);
  if (baselineDir && inside(L, realOrSelf(baselineDir))) throw Object.assign(new Error("o registro de aprovações não pode ficar dentro da pasta de baselines"), { code: "LEDGER_NOT_INDEPENDENT" });
  if (repoRoot && inside(L, realOrSelf(repoRoot))) throw Object.assign(new Error("o registro de aprovações não pode ficar dentro da árvore do repositório (seria versionável)"), { code: "LEDGER_NOT_INDEPENDENT" });
}

/** Lê e valida a cadeia. Devolve { ok, records, issues }. Arquivo ausente = registro vazio válido. */
export function readLedger(file) {
  if (!file) return { ok: false, records: [], issues: ["nenhum registro configurado"] };
  if (!existsSync(file)) return { ok: true, records: [], issues: [] };
  const records = []; const issues = []; let prev = GENESIS;
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  lines.forEach((line, i) => {
    let r; try { r = JSON.parse(line); } catch { issues.push(`linha ${i + 1}: JSON inválido`); return; }
    if (r.prev !== prev) issues.push(`linha ${i + 1}: encadeamento quebrado (prev)`);
    if (r.hash !== h(prev + canon(r))) issues.push(`linha ${i + 1}: hash não confere (registro alterado)`);
    prev = r.hash ?? prev; records.push(r);
  });
  return { ok: issues.length === 0, records, issues };
}

/** Acrescenta uma aprovação ao registro (só chamada por `approveBaseline`, depois de todas as verificações). */
export function appendApproval(file, rec) {
  const cur = readLedger(file); if (!cur.ok) throw Object.assign(new Error(`registro de aprovações inválido: ${cur.issues[0]}`), { code: "LEDGER_INVALID" });
  const prev = cur.records.length ? cur.records[cur.records.length - 1].hash : GENESIS;
  const full = { ...rec, prev }; full.hash = h(prev + canon(full));
  mkdirSync(path.dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify(full) + "\n"); return full;
}

/** A aprovação (id + imagem exata + configuração de captura) está registrada e a cadeia é íntegra? */
export function verifyApproval(file, entry) {
  const L = readLedger(file);
  if (!file) return { ok: false, reason: `nenhuma âncora de aprovação configurada (${LEDGER_ENV}): o manifesto sozinho não prova a aprovação` };
  if (!L.ok) return { ok: false, reason: `registro de aprovações inválido (${L.issues[0]})` };
  const hit = L.records.find((r) => r.id === entry.id && r.imageSha256 === entry.imageSha256 && r.captureConfigVersion === entry.captureConfigVersion);
  return hit ? { ok: true, record: hit, authenticity: AUTHENTICITY } : { ok: false, reason: "não há registro de aprovação para esta imagem exata e configuração (manifesto editado ou aprovação de outra imagem)" };
}
