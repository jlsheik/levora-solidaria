/**
 * M19 — ADAPTADOR do Sonner (única camada que conhece a estrutura interna do DOM do Sonner 1.7.4).
 *
 * Por quê: o Sonner não expõe `role` por aviso, nem tradução do rótulo do botão de fechar, nem o retângulo/estado dos avisos. O app precisa disso para (a) semântica de leitor de tela
 * (erro = `role="alert"`, demais = `role="status"`), (b) rótulo em português e (c) medir o aviso para reservar espaço sob um diálogo. Tudo o que depende de seletores/atributos internos
 * (`data-sonner-*`, `data-close-button`, `data-type`, `data-removed`, `data-visible`, `data-front`) mora SOMENTE aqui; o resto do código chama estas funções.
 *
 * Proteção contra mudança de versão: `SONNER_TESTED_VERSION` + `test/uiSonnerAdapterContract.test.ts` renderizam o Sonner real e falham se a estrutura mudar ou a versão instalada for outra
 * (então a atualização exige revisão deliberada deste arquivo). Não atualizamos o Sonner nesta fase.
 * Limite: nenhuma homologação com leitor de tela real foi feita; a semântica é verificada pela estrutura do DOM.
 */

/** Versão do Sonner contra a qual os seletores abaixo foram verificados. */
export const SONNER_TESTED_VERSION = "1.7.4";

export const SONNER_SELECTORS = {
  region: "section[aria-label]", // contêiner persistente do <Toaster> (aria-live="polite")
  toaster: "[data-sonner-toaster]", // <ol> de uma posição
  toast: "[data-sonner-toast]", // <li> de um aviso
  closeButton: "[data-close-button]",
} as const;

export const CLOSE_LABEL_PT = "Fechar aviso";
const REGION_LABEL_PREFIX = "Avisos"; // `containerAriaLabel` passado ao Toaster; o Sonner acrescenta o atalho ("alt + T") ao rótulo da região

/** A região persistente do toaster deste app (o Sonner a renderiza sempre, mesmo sem avisos). */
export function findRegions(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(SONNER_SELECTORS.region)).filter((el) => (el.getAttribute("aria-label") ?? "").startsWith(REGION_LABEL_PREFIX));
}

export const isToastElement = (n: Node): n is HTMLElement => n.nodeType === 1 && (n as Element).matches(SONNER_SELECTORS.toast);
export const isToastTarget = (n: EventTarget | null): boolean => !!n && typeof (n as Element).closest === "function" && !!(n as Element).closest(SONNER_SELECTORS.toaster);

/** Papel do aviso: erro anuncia na hora (alert); os demais são informativos (status). */
export const toastRole = (type: string | null): "alert" | "status" => (type === "error" ? "alert" : "status");

/** Aplica a semântica a UM aviso. Chamado no mesmo ciclo da inserção (callback do observador, antes da próxima pintura). Idempotente. */
export function applyToastSemantics(li: HTMLElement): void {
  const role = toastRole(li.getAttribute("data-type"));
  if (li.getAttribute("role") !== role) li.setAttribute("role", role);
  li.querySelectorAll<HTMLElement>(SONNER_SELECTORS.closeButton).forEach(relabelCloseButton);
}

/** Sonner 1.7.4 lê `closeButtonAriaLabel` mas não o repassa ao botão: troca o texto em inglês. */
export function relabelCloseButton(b: HTMLElement): void { if (b.getAttribute("aria-label") !== CLOSE_LABEL_PT) b.setAttribute("aria-label", CLOSE_LABEL_PT); }

/** Aplica a semântica a um nó recém-inserido (o próprio aviso ou um subárvore que contém avisos). */
export function applyToNode(node: Node): void {
  if (node.nodeType !== 1) return;
  const el = node as HTMLElement;
  if (el.matches(SONNER_SELECTORS.toast)) applyToastSemantics(el);
  else el.querySelectorAll<HTMLElement>(SONNER_SELECTORS.toast).forEach(applyToastSemantics);
}

/** Avisos visíveis (não removidos) dentro das regiões. */
export function visibleToasts(regions: HTMLElement[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const r of regions) r.querySelectorAll<HTMLElement>(SONNER_SELECTORS.toast).forEach((t) => { if (t.getAttribute("data-removed") !== "true" && t.getAttribute("data-visible") !== "false") out.push(t); });
  return out;
}
export const frontToast = (toasts: HTMLElement[]): HTMLElement | undefined => toasts.find((t) => t.getAttribute("data-front") === "true") ?? toasts[0];
export const hasAnyToast = (regions: HTMLElement[]): boolean => regions.some((r) => r.querySelector(SONNER_SELECTORS.toast));

/** Atributos do DOM do Sonner cuja mudança importa para a medição (estado de saída/visibilidade/posição) ou para a semântica (tipo). */
export const OBSERVED_TOAST_ATTRIBUTES = ["data-removed", "data-visible", "data-front", "data-mounted", "data-type"] as const;
