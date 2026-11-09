// M04: pré-carregado (node --import) SÓ nos filhos da pilha de QA quando QA_CLOCK_ISO está definido. Congela `Date.now()` e `new Date()` (sem argumento) no instante fixo.
// Timers (setTimeout/setInterval), performance.now e process.hrtime NÃO são alterados: nada trava esperando o relógio andar.
// M05 (fase F): só no processo da SEMENTE (QA_CLOCK_SEED_TICKS=N, janela em segundos) o relógio parte de (instante − N s) e só AVANÇA quando a semente pede (`globalThis.__qaClockAdvance(ms)`, 1 s por chamada de endpoint):
// os eventos criados pela semente (trilha de auditoria etc.) ficam com instantes distintos e na ordem de criação. Um relógio que avançasse a cada leitura foi testado e REJEITADO: o número de leituras varia entre execuções
// (bibliotecas leem Date.now a seu critério) e o horário dos eventos deixava de ser reproduzível. A API em execução NÃO recebe essa variável: lá o relógio é constante.
// O avanço total é limitado pela janela: passar dela é erro (evento no futuro). dev/clock-order-check.mjs prova duas execuções independentes com a mesma sequência.
const iso = process.env.QA_CLOCK_ISO;
if (iso) {
  const T0 = Date.parse(iso);
  if (Number.isNaN(T0)) throw new Error(`QA_CLOCK_ISO inválido: ${iso}`);
  const window = Number(process.env.QA_CLOCK_SEED_TICKS ?? 0);
  const RealDate = Date;
  let offset = 0;
  const read = window > 0 ? () => T0 - window * 1000 + offset : () => T0;
  if (!RealDate.__qaFrozen) {
    class FrozenDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(read()); else super(...args); }
      static now() { return read(); }
    }
    Object.defineProperty(FrozenDate, "name", { value: "Date" });
    FrozenDate.__qaFrozen = true;
    globalThis.Date = FrozenDate;
    if (window > 0) {
      globalThis.__qaClockAdvance = (ms) => { offset += ms; if (offset >= window * 1000) throw new Error(`QA_CLOCK: a semente avançou ${offset} ms (janela ${window} s): eventos ficariam no futuro`); };
      globalThis.__qaClockOffsetMs = () => offset;
    }
  }
}
