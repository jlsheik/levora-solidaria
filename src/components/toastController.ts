/**
 * M19 — controlador dos avisos (singleton com contagem de referências).
 *
 * Substitui o efeito que vivia dentro de `SonnerToaster.tsx`. Correções da M18:
 *  - O observador NÃO olha mais o `<body>` inteiro com `subtree`: a aplicação inteira vive sob o body e cada mutação alheia disparava varreduras síncronas do documento.
 *    Agora (a) observa só as REGIÕES do toaster (subárvore pequena e persistente do Sonner) e (b) observa o `<body>` apenas com `childList` SEM `subtree` (abrir/fechar um diálogo
 *    em portal é um filho direto do body). Atributos/nós alheios ao toaster nem chegam ao callback.
 *  - Papel (`role`) e rótulo do botão de fechar são aplicados no callback do observador, SÓ nos nós inseridos (sem `querySelectorAll` no documento), no mesmo ciclo da inserção.
 *  - A medição (leitura de layout) continua em `requestAnimationFrame`, agora só quando algo do toaster/diálogo mudou; eventos globais de animação são filtrados pelo alvo.
 *  - O texto do atalho por aviso foi removido: a região já é `aria-live="polite"` e o Sonner inclui o atalho ("alt + T") no rótulo dela; o comportamento sob diálogo fica documentado.
 *  - Um único conjunto de ouvintes/observadores para N instâncias; tudo é desfeito quando a última referência sai; a política de duração é instalada na 1ª referência e DESINSTALADA na última
 *    (nenhum efeito colateral na importação do módulo).
 * Toda a dependência da estrutura interna do Sonner fica em `sonnerAdapter.ts`.
 */
import { toast } from "sonner";
import { computeToastReserve, DIALOG_MAX_HEIGHT_RATIO } from "./toastReserve";
import { installToastDurations, uninstallToastDurations } from "./toastPolicy";
import { OBSERVED_TOAST_ATTRIBUTES, applyToNode, applyToastSemantics, frontToast, hasAnyToast, isToastElement, isToastTarget, visibleToasts } from "./sonnerAdapter";

const DIALOG_SELECTOR = '[role="dialog"][data-toast-aware]';
/** Deslocamento padrão da borda inferior (px): o mesmo do Sonner (mobile 16, desktop 32). */
const defaultOffsetFor = (viewportWidth: number) => (viewportWidth <= 600 ? 16 : 32);

interface State {
  regions: Set<HTMLElement>;
  refs: number;
  frame: number;
  regionObserver: MutationObserver | null;
  bodyObserver: MutationObserver | null;
  teardown: (() => void) | null;
  stats: { measures: number; observerCallbacks: number };
}
const state: State = { regions: new Set(), refs: 0, frame: 0, regionObserver: null, bodyObserver: null, teardown: null, stats: { measures: 0, observerCallbacks: 0 } };

/** Contadores para testes/medição (não fazem parte do comportamento). */
export const toastControllerStats = () => ({ ...state.stats, refs: state.refs, regions: state.regions.size });

function applyReserve(root: HTMLElement, reserve: number) {
  if (reserve > 0) {
    if (root.style.getPropertyValue("--toast-reserve") !== `${reserve}px`) root.style.setProperty("--toast-reserve", `${reserve}px`);
    if (!root.hasAttribute("data-toast-reserve")) root.setAttribute("data-toast-reserve", "");
  } else {
    if (root.style.getPropertyValue("--toast-reserve")) root.style.removeProperty("--toast-reserve");
    if (root.hasAttribute("data-toast-reserve")) root.removeAttribute("data-toast-reserve");
  }
}

