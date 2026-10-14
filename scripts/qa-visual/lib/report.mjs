// Registro de resultados, resumo, cobertura e códigos de saída da verificação visual. Módulo puro (testado).
import { STATUS } from "./contrast.mjs";

/** Códigos de saída: separam "violação real" de "não consegui medir" e de "ambiente indisponível". */
export const EXIT = Object.freeze({ OK: 0, FAIL: 1, UNMEASURED: 2, ENV: 3, SELFTEST: 4 });

/** Chave de uma combinação da matriz: navegador | cenário | viewport | tema. */
export const comboKey = (browser, scenario, viewport, theme) => `${browser}|${scenario}|${viewport}|${theme}`;

/** Todas as combinações que a execução deveria ter exercitado (o que não aparecer no relatório é lacuna, nunca "aprovado"). */
export function expectedCombos({ browsers, scenarios, viewports, themes }) {
  const out = [];
  for (const b of browsers) for (const s of scenarios) for (const v of s.viewports ?? viewports) for (const t of themes) out.push(comboKey(b, s.id, v, t));
  return out;
}

/** Combinações esperadas sem NENHUMA linha no relatório (executadas ou explicitamente reportadas). */
export function coverageGaps(rows, expected) {
  const seen = new Set(rows.map((r) => comboKey(r.browser, r.scenario, r.viewport, r.theme)));
  return expected.filter((k) => !seen.has(k));
}

/**
 * Seleção executada x catálogo completo. Cenários omitidos NÃO geram linhas (portanto nunca contam como PASS): aparecem aqui, no relatório JSON e no console.
 * `completo` só é true quando nada foi omitido.
 */
export function selectionSummary(allIds, chosenIds, profile = "full") {
  const chosen = new Set(chosenIds);
  const omitted = allIds.filter((id) => !chosen.has(id));
  return { perfil: profile, total: allIds.length, executados: chosen.size, omitidos: omitted, completo: omitted.length === 0 };
}

export class Report {
  constructor() {
    this.rows = [];
    this.env = [];
  }
  /** row: { browser, version, scenario, target, variant, viewport, theme, state, kind, status, ratio?, required?, detail } */
  add(row) {
    if (!Object.values(STATUS).includes(row.status)) throw new Error(`status inválido: ${row.status}`);
    this.rows.push(row);
    return row;
  }
  addEnv(message) {
    this.env.push(message);
  }
  counts() {
    const c = Object.fromEntries(Object.values(STATUS).map((s) => [s, 0]));
    for (const r of this.rows) c[r.status]++;
    c.ENV += this.env.length;
    return c;
  }
  exitCode() {
    const c = this.counts();
    if (this.env.length) return EXIT.ENV;
    if (c.FAIL) return EXIT.FAIL;
    if (c.MISSING || c.UNMEASURABLE) return EXIT.UNMEASURED;
    return EXIT.OK;
  }
  /** Contagem por navegador × viewport (para o resumo) — não confundir com "componentes independentes". */
  byBrowserViewport() {
    const m = new Map();
    for (const r of this.rows) { const k = `${r.browser} ${r.viewport ?? "-"}`; const c = m.get(k) ?? { PASS: 0, other: 0 }; r.status === STATUS.PASS ? c.PASS++ : c.other++; m.set(k, c); }
    return [...m.entries()].map(([k, c]) => `${k}: ${c.PASS} PASS${c.other ? `, ${c.other} outros` : ""}`);
  }
  /** Linhas de texto para o console: falhas e não medidos primeiro; PASS resumido. */
  format({ verbose = false } = {}) {
    const lines = [];
    const show = (r) => `${r.status.padEnd(12)} [${r.browser}] ${r.scenario} · ${r.target} · ${r.viewport ?? "-"} · ${r.theme} · ${r.state} (${r.kind}) ${r.ratio !== undefined ? `${r.ratio}:1 (mín ${r.required}:1) ` : ""}${r.detail ?? ""}`;
    for (const e of this.env) lines.push(`ENV          ${e}`);
    for (const r of this.rows) if (r.status !== STATUS.PASS && r.status !== STATUS.SKIP) lines.push(show(r));
    for (const r of this.rows) if (r.status === STATUS.SKIP) lines.push(show(r));
    if (verbose) for (const r of this.rows) if (r.status === STATUS.PASS) lines.push(show(r));
    const c = this.counts();
    lines.push(`Resumo: ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join("  ")}  → código de saída ${this.exitCode()}`);
    const per = this.byBrowserViewport();
    if (per.length) lines.push(`Por navegador e viewport (verificações, não componentes independentes): ${per.join(" | ")}`);
    return lines;
  }
}
