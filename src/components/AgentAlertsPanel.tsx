import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing } from "lucide-react";
import { toast } from "sonner";
import { getIntegrityAlerts, type OutputType as AlertsOutput } from "../endpoints/integrity-alerts_GET.schema";
import { postIntegrityAlertsUpdate } from "../endpoints/integrity-alerts-update_POST.schema";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Textarea } from "./Textarea";
import { Skeleton } from "./Skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import { ALERT_LEVEL_LABEL, ALERT_STATUS_LABEL, fmtDateTime, type Tone } from "./agentOpsView";
import styles from "./AgentOps.module.css";

type Alert = AlertsOutput["alerts"][number];
type Filter = "abertos" | "resolvido" | "descartado";
const FILTERS: Array<{ value: Filter; label: string }> = [{ value: "abertos", label: "Em aberto" }, { value: "resolvido", label: "Resolvidos" }, { value: "descartado", label: "Descartados" }];
const badge = (tone: Tone) => (tone === "ok" ? "success" : tone === "attention" ? "destructive" : tone === "info" ? "secondary" : "outline") as "success" | "destructive" | "secondary" | "outline";
const ACTION_COPY = {
  reconhecer: { title: "Reconhecer este alerta?", body: "Marca que uma pessoa viu o alerta. Ele continua em aberto até ser resolvido ou descartado.", confirm: "Reconhecer", noteRequired: false },
  resolver: { title: "Marcar como resolvido?", body: "Use quando a causa foi tratada. Registrar o que foi feito ajuda quem vier depois.", confirm: "Marcar como resolvido", noteRequired: false },
  descartar: { title: "Descartar este alerta?", body: "Use quando o alerta não procede. Registrar o motivo é recomendado; um novo alerta igual poderá ser criado depois.", confirm: "Descartar alerta", noteRequired: false },
} as const;

