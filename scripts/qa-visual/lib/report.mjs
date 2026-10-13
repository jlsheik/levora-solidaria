// Registro de resultados, resumo e códigos de saída da verificação visual. Módulo puro (testado).
import { STATUS } from "./contrast.mjs";

/** Códigos de saída: separam "violação real" de "não consegui medir" e de "ambiente indisponível". */
export const EXIT = Object.freeze({ OK: 0, FAIL: 1, UNMEASURED: 2, ENV: 3, SELFTEST: 4 });

export class Report {
  constructor() {
    this.rows = [];
    this.env = [];
  }
  /** row: { browser, version, scenario, target, variant, theme, state, kind, status, ratio?, required?, detail, limitation? } */
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
  /** Linhas de texto para o console: falhas e não medidos primeiro; PASS resumido. */
  format({ verbose = false } = {}) {
    const lines = [];
    const show = (r) => `${r.status.padEnd(12)} [${r.browser}] ${r.scenario} · ${r.target} · ${r.theme} · ${r.state} (${r.kind}) ${r.ratio !== undefined ? `${r.ratio}:1 (mín ${r.required}:1) ` : ""}${r.detail ?? ""}`;
    for (const e of this.env) lines.push(`ENV          ${e}`);
    for (const r of this.rows) if (r.status !== STATUS.PASS && r.status !== STATUS.SKIP) lines.push(show(r));
    for (const r of this.rows) if (r.status === STATUS.SKIP) lines.push(show(r));
    if (verbose) for (const r of this.rows) if (r.status === STATUS.PASS) lines.push(show(r));
    const c = this.counts();
    lines.push(`Resumo: ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join("  ")}  → código de saída ${this.exitCode()}`);
    return lines;
  }
}
