"use client";

import { useEffect } from "react";
import { Toaster as Sonner, toast } from "sonner";
import styles from "./SonnerToaster.module.css";
import { computeToastReserve, DIALOG_MAX_HEIGHT_RATIO } from "./toastReserve";
import { installToastDurations } from "./toastPolicy";

// M12: duração proporcional ao texto (ver toastPolicy.ts); roda uma vez, antes de qualquer aviso (o toaster faz parte dos provedores globais).
installToastDurations(toast as unknown as Record<string, unknown>);

type ToasterProps = React.ComponentProps<typeof Sonner>;

/** Deslocamento padrão da borda inferior (px): o mesmo do Sonner (mobile 16, desktop 32). */
const defaultOffsetFor = (viewportWidth: number) => (viewportWidth <= 600 ? 16 : 32);

/**
 * M11 / R10: enquanto um diálogo (`Dialog`, marcado com `data-toast-aware`) está aberto e há um aviso visível que cobriria o conteúdo dele, o diálogo cede a faixa inferior da janela
 * ao aviso: o atributo `data-toast-reserve` e a variável `--toast-reserve` no <html> fazem o CSS do diálogo centralizar-se acima dos avisos e reduzir o `max-height` (ver `toastReserve.ts`).
 * O toast fica na posição padrão do Sonner; nada é escondido nem encurtado. Sem diálogo, ou sem sobreposição, nada muda.
 */
function useDialogToastReserve() {
  useEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    const apply = (reserve: number) => {
      if (reserve > 0) {
        if (root.style.getPropertyValue("--toast-reserve") !== `${reserve}px`) root.style.setProperty("--toast-reserve", `${reserve}px`);
        if (!root.hasAttribute("data-toast-reserve")) root.setAttribute("data-toast-reserve", "");
      } else {
        if (root.style.getPropertyValue("--toast-reserve")) root.style.removeProperty("--toast-reserve");
        if (root.hasAttribute("data-toast-reserve")) root.removeAttribute("data-toast-reserve");
      }
    };
    const measure = () => {
      frame = 0;
      const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][data-toast-aware]');
      const dialog = dialogs.length ? dialogs[dialogs.length - 1] : null; // diálogo mais interno
      const toasts = Array.from(document.querySelectorAll<HTMLElement>('[data-sonner-toast]')).filter((t) => t.getAttribute("data-removed") !== "true" && t.getAttribute("data-visible") !== "false");
      if (!dialog || !toasts.length) { apply(0); return; }
      const front = toasts.find((t) => t.getAttribute("data-front") === "true") ?? toasts[0];
      const fr = front.getBoundingClientRect(); // horizontal não é afetado pela animação vertical; a altura vem do layout (offsetHeight)
      const cs = getComputedStyle(dialog);
      const dr = dialog.getBoundingClientRect();
      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const vh = window.innerHeight;
      const reserve = computeToastReserve({
        viewportHeight: vh,
        dialogContent: { left: dr.left + (parseFloat(cs.paddingLeft) || 0), right: dr.right - (parseFloat(cs.paddingRight) || 0) },
        dialogNaturalHeight: Math.min(dialog.scrollHeight, DIALOG_MAX_HEIGHT_RATIO * vh + padY),
        toast: { left: fr.left, right: fr.right, height: front.offsetHeight },
        toastCount: toasts.length,
        defaultOffset: defaultOffsetFor(window.innerWidth),
      });
      apply(reserve);
    };
    /**
     * M13: sob um Dialog modal o foco fica preso no diálogo (Radix) e o aviso não é alcançável por Tab. Atalho de teclado que NÃO move o foco: Alt+T (o mesmo do Sonner para focar os avisos)
     * dispensa os avisos enquanto houver um Dialog aberto. Fora de um Dialog o Alt+T continua sendo o do Sonner (foca a região; Tab chega ao botão "Fechar aviso"). Esc continua fechando só o diálogo.
     */
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyT")) return;
      if (!document.querySelector('[role="dialog"][data-toast-aware]') || !document.querySelector("[data-sonner-toast]")) return;
      e.preventDefault(); e.stopPropagation(); toast.dismiss();
    };
    const HINT = "Atalho do teclado: Alt+T. Com um diálogo aberto, dispensa os avisos; fora dele, move o foco para os avisos.";
    const hintStyle = "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0";
    /** Avisos de erro recebem role="alert" (anúncio imediato) e todo aviso ganha o texto do atalho, só para tecnologia assistiva. */
    const semantics = () => document.querySelectorAll<HTMLElement>("[data-sonner-toaster] [data-sonner-toast]").forEach((li) => {
      const type = li.getAttribute("data-type"); const role = type === "error" ? "alert" : "status"; if (li.getAttribute("role") !== role) li.setAttribute("role", role);
      if (!li.querySelector("[data-toast-hint]")) { const s = document.createElement("span"); s.setAttribute("data-toast-hint", ""); s.setAttribute("style", hintStyle); s.textContent = HINT; (li.querySelector("[data-content]") ?? li).appendChild(s); }
    });
    /** Sonner 1.7.4 não deixa traduzir o rótulo do botão de fechar (closeButtonAriaLabel é lido, mas não repassado): troca o texto em inglês pelo equivalente em português. */
    const relabel = () => document.querySelectorAll<HTMLElement>("[data-sonner-toaster] [data-close-button]").forEach((b) => { if (b.getAttribute("aria-label") !== "Fechar aviso") b.setAttribute("aria-label", "Fechar aviso"); });
    const schedule = () => { relabel(); semantics(); if (!frame) frame = window.requestAnimationFrame(measure); };
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state", "data-removed", "data-visible", "data-front", "data-mounted"] });
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    // M12: o aviso entra deslizando na horizontal (`slideIn`); medido logo no início da animação ele ainda está fora da coluna do diálogo e nenhuma mutação posterior dispara nova medição
    // (observado no navegador: a 1280 px, com dois avisos, a reserva não era aplicada). Ao fim de cada animação/transição o retângulo é o final: medir de novo.
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("animationend", schedule, true);
    document.addEventListener("transitionend", schedule, true);
    schedule();
    return () => {
      mutation.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("animationend", schedule, true);
      document.removeEventListener("transitionend", schedule, true);
      if (frame) window.cancelAnimationFrame(frame);
      apply(0);
    };
  }, []);
}

/**
 * This is already included in the global context providers so should not be rendered again.
 */
export const SonnerToaster = ({ className, ...props }: ToasterProps) => {
  useDialogToastReserve();
  return (
    <Sonner
      className={`${styles.toaster} ${className ?? ""}`}
      closeButton
      pauseWhenPageIsHidden
      containerAriaLabel="Avisos"
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: styles.toast,
          content: styles.content,
          title: styles.title,
          actionButton: styles.actionButton,
          cancelButton: styles.cancelButton,
          closeButton: styles.closeButton,
          description: styles.description,
          icon: styles.icon,
        },
      }}
      {...props}
    />
  );
};
