#!/usr/bin/env node
// Audita os relatórios JSON de `qa:visual` e `qa:security` no CI e escreve o resumo (Markdown) em stdout.
//   node scripts/qa-visual/ci-summary.mjs --visual reports/qa-visual.json --security reports/qa-security.json --expect-node 22 --expect-browser chrome
// Saída 0 = nada obrigatório faltou nem falhou; 1 = reprovado (o motivo vai no resumo e em stderr). Não lê variáveis de ambiente além de GITHUB_SHA.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { evaluateReports } from "./lib/ci-report.mjs";

const { values: o } = parseArgs({ options: { visual: { type: "string" }, security: { type: "string" }, "expect-node": { type: "string" }, "expect-browser": { type: "string" }, "require-parts": { type: "string" } } });
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const visualRaw = o.visual ? read(o.visual) : ""; const securityRaw = o.security ? read(o.security) : "";
const parse = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };
const { problems, markdown } = evaluateReports({
  visual: parse(visualRaw), security: parse(securityRaw), visualRaw, securityRaw,
  expectNode: o["expect-node"], expectBrowser: o["expect-browser"], requireParts: o["require-parts"] ? o["require-parts"].split(",") : undefined,
  commit: process.env.GITHUB_SHA ?? "(local)", knownSecrets: ["senha-de-qa-123"],
});
console.log(markdown);
if (problems.length) { for (const p of problems) console.error(`REPROVADO: ${p}`); process.exit(problems.some((p) => /não publicar/.test(p)) ? 2 : 1); } // 2 = parece conter segredo (artefato não publicado)
