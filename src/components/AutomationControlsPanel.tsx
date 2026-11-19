import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PauseCircle } from "lucide-react";
import { toast } from "sonner";
import { getAutomationControls } from "../endpoints/automation-controls_GET.schema";
import { postAutomationControls } from "../endpoints/automation-controls_POST.schema";
import { getPlatformAutomationControls } from "../endpoints/platform-automation-controls_GET.schema";
import { postPlatformAutomationControls } from "../endpoints/platform-automation-controls_POST.schema";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Textarea } from "./Textarea";
import { Skeleton } from "./Skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import styles from "./AgentOps.module.css";

type Mode = "normal" | "pausada" | "emergencia";
const modeOf = (s: { paused: boolean; emergency: boolean }): Mode => (s.emergency ? "emergencia" : s.paused ? "pausada" : "normal");
const MODE_COPY: Record<Mode, { label: string; tone: "success" | "destructive" | "secondary"; effect: string }> = {
  normal: { label: "Funcionando normalmente", tone: "success", effect: "Os agentes podem usar suas ferramentas, sujeitas às regras de proteção." },
  pausada: { label: "Pausada", tone: "destructive", effect: "Nenhuma ferramenta que MUDA dados executa; leitura e alertas continuam." },
  emergencia: { label: "Modo emergência", tone: "destructive", effect: "Só alertas: nada mais roda até a emergência ser encerrada." },
};

/**
 * Pausar / modo emergência. Escopo `organizacao`: a própria organização (`automacao.gerencie`); escopo `plataforma`: global, só equipe da plataforma. Desligar a pausa da organização não vence uma
 * pausa global. Toda mudança passa por um diálogo de confirmação (com motivo opcional) e é auditada pelo servidor.
 */
