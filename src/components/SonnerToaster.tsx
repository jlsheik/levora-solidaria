"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { Toaster as Sonner } from "sonner";
import styles from "./SonnerToaster.module.css";
import { acquireToastController } from "./toastController";
import { findRegions } from "./sonnerAdapter";

// M19: não há mais efeito colateral na importação. A política de duração (M12), a reserva de espaço sob diálogos (M11/R10), o Alt+T (M13) e a semântica dos avisos são ligados pelo
// controlador (toastController.ts) quando o toaster monta e desligados quando a última instância desmonta. O Sonner só é tocado por sonnerAdapter.ts.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * This is already included in the global context providers so should not be rendered again.
 */
export const SonnerToaster = ({ className, ...props }: ToasterProps) => {
  const mark = useRef<HTMLSpanElement>(null);
  useIsoLayoutEffect(() => {
    // O <section> do Sonner é renderizado SEMPRE (antes de qualquer aviso) e já está no DOM neste ponto. Ele é irmão do marcador; o controlador só observa a região, nunca o <body> inteiro.
    const region = mark.current?.previousElementSibling instanceof HTMLElement && mark.current.previousElementSibling.matches("section") ? mark.current.previousElementSibling : (findRegions()[0] ?? null);
    return acquireToastController(region);
  }, []);
  return (
    <>
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
      <span ref={mark} hidden data-toaster-mark="" />
    </>
  );
};
