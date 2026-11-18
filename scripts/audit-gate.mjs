// G7 — gate do `npm audit` COMPLETO com exceções NOMINAIS, temporárias e verificáveis (scripts/audit-exceptions.json).
// Não substitui o gate de produção (`npm audit --omit=dev --audit-level=moderate`, passo próprio do workflow). Ordem de rigor:
//   - qualquer falha de leitura/rede/JSON/relatório incompleto reprova (nunca "sem alertas por falta de dados");
//   - qualquer alerta moderate+ que não seja EXATAMENTE a exceção reprova; a exceção só vale dentro do prazo, do escopo (dev), dos pacotes e versões listados;
//   - a vulnerabilidade excepcionalizada é IMPRESSA no log (nunca escondida).
// Uso: node scripts/audit-gate.mjs            (executa `npm audit --json`)
//      node scripts/audit-gate.mjs --input relatorio.json   (relatório já gravado; testes/depuração)
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const DAY = 86400000;

/** Interpreta `<=X.Y.Z` (único formato aceito no escopo da exceção). Qualquer outro formato = exceção inválida. */
const parseVer = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v)); return m ? m.slice(1).map(Number) : null; };
const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };
function inRange(version, range) {
  const m = /^<=(\d+\.\d+\.\d+)$/.exec(String(range)); const v = parseVer(version);
  return !!m && !!v && cmp(v, parseVer(m[1])) <= 0;
}

/**
 * Função PURA. report = JSON de `npm audit --json`; lock = package-lock.json já lido; exceptions = conteúdo do JSON de exceções.
 * Retorna { ok, falhas: string[], excepcionados: string[], avisos: string[] }.
 */
export function evaluateAudit({ report, lock, exceptions, now = new Date() }) {
  const falhas = []; const avisos = []; const excepcionados = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) return { ok: false, falhas: ["relatório de auditoria ausente ou não é um objeto JSON"], excepcionados, avisos };
  if (report.error) return { ok: false, falhas: [`a auditoria não pôde ser feita (${String(report.error.code ?? "")} ${String(report.error.summary ?? report.error.detail ?? "").slice(0, 200)})`.trim()], excepcionados, avisos };
  if (!Number.isInteger(report.auditReportVersion) || typeof report.vulnerabilities !== "object" || report.vulnerabilities === null || Array.isArray(report.vulnerabilities) || !report.metadata?.vulnerabilities || !Number.isInteger(report.metadata.vulnerabilities.total)) {
    return { ok: false, falhas: ["relatório de auditoria incompleto (faltam auditReportVersion, vulnerabilities ou metadata.vulnerabilities)"], excepcionados, avisos };
  }
  const vulns = Object.entries(report.vulnerabilities);
  if (vulns.length !== report.metadata.vulnerabilities.total) falhas.push(`relatório inconsistente: ${vulns.length} entradas em vulnerabilities, mas metadata.total = ${report.metadata.vulnerabilities.total}`);
  const pk = lock?.packages; if (!pk || typeof pk !== "object") return { ok: false, falhas: [...falhas, "package-lock.json ausente ou inválido: não é possível provar o escopo (dev) da exceção"], excepcionados, avisos };

  const list = Array.isArray(exceptions?.exceptions) ? exceptions.exceptions : null;
  if (!list) falhas.push("arquivo de exceções ausente ou inválido");
  const relevant = vulns.filter(([, v]) => (RANK[v?.severity] ?? 99) >= RANK.moderate); // severidade desconhecida conta como relevante (fail-closed)

  // A exceção é validada ANTES de ser usada: vencida, malformada ou fora do formato = não vale (todos os alertas reprovam).
  const valid = [];
  for (const ex of list ?? []) {
    const bad = [];
    for (const k of ["advisory", "package", "affectedRange", "owner", "decidedAt", "expires", "justification", "closeWhen"]) if (typeof ex?.[k] !== "string" || !ex[k].trim()) bad.push(k);
    if (!Number.isInteger(ex?.source)) bad.push("source");
    if (ex?.scope !== "dev") bad.push("scope(só 'dev')");
    if (!Array.isArray(ex?.chain) || !ex.chain.length || !ex.chain.every((c) => typeof c === "string")) bad.push("chain");
    if (!Array.isArray(ex?.installedVersions) || !ex.installedVersions.length || !ex.installedVersions.every((x) => parseVer(x))) bad.push("installedVersions");
    if (ex && !/^<=\d+\.\d+\.\d+$/.test(String(ex.affectedRange))) bad.push("affectedRange(formato <=X.Y.Z)");
    const exp = Date.parse(`${ex?.expires}T23:59:59Z`), dec = Date.parse(`${ex?.decidedAt}T00:00:00Z`);
    if (!Number.isFinite(exp) || !Number.isFinite(dec)) bad.push("datas");
    else {
      if (exp - dec > 31 * DAY) bad.push("prazo maior que 30 dias");
      if (now.getTime() > exp) { falhas.push(`exceção ${ex.advisory} VENCIDA em ${ex.expires}: renovar com nova decisão ou resolver a vulnerabilidade`); continue; }
    }
    if (bad.length) { falhas.push(`exceção ${ex?.advisory ?? "?"} inválida: ${bad.join(", ")}`); continue; }
    valid.push(ex);
  }
  const ex = valid[0]; // uma exceção por vez; mais de uma nesta versão do gate é recusado de propósito (cada uma exige revisão do código do gate)
  if (valid.length > 1) falhas.push("mais de uma exceção válida: este gate aceita exatamente uma por vez");

  let usada = false;
  for (const [nome, v] of relevant) {
    const motivos = [];
    if (!ex) { falhas.push(`${nome} (${v?.severity}): alerta sem exceção válida`); continue; }
    if (!ex.chain.includes(nome)) motivos.push("pacote fora da cadeia autorizada");
    if (v?.severity !== "high") motivos.push(`severidade ${v?.severity} diferente da analisada (high)`);
    const via = Array.isArray(v?.via) ? v.via : [];
    if (!via.length) motivos.push("sem origem (via) no relatório");
    for (const o of via) {
      if (typeof o === "string") { if (!ex.chain.includes(o)) motivos.push(`origem ${o} fora da cadeia autorizada`); continue; }
      const url = String(o?.url ?? "");
      if (o?.source !== ex.source || !url.endsWith(ex.advisory) || o?.name !== ex.package) motivos.push(`OUTRO advisory na cadeia (${o?.name}:${o?.source}:${url.split("/").pop() || "?"})`);
      else if (!inRange(ex.installedVersions[0], ex.affectedRange)) motivos.push("faixa afetada inconsistente com a exceção");
    }
    const nodes = Array.isArray(v?.nodes) ? v.nodes : [];
    if (!nodes.length) motivos.push("sem caminhos de instalação no relatório");
    for (const n of nodes) {
      const p = pk[n];
      if (!p) { motivos.push(`${n} ausente do package-lock.json`); continue; }
      if (!p.dev || p.optional || p.peer) motivos.push(`${n} NÃO é exclusivamente de desenvolvimento no lockfile`);
      if (nome === ex.package && !ex.installedVersions.includes(p.version)) motivos.push(`${n}@${p.version} fora das versões autorizadas (${ex.installedVersions.join(", ")})`);
    }
    if (motivos.length) falhas.push(`${nome} (${v?.severity}): ${[...new Set(motivos)].join("; ")}`);
    else { usada = true; excepcionados.push(`${nome} (${v.severity}) ← ${ex.advisory}`); }
  }
  if (ex && !usada && !falhas.length) avisos.push(`exceção ${ex.advisory} não foi usada: a vulnerabilidade sumiu? REMOVER a exceção (${ex.closeWhen})`);
  // O advisory excepcionalizado tem que existir na cadeia; se o pacote-raiz da exceção está presente com OUTRO advisory, o laço acima já reprovou.
  return { ok: falhas.length === 0, falhas, excepcionados, avisos, excecao: ex ? { advisory: ex.advisory, expires: ex.expires, owner: ex.owner } : null };
}