export function AutomationControlsPanel({ scope, organizationId, canManage }: { scope: "organizacao" | "plataforma"; organizationId?: number; canManage: boolean }) {
  const queryClient = useQueryClient();
  const isPlatform = scope === "plataforma";
  const key = isPlatform ? ["platform-automation-controls"] : ["automation-controls", organizationId];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      if (isPlatform) { const r = await getPlatformAutomationControls(); return { own: r.global, global: r.global, effectivePaused: r.global.paused, effectiveEmergency: r.global.emergency }; }
      const r = await getAutomationControls({ organizationId: organizationId! });
      return { own: r.organization, global: r.global, effectivePaused: r.paused, effectiveEmergency: r.emergency };
    },
    retry: false,
  });
  const [target, setTarget] = useState<Mode | null>(null);
  const [reason, setReason] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      const paused = target !== "normal"; const emergency = target === "emergencia";
      return isPlatform ? postPlatformAutomationControls({ paused, emergency, reason: reason.trim() || undefined }) : postAutomationControls({ organizationId: organizationId!, paused, emergency, reason: reason.trim() || undefined });
    },
    onSuccess: () => { toast.success(target === "normal" ? "Automação retomada." : target === "pausada" ? "Automação pausada." : "Modo emergência ligado."); close(); queryClient.invalidateQueries({ queryKey: key }); queryClient.invalidateQueries({ queryKey: ["agents"] }); },
    onError: (e) => { setFailure(e instanceof Error ? e.message : "Não foi possível alterar a automação"); queryClient.invalidateQueries({ queryKey: key }); },
  });
  function close() { setTarget(null); setReason(""); setUnderstood(false); setFailure(null); mutation.reset(); }

  const own = query.data?.own; const current = own ? modeOf(own) : null;
  const options: Array<{ mode: Mode; label: string; variant: "outline" | "destructive" | "primary" }> = isPlatform
    ? [{ mode: "normal", label: "Retomar", variant: "primary" }, { mode: "pausada", label: "Pausar tudo", variant: "outline" }, { mode: "emergencia", label: "Modo emergência", variant: "destructive" }]
    : [{ mode: "normal", label: "Retomar", variant: "primary" }, { mode: "pausada", label: "Pausar", variant: "outline" }, { mode: "emergencia", label: "Modo emergência", variant: "destructive" }];
  const needsAck = target === "emergencia" || (isPlatform && target !== null && target !== "normal");

  return (
    <section className={styles.section} aria-labelledby={`controles-${scope}-titulo`} aria-busy={query.isFetching}>
      <h2 id={`controles-${scope}-titulo`} className={styles.sectionTitle}><PauseCircle size={18} aria-hidden="true" /> {isPlatform ? "Automação da plataforma (global)" : "Pausar a automação desta organização"}</h2>
      <p className={styles.help}>{isPlatform ? "A pausa global vale para TODAS as organizações. Só a equipe da plataforma pode alterá-la." : "A pausa vale só para esta organização. Se a plataforma estiver pausada, desligar a pausa aqui não a vence."}</p>
      {query.isError ? (
        <div className={styles.error}>
          <p className={styles.errorText} role="alert">Não foi possível carregar o estado da automação. {query.error instanceof Error ? query.error.message : ""}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>Tentar de novo</Button>
        </div>
      ) : !query.data || !current ? (
        <Skeleton className={styles.skeleton} />
      ) : (
        <>
          <div className={`${styles.banner} ${current !== "normal" ? styles.bannerAttention : ""}`} role="status" aria-live="polite">
            <Badge variant={MODE_COPY[current].tone}>{MODE_COPY[current].label}</Badge>
            <p className={styles.bannerText}>{MODE_COPY[current].effect}{own!.reason ? ` Motivo registrado: “${own!.reason}”.` : ""}</p>
          </div>
          {!isPlatform && query.data.global.paused && (<p className={styles.help} style={{ marginTop: "0.75rem" }}><strong>A plataforma está {query.data.global.emergency ? "em modo emergência" : "pausada"}</strong> para todas as organizações{query.data.global.reason ? `: “${query.data.global.reason}”` : ""}. Isso vale independentemente da sua configuração.</p>)}
          {canManage ? (
            <div className={styles.rowActions} style={{ marginTop: "1rem" }}>
              {options.filter((o) => o.mode !== current).map((o) => (<Button key={o.mode} type="button" size="sm" variant={o.variant} onClick={() => { setTarget(o.mode); setReason(""); setUnderstood(false); setFailure(null); }}>{o.label}…</Button>))}
            </div>
          ) : <p className={styles.help} style={{ marginTop: "0.75rem" }}>Somente leitura para o seu papel.</p>}
        </>
      )}

      <Dialog open={!!target} onOpenChange={(open) => { if (!open && !mutation.isPending) close(); }}>
        <DialogContent>
          {target && (
            <form onSubmit={(ev) => { ev.preventDefault(); if (!needsAck || understood) mutation.mutate(); }} className={styles.form}>
              <DialogHeader>
                <DialogTitle>{target === "normal" ? "Retomar a automação?" : target === "pausada" ? "Pausar a automação?" : "Ligar o modo emergência?"}</DialogTitle>
                <DialogDescription>{isPlatform ? "Alcance: todas as organizações. " : "Alcance: esta organização. "}{MODE_COPY[target].effect}</DialogDescription>
              </DialogHeader>
              <label className={styles.label} htmlFor={`controle-motivo-${scope}`}>Motivo (opcional, fica registrado e visível; sem dados pessoais)</label>
              <Textarea id={`controle-motivo-${scope}`} maxLength={300} value={reason} onChange={(ev) => setReason(ev.target.value)} disabled={mutation.isPending} />
              {needsAck && (<label className={styles.check}><input type="checkbox" checked={understood} onChange={(ev) => setUnderstood(ev.target.checked)} disabled={mutation.isPending} /><span>Entendo que {isPlatform ? "isto afeta todas as organizações" : "os agentes só poderão criar alertas"} até que alguém retome a automação.</span></label>)}
              {failure && <p className={styles.errorText} role="alert">{failure}</p>}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close} disabled={mutation.isPending}>Cancelar</Button>
                <Button type="submit" variant={target === "normal" ? "primary" : "destructive"} disabled={mutation.isPending || (needsAck && !understood)}>{mutation.isPending ? "Salvando..." : target === "normal" ? "Retomar" : target === "pausada" ? "Confirmar pausa" : "Ligar emergência"}</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
