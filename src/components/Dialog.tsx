"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import styles from "./Dialog.module.css"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={`${styles.overlay} ${className || ''}`}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Render the dialog into this element instead of document.body. */
  container?: React.ComponentPropsWithoutRef<
    typeof DialogPrimitive.Portal
  >["container"];
}

/** M12: o aviso (toast) fica fora do diálogo no DOM; interagir com ele (ex.: o botão "Fechar aviso") não pode fechar o diálogo por "interação externa". */
const isToastTarget = (event: { target: EventTarget | null; detail?: { originalEvent?: Event } }) => {
  const t = (event.detail?.originalEvent?.target ?? event.target) as Element | null;
  return !!t && typeof t.closest === "function" && !!t.closest("[data-sonner-toaster]");
};

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, container, ...props }, ref) => (
  <DialogPortal container={container}>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={`${styles.content} ${className || ''}`}
      data-toast-aware="" // M11: o toaster cede a faixa inferior da janela a este diálogo (ver toastReserve.ts)
      {...props}
      onInteractOutside={(event) => {
        if (isToastTarget(event as unknown as { target: EventTarget | null; detail?: { originalEvent?: Event } })) event.preventDefault();
        props.onInteractOutside?.(event);
      }}
    >
      {children}
      <DialogPrimitive.Close className={styles.close}>
        <X className={styles.closeIcon} />
        <span className={styles.screenReaderText}>Fechar</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={`${styles.header} ${className || ''}`}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={`${styles.footer} ${className || ''}`}
    data-dialog-footer="" // marcador do rodapé de ações (usado pelas sondas do QA visual)
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={`${styles.title} ${className || ''}`}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={`${styles.description} ${className || ''}`}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}

