// M04: relógio de teste CONGELADO — só na pilha de QA (processos filhos e banco `_qa` descartável). Nada aqui toca o relógio do Windows nem a produção.
// Três camadas coerentes, todas no MESMO instante:
//   1) servidor (API/semente): módulo pré-carregado via NODE_OPTIONS que congela `Date` (clock-preload.mjs);
//   2) banco `_qa`: função `qa_clock.now()` + `search_path` do banco = qa_clock, pg_catalog, public → toda chamada `now()` sem schema (inclusive os DEFAULT now() do schema.sql,
//      que são resolvidos na criação das tabelas) devolve o instante congelado. O repositório não usa CURRENT_TIMESTAMP;
//   3) navegador: `Date` congelado em cada documento novo + fuso America/Sao_Paulo (Emulation.setTimezoneOverride), idioma pt-BR.
// O instante é arbitrário e FIXO (nunca "hoje"): as capturas deixam de depender do dia em que rodam e os valores de data/hora aparecem como são, sem normalização de texto.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export const FROZEN_CLOCK = Object.freeze({ iso: "2026-03-16T15:00:00.000Z", timezone: "America/Sao_Paulo", locale: "pt-BR", version: "clock-v2", seedWindowSeconds: 3600 });
export const clockPreloadFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "clock-preload.mjs");

/** NODE_OPTIONS dos filhos (semente, API): carrega o relógio congelado e fixa o fuso do processo. Preserva NODE_OPTIONS já existente. */
export function clockEnv(clock = FROZEN_CLOCK, base = process.env) {
  const opt = `--import ${pathToFileURL(clockPreloadFile).href}`;
  return { QA_CLOCK_ISO: clock.iso, TZ: clock.timezone, NODE_OPTIONS: [base.NODE_OPTIONS, opt].filter(Boolean).join(" ") };
}

/** Script injetado em TODO documento novo do navegador (Page.addScriptToEvaluateOnNewDocument). Congela Date e Date.now; `new Date(x)` com argumento continua normal. */
export function browserClockScript(clock = FROZEN_CLOCK) {
  return `(() => { const T0 = ${Date.parse(clock.iso)}; const R = Date; if (R.__qaFrozen) return;
    class F extends R { constructor(...a) { if (a.length === 0) super(T0); else super(...a); } static now() { return T0; } }
    Object.defineProperty(F, "name", { value: "Date" }); F.__qaFrozen = true; F.parse = R.parse; F.UTC = R.UTC; globalThis.Date = F; })();`;
}

/** SQL que cria o relógio de teste do banco `_qa` (idempotente). `db` = nome do banco (já validado como descartável).
 *  M05 (fase F) — duas fases:
 *   • semente (`{ seedTicks: N }`): `now()` devolve (instante − N s) + k s, com k = 1, 2, 3… (sequência `qa_clock.tick`, reiniciada a cada preparo). Cada evento semeado tem um instante DISTINTO e a ordem
 *     é a da própria semente: a ordenação deixa de depender do desempate do banco/servidor. É determinística enquanto a semente executar as mesmas operações na mesma ordem (verificado com duas execuções independentes).
 *   • execução (sem opções): `now()` constante no instante fixo (contadores e prazos não andam). Aplicada logo depois que a semente termina.
 *  Nada disso existe fora do banco _qa descartável. */
export function clockSql(db, clock = FROZEN_CLOCK, { seedTicks = 0 } = {}) {
  const ts = `'${clock.iso}'::timestamptz`;
  const q = (s) => s.replace(/"/g, '""');
  const seeded = seedTicks > 0;
  const body = seeded ? `SELECT (${ts} - interval '${Math.floor(seedTicks)} seconds') + nextval('qa_clock.tick') * interval '1 second'` : `SELECT ${ts}`;
  const vol = seeded ? "VOLATILE" : "STABLE";
  const fn = (name) => `CREATE OR REPLACE FUNCTION qa_clock.${name}() RETURNS timestamptz LANGUAGE sql ${vol} AS $f$ ${body} $f$;`;
  return [
    "CREATE SCHEMA IF NOT EXISTS qa_clock;",
    "CREATE SEQUENCE IF NOT EXISTS qa_clock.tick;",
    ...(seeded ? ["SELECT setval('qa_clock.tick', 1, false);"] : []),
    fn("now"),
    fn("transaction_timestamp"),
    fn("statement_timestamp"),
    fn("clock_timestamp"),
    `ALTER DATABASE "${q(db)}" SET search_path = qa_clock, pg_catalog, public;`,
    `ALTER DATABASE "${q(db)}" SET timezone = '${clock.timezone}';`,
  ];
}
