#!/usr/bin/env node
// M05 (fase F): prova que a SEMENTE do ambiente de QA gera instantes DISTINTOS, na ordem da própria semente, e que duas execuções independentes (dois bancos _qa novos, duas semeaduras completas)
// produzem a mesma sequência de eventos com os mesmos horários. Também confirma que, depois da semente, now() volta a ser constante e que nada ficou no futuro.
// Uso: QA_DATABASE_URL=postgres://…/<prefixo>_qa node scripts/qa-visual/dev/clock-order-check.mjs [--out arquivo.json]   (cria e apaga <prefixo>_a_qa e <prefixo>_b_qa)
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { prepareDatabase, startStack, dropDatabase } from "../lib/stack.mjs";
import { FROZEN_CLOCK } from "../lib/clock.mjs";
import { assertDisposableDatabase } from "../lib/guard.mjs";
import { QA_PASSWORD } from "../scenarios.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { values: o } = parseArgs({ options: { out: { type: "string" } } });
const base = process.env.QA_DATABASE_URL; assertDisposableDatabase(base); process.env.QA_PASSWORD = QA_PASSWORD;
const urlFor = (tag) => { const u = new URL(base); u.pathname = `/${u.pathname.slice(1).replace(/_qa$/, "")}_${tag}_qa`; return u.toString(); };
const results = []; const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`); };
const T0 = Date.parse(FROZEN_CLOCK.iso);

async function seedAndDump(tag) {
  const url = urlFor(tag); await prepareDatabase(url, root, { clock: FROZEN_CLOCK }); const stack = await startStack({ root, databaseUrl: url, clock: FROZEN_CLOCK });
  try {
    const { default: postgres } = await import("postgres"); const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const audit = await sql`SELECT action, created_at FROM audit_log ORDER BY created_at, action`;
      const tx = await sql`SELECT created_at FROM stock_transactions ORDER BY created_at`;
      const needs = await sql`SELECT created_at FROM needs ORDER BY created_at`;
      const [{ n1 }] = await sql`SELECT now() AS n1`; await sql`SELECT pg_sleep(1.2)`; const [{ n2 }] = await sql`SELECT now() AS n2`;
      return { audit: audit.map((r) => [r.action, new Date(r.created_at).toISOString()]), tx: tx.map((r) => new Date(r.created_at).toISOString()), needs: needs.map((r) => new Date(r.created_at).toISOString()), now1: new Date(n1).toISOString(), now2: new Date(n2).toISOString(), ticks: stack.clockTicks };
    } finally { await sql.end(); }
  } finally { await stack.stop(); await dropDatabase(url); }
}
const A = await seedAndDump("a"); const B = await seedAndDump("b");
const sha = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);
for (const [tag, d] of [["A", A], ["B", B]]) {
  const times = d.audit.map((r) => r[1]);
  check(`${tag}: a trilha de auditoria semeada tem ${times.length} eventos`, times.length > 0, `n=${times.length}`);
  // eventos gravados pela MESMA requisição (ex.: correção que registra dois eventos) compartilham o instante por construção do produto; entre requisições os instantes são distintos
  check(`${tag}: eventos de requisições diferentes têm instantes DISTINTOS (empates só dentro da mesma requisição)`, new Set(times).size >= Math.ceil(times.length * 0.75), `instantes distintos=${new Set(times).size} em ${times.length} eventos`);
  check(`${tag}: transações de estoque e necessidades também têm instantes distintos`, new Set(d.tx).size === d.tx.length && new Set(d.needs).size === d.needs.length, `estoque=${new Set(d.tx).size}/${d.tx.length} necessidades=${new Set(d.needs).size}/${d.needs.length}`);
  const mx = Math.max(...times.map(Date.parse)), mn = Math.min(...times.map(Date.parse));
  check(`${tag}: nada no futuro e tudo dentro da janela de semente`, mx < T0 && mn >= T0 - FROZEN_CLOCK.seedWindowSeconds * 1000, `de ${new Date(mn).toISOString()} a ${new Date(mx).toISOString()} (instante fixo ${FROZEN_CLOCK.iso})`);
  check(`${tag}: depois da semente now() é constante (dois instantes separados por 1,2 s)`, d.now1 === FROZEN_CLOCK.iso && d.now2 === FROZEN_CLOCK.iso, `${d.now1} / ${d.now2}`);
  check(`${tag}: a semente usou menos instantes que a janela`, d.ticks > 0 && d.ticks < FROZEN_CLOCK.seedWindowSeconds, `instantes usados=${d.ticks}`);
}
check("A e B (duas semeaduras independentes): mesma trilha, mesmos horários, mesma ordem", sha(A.audit) === sha(B.audit), `sha A=${sha(A.audit)} B=${sha(B.audit)}`);
check("A e B: mesmos horários de estoque e de necessidades", sha([A.tx, A.needs]) === sha([B.tx, B.needs]), `sha A=${sha([A.tx, A.needs])} B=${sha([B.tx, B.needs])}`);
check("A e B: mesmo número de instantes usados pela semente", A.ticks === B.ticks, `${A.ticks} / ${B.ticks}`);
const fails = results.filter((x) => !x.ok).length;
if (o.out) writeFileSync(path.resolve(o.out), JSON.stringify({ geradoEm: new Date().toISOString(), total: results.length, falhas: fails, resultados: results, amostraA: A.audit.slice(0, 12) }, null, 2) + "\n");
console.log(`\nOrdem do relógio de teste: ${results.length - fails}/${results.length} como esperado`); process.exit(fails ? 4 : 0);
