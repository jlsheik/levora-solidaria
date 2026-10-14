// Aritmética de contraste (WCAG 2.x) e critérios por tipo de elemento. Módulo PURO (sem navegador, sem I/O): é o que os testes unitários
// de `test/qaVisual.test.ts` cobrem. As cores chegam já normalizadas para RGB 0–255 (+ alfa) pela sonda que roda dentro do navegador.

/** Resultado de uma verificação. `ENV` e `SKIP` não vêm daqui: são decididos pelo orquestrador. */
export const STATUS = Object.freeze({
  PASS: "PASS", // medido e dentro do critério
  FAIL: "FAIL", // medido e FORA do critério (violação real)
  MISSING: "MISSING", // o elemento esperado não existe na tela
  UNMEASURABLE: "UNMEASURABLE", // existe, mas o estado exigido não pôde ser alcançado (ex.: hover não aplicou)
  SKIP: "SKIP", // dispensado explicitamente (documentado no relatório)
  ENV: "ENV", // ambiente indisponível (navegador, banco, app)
});

/** Limites mínimos por tipo de elemento (WCAG 1.4.3 e 1.4.11 / 2.4.11). */
export const THRESHOLDS = Object.freeze({
  text: 4.5, // texto normal (1.4.3)
  largeText: 3, // texto grande: >= 24px, ou >= 18,66px em negrito (1.4.3)
  icon: 3, // ícone/objeto gráfico essencial (1.4.11)
  boundary: 3, // limite visual de um componente: borda de campo, trilho de Switch... (1.4.11)
  ring: 3, // indicador de foco contra a superfície (1.4.11 / 2.4.11)
});

const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

/** Luminância relativa WCAG de um RGB 0–255. */
export function relativeLuminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Razão de contraste WCAG entre dois RGB opacos (sem arredondar). */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Arredonda para 2 casas (como o relatório exibe). A decisão PASS/FAIL usa o valor SEM arredondar. */
export const round2 = (x) => Math.round(x * 100) / 100;

/** Compõe uma cor com alfa sobre um fundo opaco. */
export function compositeOver([r, g, b, a = 1], [br, bg, bb]) {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
}

/** Texto grande segundo a WCAG: >= 24px, ou >= 18,66px (14pt) com peso >= 700. */
export function isLargeText(fontSizePx, fontWeight) {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && Number(fontWeight) >= 700);
}

/** Limite aplicável: `kind` ∈ text | icon | boundary | ring (texto grande reduz o limite do texto para 3). */
export function requiredRatio(kind, { fontSizePx, fontWeight } = {}) {
  if (kind === "text") return isLargeText(fontSizePx ?? 16, fontWeight ?? 400) ? THRESHOLDS.largeText : THRESHOLDS.text;
  if (kind in THRESHOLDS) return THRESHOLDS[kind];
  throw new Error(`tipo de critério desconhecido: ${kind}`);
}

/** Avalia um par de cores. `fg` pode ter alfa; `bg` é opaco. Retorna o valor medido, o limite e PASS/FAIL. */
export function evaluateContrast({ fg, bg, kind, fontSizePx, fontWeight }) {
  const effective = compositeOver(fg, bg);
  const ratio = contrastRatio(effective, bg);
  const required = requiredRatio(kind, { fontSizePx, fontWeight });
  return { ratio: round2(ratio), exact: ratio, required, status: ratio >= required ? STATUS.PASS : STATUS.FAIL, fgEffective: effective.map(Math.round), bg: bg.map(Math.round) };
}
