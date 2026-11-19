#!/usr/bin/env node
/**
 * Validação de release LOCAL e reproduzível (M46). Medida provisória enquanto não há CI remoto: NÃO substitui CI independente, revisão humana nem homologação.
 *
 * Executa, em ordem, os gates que já existem no repositório (nenhum comando fictício; não há script de lint, e isto é dito no resumo):
 *   diff-check · arquivos-inesperados · typecheck-cliente · typecheck-servidor · build · build-servidor · testes-backend · testes-interface · migrations-backup-restauracao (opcional)
 * Cada etapa roda em processo separado, tem log próprio e resultado próprio: uma etapa que falha NUNCA vira sucesso por outra ter passado; o exit code final é 1 se qualquer etapa selecionada falhar.
 *
 * Segurança: não acessa produção, não exige credenciais reais, não publica, não faz deploy, não mexe no repositório remoto.
 * Os testes de backend exigem um PostgreSQL LOCAL com banco terminado em "_test" (DATABASE_URL); caso contrário a etapa falha (não é pulada em silêncio).
 *
 * Uso:  node scripts/release-validate.mjs [--out <pasta>] [--only a,b] [--skip a,b] [--with-db-check] [--with-audit]
 *       (--with-db-check precisa de RELEASE_CHECK_ADMIN_URL e PG_BIN; --with-audit consulta o registro npm)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const only = list(argVal("--only")); const skip = list(argVal("--skip"));
const withDb = args.includes("--with-db-check"); const withAudit = args.includes("--with-audit");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.resolve(argVal("--out", path.join(os.tmpdir(), `levora-release-validate-${runId}`)));
fs.mkdirSync(outDir, { recursive: true });

const node = process.execPath;
const bin = (pkg, rel) => path.join(root, "node_modules", pkg, rel);
const tsc = bin("typescript", "bin/tsc");
const vitest = bin("vitest", "vitest.mjs");
const FORBIDDEN = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|.*\.sqlite3?|.*\.dump|.*\.bak|.*\.log|id_rsa.*)$/i;
const FORBIDDEN_ALLOWED = /(^|\/)\.env\.example$/i;

function git(...a) { const r = spawnSync("git", a, { cwd: root, encoding: "utf-8" }); return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }; }

const stages = [
  { id: "diff-check", desc: "git diff --check (espaços e marcas de conflito)", fn: () => {
    const a = git("diff", "--check"); const b = git("diff", "--cached", "--check");
    return { ok: a.status === 0 && b.status === 0, out: a.out + b.out };
  } },
  { id: "arquivos-inesperados", desc: "nenhum segredo/dump/log/banco versionado ou novo", fn: () => {
    const tracked = git("ls-files").out.split(/\r?\n/).filter(Boolean);
    const untracked = git("ls-files", "--others", "--exclude-standard").out.split(/\r?\n/).filter(Boolean);
    const bad = [...tracked, ...untracked].filter((f) => FORBIDDEN.test(f) && !FORBIDDEN_ALLOWED.test(f));
    const conflict = tracked.filter((f) => /\.(orig|rej)$/.test(f));
    return { ok: bad.length === 0 && conflict.length === 0, out: bad.length || conflict.length ? `proibidos:\n${[...bad, ...conflict].join("\n")}` : `${tracked.length} versionados, ${untracked.length} novos, nenhum proibido` };
  } },
  { id: "typecheck-cliente", desc: "tsc -p tsconfig.json --noEmit", cmd: [node, [tsc, "-p", "tsconfig.json", "--noEmit"]] },
  { id: "typecheck-servidor", desc: "tsc -p tsconfig.server.json --noEmit", cmd: [node, [tsc, "-p", "tsconfig.server.json", "--noEmit"]] },
  { id: "build", desc: "npm run build (tsc + vite build)", cmd: [process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { shell: process.platform === "win32" }] },
  { id: "build-servidor", desc: "npm run build:server", cmd: [process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:server"], { shell: process.platform === "win32" }] },
  { id: "testes-backend", desc: "vitest run (suíte integral; exige PostgreSQL local *_test)", pre: () => {
    const u = process.env.DATABASE_URL;
    if (!u) return "DATABASE_URL não definida (aponte para um PostgreSQL LOCAL descartável cujo banco termine em _test)";
    let url; try { url = new URL(u); } catch { return "DATABASE_URL inválida"; }
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) return "DATABASE_URL não é local: recusado";
    if (!url.pathname.endsWith("_test")) return 'o banco precisa terminar em "_test"';
    if (!process.env.JWT_SECRET) return "JWT_SECRET (valor sintético) não definido";
    return null;
  }, cmd: [node, [vitest, "run"]] },
  { id: "testes-interface", desc: "vitest run -c vitest.ui.config.ts", cmd: [node, [vitest, "run", "-c", "vitest.ui.config.ts"]] },
  { id: "migrations-backup-restauracao", desc: "scripts/release-db-check.mjs (opcional: --with-db-check)", optional: withDb, pre: () => (process.env.RELEASE_CHECK_ADMIN_URL ? null : "defina RELEASE_CHECK_ADMIN_URL e PG_BIN"), cmd: [node, ["scripts/release-db-check.mjs", "--out", path.join(outDir, "db-check")]] },
  { id: "npm-audit", desc: "npm audit --audit-level=moderate (opcional: --with-audit; usa a rede)", optional: withAudit, cmd: [process.platform === "win32" ? "npm.cmd" : "npm", ["audit", "--audit-level=moderate"], { shell: process.platform === "win32" }] },
];

const results = [];
const head = git("rev-parse", "HEAD").out.trim();
console.log(`release-validate — HEAD ${head.slice(0, 12)} — logs em ${outDir}`);
for (const st of stages) {
  const selected = (only.length ? only.includes(st.id) : true) && !skip.includes(st.id) && st.optional !== false;
  if (!selected) { results.push({ id: st.id, desc: st.desc, result: "NAO_EXECUTADA", reason: st.optional === false ? "opcional (não solicitada)" : "excluída por --only/--skip" }); continue; }
  const started = Date.now();
  const logFile = path.join(outDir, `${st.id}.log`);
  let ok = false; let out = "";
  const preErr = st.pre?.();
  if (preErr) { out = `PRÉ-CONDIÇÃO NÃO ATENDIDA: ${preErr}`; }
  else if (st.fn) { const r = st.fn(); ok = r.ok; out = r.out; }
  else {
    const [cmd, cmdArgs, opts] = st.cmd;
    const r = spawnSync(cmd, cmdArgs, { cwd: root, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, ...(opts ?? {}) });
    out = `${r.stdout ?? ""}${r.stderr ?? ""}`; ok = r.status === 0 && !r.error;
    if (r.error) out += `\nerro ao iniciar: ${r.error.message}`;
  }
  fs.writeFileSync(logFile, out);
  const secs = Math.round((Date.now() - started) / 1000);
  results.push({ id: st.id, desc: st.desc, result: ok ? "PASSOU" : "FALHOU", seconds: secs, log: logFile });
  console.log(`${ok ? "PASSOU" : "FALHOU"}  ${st.id}  (${secs}s)`);
}
const failed = results.filter((r) => r.result === "FALHOU");
const notRun = results.filter((r) => r.result === "NAO_EXECUTADA");
const summary = {
  when: new Date().toISOString(), head, scope: "LOCAL — não é CI remoto, não é revisão humana, não é homologação",
  lint: "não declarado (o repositório não tem script de lint; nenhuma verificação de lint foi feita)",
  results, verdict: failed.length ? "FALHOU" : notRun.length ? "PASSOU_PARCIAL" : "PASSOU",
};
fs.writeFileSync(path.join(outDir, "release-validate.json"), JSON.stringify(summary, null, 2));
console.log(`\nveredito (local): ${summary.verdict} — ${results.filter((r) => r.result === "PASSOU").length} passaram, ${failed.length} falharam, ${notRun.length} não executadas`);
if (failed.length) console.log(`etapas com falha: ${failed.map((f) => f.id).join(", ")}`);
process.exitCode = failed.length ? 1 : 0;
