/**
 * M11 / R10 (residual) — espaço reservado para os avisos (toasts) quando há um diálogo aberto.
 *
 * Na M10 o toast foi levantado acima do rodapé do diálogo, mas continuou DENTRO do diálogo: a 375 px cobria por inteiro a dica ("Ou, se já tiver uma…") e o campo de link
 * (medido: 100% da área desses elementos nos erros; 202 px de altura no aviso longo). Aqui o diálogo CEDE o espaço: enquanto houver um aviso visível que ocuparia o mesmo trecho
 * horizontal do conteúdo do diálogo, o diálogo é centralizado na região acima da pilha de avisos e o seu `max-height` diminui na mesma medida (o conteúdo rola; o rodapé é fixo).
 * O toast permanece na posição padrão do Sonner, sem cobrir nada do diálogo, e nada é escondido, encurtado ou antecipado.
 *
 * Função pura (sem DOM) para poder ser testada com geometria real medida no navegador. O CSS correspondente está em `Dialog.module.css` (`html[data-toast-reserve]`).
 */

/** Proporção da altura da janela usada como `max-height` do diálogo (mesmo valor de `Dialog.module.css`: 85vh). */
export const DIALOG_MAX_HEIGHT_RATIO = 0.85;
/** Distância entre toasts empilhados no Sonner (px). */
export const SONNER_STACK_GAP = 14;
/** Quantidade de toasts visíveis na pilha recolhida do Sonner. */
export const SONNER_VISIBLE_TOASTS = 3;

export interface ToastReserveInput {
  viewportHeight: number;
  /** Faixa horizontal do CONTEÚDO do diálogo (sem o preenchimento lateral). */
  dialogContent: { left: number; right: number };
  /** Altura natural da caixa do diálogo SEM reserva (px): `min(scrollHeight, 85vh + preenchimento vertical)`. */
  dialogNaturalHeight: number;
  /** Toast da frente: faixa horizontal e altura de layout (sem transformações de animação). */
  toast: { left: number; right: number; height: number };
  /** Quantidade de toasts visíveis (pilha). */
  toastCount: number;
  /** Deslocamento padrão do toast em relação à borda inferior da janela (px). */
  defaultOffset: number;
  /** Espaço mínimo entre o toast e o diálogo (px). */
  gap?: number;
  /** Margem mínima do diálogo em relação às bordas da janela (px). */
  dialogMargin?: number;
  /** Fração da altura da janela abaixo da qual o diálogo não é reduzido (o excedente continua sobrepondo; o aviso some sozinho). */
  minDialogRatio?: number;
}

const overlapsHorizontally = (a: { left: number; right: number }, b: { left: number; right: number }) => Math.min(a.right, b.right) > Math.max(a.left, b.left);

/** Altura (px) da pilha de avisos visíveis, a partir do toast da frente. */
export function toastStackHeight(frontHeight: number, count: number): number {
  const n = Math.max(1, Math.min(count, SONNER_VISIBLE_TOASTS));
  return frontHeight + (n - 1) * SONNER_STACK_GAP;
}

/** Reserva inferior (px, inteiro par) que o diálogo deve ceder aos avisos; 0 = nada muda. */
export function computeToastReserve(input: ToastReserveInput): number {
  const { viewportHeight: vh, dialogContent, dialogNaturalHeight, toast, toastCount, defaultOffset, gap = 8, dialogMargin = 16, minDialogRatio = 0.5 } = input;
  if (toastCount <= 0 || !(toast.height > 0) || !(vh > 0)) return 0;
  if (!overlapsHorizontally(dialogContent, toast)) return 0;
  const need = defaultOffset + toastStackHeight(toast.height, toastCount) + gap;
  // o diálogo (centralizado, sem reserva) só precisa ceder se a sua borda inferior invadir a faixa do aviso
  const naturalBottom = vh / 2 + dialogNaturalHeight / 2;
  if (naturalBottom <= vh - need) return 0;
  const minBox = Math.min(dialogNaturalHeight, vh * minDialogRatio);
  const limit = vh - minBox - 2 * dialogMargin;
  const reserve = Math.min(need, limit);
  if (!(reserve > 0)) return 0;
  const whole = Math.ceil(reserve);
  return whole % 2 === 0 ? whole : whole + 1;
}
