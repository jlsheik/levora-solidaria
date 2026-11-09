/**
 * M12 — política de duração dos avisos (toasts).
 *
 * Problema (M11): o Sonner usa 4000 ms para qualquer aviso; um erro de ~220 caracteres desaparecia em 4 s, abaixo do que se lê com folga
 * (WCAG 2.2.1 pede tempo suficiente ou controle do usuário; leitura confortável em português fica em torno de 15–18 caracteres/s, menos em celular ou com dificuldade de leitura).
 *
 * Regra (determinística, sem número "mágico" para atingir um alvo):
 *   - tempo de leitura = TOAST_BASE_MS + caracteres × TOAST_MS_PER_CHAR   (≈ 14 caracteres/s + 2 s para localizar o aviso e reagir)
 *   - mínimo de 4000 ms (o padrão anterior, que continua valendo para mensagens curtas) e teto de 20 s;
 *   - erros e avisos importantes têm o dobro de folga de leitura, mínimo de 8 s e teto de 30 s, e nunca são permanentes
 *     (um aviso permanente sob um diálogo modal não teria como ser dispensado por teclado).
 * Duração explícita informada por quem chama continua valendo (ex.: `duration: 12000`) — nada é encurtado.
 * Funções puras; a instalação sobre o objeto `toast` do Sonner fica em `installToastDurations`.
 */

export const TOAST_DEFAULT_MS = 4000;
export const TOAST_BASE_MS = 2000;
export const TOAST_MS_PER_CHAR = 70;
export const TOAST_MAX_MS = 20000;
export const TOAST_IMPORTANT_MIN_MS = 8000;
export const TOAST_IMPORTANT_BASE_MS = 4000;
export const TOAST_IMPORTANT_MS_PER_CHAR = 90;
export const TOAST_IMPORTANT_MAX_MS = 30000;

export type ToastKind = "success" | "info" | "message" | "warning" | "error";
const isImportant = (kind: ToastKind) => kind === "error" || kind === "warning";

/** Duração (ms) para um aviso com `characters` caracteres visíveis (título + descrição). */
export function toastDurationFor(characters: number, kind: ToastKind): number {
  const n = Number.isFinite(characters) && characters > 0 ? Math.floor(characters) : 0;
  if (isImportant(kind)) return Math.min(TOAST_IMPORTANT_MAX_MS, Math.max(TOAST_IMPORTANT_MIN_MS, TOAST_IMPORTANT_BASE_MS + n * TOAST_IMPORTANT_MS_PER_CHAR));
  return Math.min(TOAST_MAX_MS, Math.max(TOAST_DEFAULT_MS, TOAST_BASE_MS + n * TOAST_MS_PER_CHAR));
}

const textLength = (v: unknown): number => (typeof v === "string" ? v.length : typeof v === "number" ? String(v).length : 0);

interface DataLike { duration?: number; description?: unknown; [k: string]: unknown }
type ToastFn = (message: unknown, data?: DataLike) => unknown;
type ToastLike = Record<string, unknown>;

const MARK = "__levoraDurationPolicy";
const ORIGINALS = new WeakMap<object, Partial<Record<ToastKind, ToastFn>>>(); // M19: funções originais, para desinstalar
const KINDS: ToastKind[] = ["success", "info", "message", "warning", "error"];

/** Envolve `toast.success/info/message/warning/error` para aplicar a política quando a chamada não traz `duration`. Idempotente. */
export function installToastDurations(toast: ToastLike): void {
  if ((toast as Record<string, unknown>)[MARK]) return;
  const saved: Partial<Record<ToastKind, ToastFn>> = {};
  for (const kind of KINDS) {
    const original = toast[kind] as ToastFn | undefined;
    if (typeof original !== "function") continue;
    saved[kind] = original;
    toast[kind] = (message: unknown, data?: DataLike) => {
      if (data && typeof data.duration === "number") return original(message, data);
      const chars = textLength(message) + textLength(data?.description);
      return original(message, { ...(data ?? {}), duration: toastDurationFor(chars, kind) });
    };
  }
  ORIGINALS.set(toast, saved);
  (toast as Record<string, unknown>)[MARK] = true;
}

/** M19: desfaz `installToastDurations` (restaura as funções originais). Sem efeito se não estiver instalada. Quem instala é o controlador, com contagem de referências — nunca na importação. */
export function uninstallToastDurations(toast: ToastLike): void {
  const saved = ORIGINALS.get(toast);
  if (!saved || !(toast as Record<string, unknown>)[MARK]) return;
  for (const kind of KINDS) if (saved[kind]) toast[kind] = saved[kind];
  ORIGINALS.delete(toast);
  delete (toast as Record<string, unknown>)[MARK];
}