function measure() {
  state.frame = 0; state.stats.measures++;
  const root = document.documentElement;
  const dialogs = document.querySelectorAll<HTMLElement>(DIALOG_SELECTOR);
  const dialog = dialogs.length ? dialogs[dialogs.length - 1] : null; // diálogo mais interno
  if (!dialog) { applyReserve(root, 0); return; }
  const regions = Array.from(state.regions);
  const toasts = visibleToasts(regions);
  if (!toasts.length) { applyReserve(root, 0); return; }
  const front = frontToast(toasts)!;
  const fr = front.getBoundingClientRect(); // horizontal não é afetado pela animação vertical; a altura vem do layout (offsetHeight)
  const cs = getComputedStyle(dialog);
  const dr = dialog.getBoundingClientRect();
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const vh = window.innerHeight;
  applyReserve(root, computeToastReserve({
    viewportHeight: vh,
    dialogContent: { left: dr.left + (parseFloat(cs.paddingLeft) || 0), right: dr.right - (parseFloat(cs.paddingRight) || 0) },
    dialogNaturalHeight: Math.min(dialog.scrollHeight, DIALOG_MAX_HEIGHT_RATIO * vh + padY),
    toast: { left: fr.left, right: fr.right, height: front.offsetHeight },
    toastCount: toasts.length,
    defaultOffset: defaultOffsetFor(window.innerWidth),
  }));
}
const schedule = () => { if (!state.frame) state.frame = window.requestAnimationFrame(measure); };

function onRegionMutations(records: MutationRecord[]) {
  state.stats.observerCallbacks++;
  for (const r of records) {
    if (r.type === "childList") r.addedNodes.forEach(applyToNode);
    else if (r.type === "attributes" && r.attributeName === "data-type" && isToastElement(r.target)) applyToastSemantics(r.target);
  }
  schedule();
}

/**
 * M13: sob um Dialog modal o foco fica preso no diálogo (Radix) e o aviso não é alcançável por Tab. Atalho de teclado que NÃO move o foco: Alt+T (o mesmo do Sonner para focar os avisos)
 * dispensa os avisos enquanto houver um Dialog aberto. Fora de um Dialog o Alt+T continua sendo o do Sonner. Esc continua fechando só o diálogo.
 */
function onKeyDown(e: KeyboardEvent) {
  if (!(e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyT")) return;
  if (!document.querySelector(DIALOG_SELECTOR) || !hasAnyToast(Array.from(state.regions))) return;
  e.preventDefault(); e.stopPropagation(); toast.dismiss();
}
/** M12: ao fim de cada animação/transição do aviso (ou do diálogo) o retângulo é o final: medir de novo. Animações alheias são ignoradas. */
function onAnimationEnd(e: Event) {
  const t = e.target as Element | null;
  if (isToastTarget(t) || (t && typeof t.closest === "function" && t.closest(DIALOG_SELECTOR))) schedule();
}

function start() {
  installToastDurations(toast as unknown as Record<string, unknown>);
  state.regionObserver = new MutationObserver(onRegionMutations);
  state.bodyObserver = new MutationObserver(() => schedule()); // abrir/fechar diálogo em portal = filho direto do body; SEM subtree
  state.bodyObserver.observe(document.body, { childList: true });
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("animationend", onAnimationEnd, true);
  document.addEventListener("transitionend", onAnimationEnd, true);
  state.teardown = () => {
    state.regionObserver?.disconnect(); state.bodyObserver?.disconnect(); state.regionObserver = null; state.bodyObserver = null;
    window.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("resize", schedule);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("animationend", onAnimationEnd, true);
    document.removeEventListener("transitionend", onAnimationEnd, true);
    if (state.frame) window.cancelAnimationFrame(state.frame);
    state.frame = 0;
    applyReserve(document.documentElement, 0);
    uninstallToastDurations(toast as unknown as Record<string, unknown>);
  };
}

/** Registra uma região do toaster; devolve a função que a libera. A 1ª referência liga tudo; a última desfaz tudo. */
export function acquireToastController(region: HTMLElement | null): () => void {
  if (typeof document === "undefined") return () => {};
  if (state.refs === 0) start();
  state.refs++;
  if (region && !state.regions.has(region)) {
    state.regions.add(region);
    state.regionObserver!.observe(region, { childList: true, subtree: true, attributes: true, attributeFilter: [...OBSERVED_TOAST_ATTRIBUTES] });
    applyToNode(region); // avisos que já existiam
  }
  schedule();
  let released = false;
  return () => {
    if (released) return; released = true;
    if (region) state.regions.delete(region);
    state.refs--;
    if (state.refs === 0) { state.teardown?.(); state.teardown = null; state.regions.clear(); }
    else if (state.regionObserver) { // reobserva só as regiões restantes
      state.regionObserver.disconnect();
      state.regions.forEach((r) => state.regionObserver!.observe(r, { childList: true, subtree: true, attributes: true, attributeFilter: [...OBSERVED_TOAST_ATTRIBUTES] }));
    }
  };
}
