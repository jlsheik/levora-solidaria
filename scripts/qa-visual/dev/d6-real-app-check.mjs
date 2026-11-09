#!/usr/bin/env node
// D6 no PRODUTO REAL (sem modificá-lo): sobe a pilha real (banco `_qa` descartável), roda um cenário funcional real e provoca falhas por INTERCEPTAÇÃO do navegador (CDP Fetch):
// falha de rede, HTTP 500/503, módulo que lança exceção, redirecionamento do documento e elemento realmente ausente. Confere a classificação do executor funcional (FAIL × MISSING × UNMEASURABLE).
// Uso: QA_DATABASE_URL=… node scripts/qa-visual/dev/d6-real-app-check.mjs [--browser chrome|edge] [--out arquivo.json]   (exit 0 = todas as classificações como esperado)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findBrowser, launchBrowser } from "../lib/browser.mjs";
import { startStack, prepareDatabase, dropDatabase } from "../lib/stack.mjs";
import { installProbe, runScenarios } from "../lib/runner.mjs";
import { Report } from "../lib/report.mjs";
import { STATUS } from "../lib/contrast.mjs";
import { VIEWPORTS } from "../lib/viewport.mjs";
import { SCENARIOS, QA_PASSWORD } from "../scenarios.mjs";
import { assertDisposableDatabase } from "../lib/guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { values: o } = parseArgs({ options: { browser: { type: "string", default: "chrome" }, out: { type: "string" } } });
const dbUrl = process.env.QA_DATABASE_URL; assertDisposableDatabase(dbUrl); process.env.QA_PASSWORD = QA_PASSWORD;
const base = SCENARIOS.find((s) => s.id === "needs-primary-new"); const vp = VIEWPORTS.find((v) => v.w === 1280); const MODULE = "/src/App.tsx";
const results = []; const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`); };
await prepareDatabase(dbUrl, root); const stack = await startStack({ root, databaseUrl: dbUrl });
const files = mkdtempSync(path.join(tmpdir(), "levora-qa-d6-")); const session = await launchBrowser(findBrowser(o.browser)); await installProbe(session.cdp);
let mode = "ok"; const auth = { current: null }; // sessão compartilhada: o login acontece UMA vez, sem falha injetada (o login também carrega o módulo do app)
try {
  await session.cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*${MODULE}*`, requestStage: "Request" }, { urlPattern: "*/organizacoes/1/necessidades", resourceType: "Document", requestStage: "Request" }] });
  session.cdp.ws.addEventListener("message", (m) => {
    const d = JSON.parse(m.data); if (d.method !== "Fetch.requestPaused") return; const { requestId, request } = d.params; const url = new URL(request.url); const send = (method, params) => session.cdp.send(method, { requestId, ...params }).catch(() => {});
    if (url.pathname === MODULE) {
      if (mode === "rede") return send("Fetch.failRequest", { errorReason: "ConnectionReset" });
      if (mode === "http500") return send("Fetch.fulfillRequest", { responseCode: 500, body: Buffer.from("erro").toString("base64") });
      if (mode === "http503") return send("Fetch.fulfillRequest", { responseCode: 503, body: Buffer.from("indisponivel").toString("base64") });
      if (mode === "excecao") return send("Fetch.fulfillRequest", { responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/javascript" }], body: Buffer.from("throw new Error('falha ao montar (injetada pelo teste)');").toString("base64") });
    } else if (mode === "redirect") return send("Fetch.fulfillRequest", { responseCode: 302, responseHeaders: [{ name: "Location", value: "/organizacoes/1" }], body: "" });
    return send("Fetch.continueRequest", {});
  });
  const run = async (m, scenario) => { mode = m; const rep = new Report(); await runScenarios({ cdp: session.cdp, browserName: o.browser, version: session.version, baseUrl: stack.baseUrl, scenarios: [scenario], viewports: [vp], report: rep, filesDir: files, auth }); mode = "ok"; return rep; };
  const kinds = (r) => r.rows.map((x) => `${x.status}:${x.kind}`).join(",");
  let r = await run("ok", base); check("controle: cenário real sem falha → só PASS", r.rows.length > 0 && r.rows.every((x) => x.status === STATUS.PASS), JSON.stringify(r.counts()));
  r = await run("rede", base); check("falha de rede ao carregar o módulo principal do app real → UNMEASURABLE (causa ambiental), nunca MISSING", r.rows.some((x) => x.status === STATUS.UNMEASURABLE && /environment-resource-load-failed/.test(x.detail)) && !r.rows.some((x) => x.status === STATUS.MISSING || x.status === STATUS.FAIL), kinds(r));
  r = await run("http500", base); check("módulo principal com HTTP 500 → FAIL de carregamento (defeito do servidor/produto), nunca MISSING", r.rows.some((x) => x.status === STATUS.FAIL && x.kind === "carregamento" && /critical-resource-http-error/.test(x.detail)) && !r.rows.some((x) => x.status === STATUS.MISSING), kinds(r));
  r = await run("http503", base); check("módulo principal com HTTP 503 (gateway) → UNMEASURABLE, nunca aprovado", r.rows.some((x) => x.status === STATUS.UNMEASURABLE && /gateway/.test(x.detail)) && !r.rows.some((x) => x.status === STATUS.PASS), kinds(r));
  r = await run("excecao", base); check("módulo que lança exceção ao montar o app real → FAIL (exceção real não é ambiental)", r.rows.some((x) => x.status === STATUS.FAIL && /app-crashed-on-mount/.test(x.detail)), kinds(r));
  r = await run("redirect", base); check("redirecionamento indevido do documento (a rota termina em outra página do app real) → FAIL, não MISSING", r.rows.some((x) => x.status === STATUS.FAIL && /unexpected-redirect/.test(x.detail)) && !r.rows.some((x) => x.status === STATUS.MISSING), kinds(r));
  r = await run("ok", { ...base, id: "needs-primary-new-ausente", target: { css: "button#nao-existe-m02" } }); check("elemento realmente ausente numa página real que montou → MISSING (severidade mantida)", r.rows.some((x) => x.status === STATUS.MISSING) && !r.rows.some((x) => x.status === STATUS.UNMEASURABLE && x.kind === "carregamento"), kinds(r));
} finally { await session.close(); await stack.stop(); await dropDatabase(dbUrl); rmSync(files, { recursive: true, force: true }); }
const fails = results.filter((x) => !x.ok).length; if (o.out) writeFileSync(path.resolve(o.out), JSON.stringify({ geradoEm: new Date().toISOString(), navegador: o.browser, total: results.length, falhas: fails, resultados: results }, null, 2) + "\n");
console.log(`\nD6 no produto real: ${results.length - fails}/${results.length} como esperado`); process.exit(fails ? 4 : 0);
