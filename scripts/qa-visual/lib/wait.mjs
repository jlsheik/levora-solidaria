// Espera por uma condição da PÁGINA com prazo em milissegundos. O prazo é da página, não do computador: se o próprio executor do QA (ou o sistema) ficar
// congelado, o tempo do congelamento é devolvido ao prazo e a condição é verificada de novo antes de desistir. Sem isso, uma pausa longa entre duas
// verificações (coleta de lixo de um heap grande, suspensão) vence o prazo e vira "elemento não encontrado" mesmo que a página já o tenha renderizado.
// A compensação é limitada (MAX_COMPENSATION_MS): um congelamento absurdo continua sendo reportado, nunca espera para sempre.
const TICK_MS = 100;
const FREEZE_MIN_MS = 1000;
export const MAX_COMPENSATION_MS = 60000;

/** Relógio de congelamento: um temporizador que deveria disparar a cada TICK_MS; o atraso acima de FREEZE_MIN_MS é tempo em que nada rodou. */
export class FreezeClock {
  constructor({ now = Date.now, setTimer = setInterval } = {}) {
    this.now = now; this.total = 0; this.events = []; this.last = now();
    this.timer = setTimer(() => this.tick(), TICK_MS); this.timer.unref?.();
  }
  tick() {
    const t = this.now(); const over = t - this.last - TICK_MS; this.last = t;
    if (over > FREEZE_MIN_MS) { this.total += over; this.events.push({ at: t, frozenMs: over }); }
  }
  stop() { clearInterval(this.timer); }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Repete `fn` a cada `every` ms até devolver um valor verdadeiro (retornado) ou o prazo acabar (null). Exceções de `fn` (página navegando) contam como "ainda não".
 * `clock` (FreezeClock) devolve ao prazo o tempo congelado; `onCompensate(ms)` avisa quando isso acontece (diagnóstico).
 */
export async function waitUntil(fn, ms, { every = 120, now = Date.now, sleep = defaultSleep, clock, onCompensate } = {}) {
  const start = now(); const frozen0 = clock?.total ?? 0; let compensated = 0;
  const deadline = () => start + ms + compensated;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { if (e?.fatal) throw e; /* G4: sessão CDP perdida não é "a página está navegando": propaga */ /* a página pode estar navegando */ }
    clock?.tick(); // contabiliza o congelamento agora, sem depender da ordem em que os temporizadores acordam
    const frozen = Math.min((clock?.total ?? 0) - frozen0, MAX_COMPENSATION_MS);
    if (frozen > compensated) { compensated = frozen; onCompensate?.(compensated); continue; } // houve congelamento desde a última verificação: confere de novo antes de contar o prazo
    if (now() >= deadline()) return null;
    await sleep(every);
  }
}