function runNpmAudit() {
  try { return { stdout: execFileSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 64 << 20, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { stdout: e.stdout ? String(e.stdout) : "", erro: e }; } // `npm audit` sai com 1 quando há alertas: normal; o que decide é o JSON
}

export function main(argv = process.argv.slice(2), env = {}) {
  const i = argv.indexOf("--input");
  const lockPath = env.lock ?? "package-lock.json", excPath = env.exceptions ?? "scripts/audit-exceptions.json";
  let report = null; let falhaEntrada = null;
  try {
    const raw = i >= 0 ? (existsSync(argv[i + 1] ?? "") ? readFileSync(argv[i + 1], "utf8") : (() => { throw new Error(`relatório ${argv[i + 1]} não existe`); })()) : runNpmAudit().stdout;
    if (!raw.trim()) throw new Error("`npm audit --json` não devolveu nada (rede/registro indisponível?)");
    report = JSON.parse(raw);
  } catch (e) { falhaEntrada = `relatório de auditoria ilegível: ${e.message}`; }
  let lock = null, exceptions = null;
  try { lock = JSON.parse(readFileSync(lockPath, "utf8")); } catch { /* evaluateAudit reprova */ }
  try { exceptions = JSON.parse(readFileSync(excPath, "utf8")); } catch { /* idem */ }
  const r = falhaEntrada ? { ok: false, falhas: [falhaEntrada], excepcionados: [], avisos: [] } : evaluateAudit({ report, lock, exceptions, now: env.now ?? new Date() });
  const out = [];
  out.push(`audit-gate: ${report?.metadata?.vulnerabilities ? `relatório com ${JSON.stringify(report.metadata.vulnerabilities)}` : "sem relatório utilizável"}`);
  if (r.excepcionados.length) { out.push(`audit-gate: VULNERABILIDADES EXCEPCIONALIZADAS (continuam existindo, NÃO foram escondidas) — decisão: ${r.excecao?.owner}; válida até ${r.excecao?.expires}:`); for (const e of r.excepcionados) out.push(`  - ${e}`); }
  for (const a of r.avisos) out.push(`audit-gate: AVISO: ${a}`);
  for (const f of r.falhas) out.push(`audit-gate: FALHA: ${f}`);
  out.push(r.ok ? "audit-gate: APROVADO (somente a exceção nominal acima, se houver)" : "audit-gate: REPROVADO");
  return { ...r, saida: out.join("\n") };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = main(); console.log(r.saida); process.exit(r.ok ? 0 : 1);
}