/** Centro de alertas de integridade: avisos para uma PESSOA, nunca acusação nem correção automática. Reconhecer, resolver e descartar são auditados; resolver/descartar pedem uma nota. */
export function AgentAlertsPanel({ organizationId, canManage }: { organizationId: number; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("abertos");
  const [target, setTarget] = useState<{ alert: Alert; action: keyof typeof ACTION_COPY } | null>(null);
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const query = useQuery({ queryKey: ["integrity-alerts", organizationId, filter], queryFn: () => getIntegrityAlerts({ organizationId, status: filter === "abertos" ? undefined : filter, limit: 100 }), retry: false });
  const mutation = useMutation({
    mutationFn: () => postIntegrityAlertsUpdate({ organizationId, alertId: target!.alert.id, action: target!.action, note: note.trim() || undefined }),
    onSuccess: () => {
      toast.success(target!.action === "reconhecer" ? "Alerta reconhecido." : target!.action === "resolver" ? "Alerta marcado como resolvido." : "Alerta descartado.");
      close();
      queryClient.invalidateQueries({ queryKey: ["integrity-alerts", organizationId] });
      queryClient.invalidateQueries({ queryKey: ["agents", organizationId] });
    },
    onError: (e) => { setFailure(e instanceof Error ? e.message : "Não foi possível atualizar o alerta"); queryClient.invalidateQueries({ queryKey: ["integrity-alerts", organizationId] }); },
  });
  function close() { setTarget(null); setNote(""); setFailure(null); mutation.reset(); }
  const copy = target ? ACTION_COPY[target.action] : null;

  return (
    <section className={styles.section} aria-labelledby="alertas-titulo" aria-busy={query.isFetching}>
      <h2 id="alertas-titulo" className={styles.sectionTitle}><BellRing size={18} aria-hidden="true" /> Alertas de integridade</h2>
      <p className={styles.help}>Avisos criados pelos agentes para uma pessoa avaliar. Um alerta <strong>não é uma acusação</strong> e nenhum agente corrige nada sozinho. Enquanto um alerta está aberto, o mesmo aviso não é repetido.</p>
      <div className={styles.chips} role="group" aria-label="Filtrar alertas por situação" style={{ marginBottom: "1rem" }}>
        {FILTERS.map((f) => (<button key={f.value} type="button" className={`${styles.chip} ${filter === f.value ? styles.chipActive : ""}`} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>{f.label}</button>))}
      </div>
      {query.isError ? (
        <div className={styles.error}>
          <p className={styles.errorText} role="alert">Não foi possível carregar os alertas. {query.error instanceof Error ? query.error.message : ""}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>Tentar de novo</Button>
        </div>
      ) : !query.data ? (
        <Skeleton className={styles.skeleton} />
      ) : query.data.alerts.length === 0 ? (
        <p className={styles.empty} role="status">{filter === "abertos" ? "Nenhum alerta em aberto." : filter === "resolvido" ? "Nenhum alerta resolvido no período carregado." : "Nenhum alerta descartado no período carregado."}</p>
      ) : (
        <ul className={styles.list} aria-label="Alertas">
          {query.data.alerts.map((a) => {
            const lvl = ALERT_LEVEL_LABEL[a.level] ?? { label: a.level, tone: "neutral" as Tone };
            const st = ALERT_STATUS_LABEL[a.status] ?? { label: a.status, tone: "neutral" as Tone };
            const open = a.status === "aberto" || a.status === "reconhecido";
            return (
              <li key={a.id} className={`${styles.row} ${open && lvl.tone === "attention" ? styles.rowAttention : ""}`}>
                <div className={styles.rowMain}>
                  <h3 className={styles.rowTitle}>{a.title} <Badge variant={badge(lvl.tone)}>{lvl.label}</Badge> <Badge variant={badge(st.tone)}>{st.label}</Badge></h3>
                  <span className={styles.rowMeta}>Categoria {a.category} · {a.agentName ? `agente ${a.agentName}` : "origem sem agente"} · criado em {fmtDateTime(a.createdAt)}{a.acknowledgedAt ? ` · reconhecido em ${fmtDateTime(a.acknowledgedAt)}` : ""}{a.resolvedAt ? ` · encerrado em ${fmtDateTime(a.resolvedAt)}` : ""}{a.entityType ? ` · ${a.entityType} ${a.entityId ?? ""}` : ""}</span>
                  {a.resolutionNote && <p className={styles.rowText}>Nota: {a.resolutionNote}</p>}
                </div>
                {open && canManage && (
                  <div className={styles.rowActions}>
                    {a.status === "aberto" && <Button type="button" size="sm" variant="outline" onClick={() => { setTarget({ alert: a, action: "reconhecer" }); setNote(""); }}>Reconhecer…</Button>}
                    <Button type="button" size="sm" onClick={() => { setTarget({ alert: a, action: "resolver" }); setNote(""); }}>Resolver…</Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => { setTarget({ alert: a, action: "descartar" }); setNote(""); }}>Descartar…</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={!!target} onOpenChange={(open) => { if (!open && !mutation.isPending) close(); }}>
        <DialogContent>
          {target && copy && (
            <form onSubmit={(ev) => { ev.preventDefault(); mutation.mutate(); }} className={styles.form}>
              <DialogHeader><DialogTitle>{copy.title}</DialogTitle><DialogDescription>{target.alert.title} — {copy.body}</DialogDescription></DialogHeader>
              <label className={styles.label} htmlFor="alerta-nota">Nota (opcional, mas recomendada; fica visível a quem lê o alerta; sem dados pessoais)</label>
              <Textarea id="alerta-nota" maxLength={500} value={note} onChange={(ev) => setNote(ev.target.value)} disabled={mutation.isPending} />
              {failure && <p className={styles.errorText} role="alert">{failure}</p>}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close} disabled={mutation.isPending}>Cancelar</Button>
                <Button type="submit" variant={target.action === "descartar" ? "destructive" : "primary"} disabled={mutation.isPending}>{mutation.isPending ? "Salvando..." : copy.confirm}</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
