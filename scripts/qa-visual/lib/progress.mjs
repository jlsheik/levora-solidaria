// G2 — progresso e prazo máximo do `qa:visual` (módulo puro, testado em test/qaProgress.test.ts).
//
// Por que existe: a execução do CI ficou ~39 min sem NENHUMA linha de saída até o limite do job (G1). Em condições normais o `qa:visual` também fica
// ~14 min em silêncio (o relatório só é impresso no fim), então "sem saída" não distingue "lento" de "travado". Aqui: (1) uma linha de progresso
// a cada `everyMs` (e na primeira e na última célula), sem nenhum dado sensível — só contagens, nomes de cenário, viewport e tema; (2) um prazo máximo
// do PRÓPRIO script, menor que o do job, para que ele mesmo encerre, grave o relatório parcial e diga em que célula estava, em vez de ser cancelado
// sem diagnóstico. Nada disso altera medições, esperas, cenários ou resultados.

/** Quantidade de células que o `runScenarios` vai percorrer: cenário × viewports (do cenário ou os padrão) × temas, por navegador. */
export function countCells(scenarios, viewports, themes, browsers = 1) {
  let n = 0;
  for (const s of scenarios) n += (s.viewports ?? viewports).length * themes.length;
  return n * browsers;
}

export const fmtDuration = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min ${s % 60} s` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};

export class Progress {
  /** `log` recebe cada linha; `now` é injetável nos testes. `everyMs` = intervalo mínimo entre linhas (a primeira e a última sempre saem). */
  constructor({ total, everyMs = 60000, now = Date.now, log = console.log } = {}) {
    this.total = total; this.everyMs = everyMs; this.now = now; this.log = log;
    this.started = now(); this.lastPrinted = null; this.done = 0; this.last = null; this.lastCellAt = null; this.slowest = { ms: 0, label: null };
  }
  /** Chamado ao FIM de cada célula (aprovada ou não). `label` = "cenário @viewport tema". */
  cell(label, cellMs) {
    const t = this.now();
    this.done++; this.last = label; this.lastCellAt = t;
    if (cellMs > this.slowest.ms) this.slowest = { ms: cellMs, label };
    if (this.done === 1 || this.done === this.total || this.lastPrinted === null || t - this.lastPrinted >= this.everyMs) this.print();
  }
  print() {
    const t = this.now(); this.lastPrinted = t;
    const el = t - this.started; const rate = this.done ? el / this.done : 0;
    const eta = this.done && this.total > this.done ? ` · restante estimado ${fmtDuration(rate * (this.total - this.done))}` : "";
    this.log(`progresso: ${this.done}/${this.total} células · ${fmtDuration(el)} · ${this.done ? `${(rate / 1000).toFixed(1)} s/célula` : "sem célula concluída"}${eta} · última: ${this.last ?? "-"}`);
  }
  /** Texto de diagnóstico para o encerramento por prazo: onde estava e há quanto tempo a última célula terminou. */
  snapshot() {
    const t = this.now();
    return { done: this.done, total: this.total, elapsedMs: t - this.started, last: this.last, sinceLastCellMs: this.lastCellAt === null ? null : t - this.lastCellAt, slowest: this.slowest };
  }
  describe() {
    const s = this.snapshot();
    return `${s.done} de ${s.total} células concluídas em ${fmtDuration(s.elapsedMs)}; última concluída: ${s.last ?? "nenhuma"}${s.sinceLastCellMs === null ? "" : ` (há ${fmtDuration(s.sinceLastCellMs)})`}; célula mais lenta: ${s.slowest.label ?? "-"} (${Math.round(s.slowest.ms)} ms)`;
  }
}

/**
 * Prazo máximo do script. `onExpire(reason)` roda UMA vez quando `maxMs` passa. O temporizador não segura o processo vivo (unref): uma execução que
 * termina antes do prazo não espera por ele. Devolve { cancel }.
 */
export function startDeadline({ maxMs, onExpire, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!(maxMs > 0)) return { cancel() {} };
  let fired = false;
  const t = setTimer(() => { if (fired) return; fired = true; onExpire(`prazo máximo de ${fmtDuration(maxMs)} do qa:visual excedido`); }, maxMs);
  t?.unref?.();
  return { cancel() { fired = true; clearTimer(t); } };
}

/** Converte `--max-minutes` em milissegundos; recusa valores inválidos (não-numérico, ≤ 0 ou absurdo) em vez de ignorá-los em silêncio. */
export function parseMaxMinutes(v) {
  if (v === undefined) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 600) throw new Error(`--max-minutes inválido: ${v} (use um número entre 0 e 600)`);
  return Math.round(n * 60000);
}
