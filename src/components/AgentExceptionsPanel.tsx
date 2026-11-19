import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { getExceptionQueue, type OutputType as QueueOutput } from "../endpoints/exception-queue_GET.schema";
import { postExceptionQueueDecide } from "../endpoints/exception-queue-decide_POST.schema";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Textarea } from "./Textarea";
import { Skeleton } from "./Skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import { EXCEPTION_STATUS_LABEL, TOOL_LABEL, approvalsMissing, eventTypeLabel, fmtDateTime, ruleLabel, runStatusLabel, summarizeRequest, type Tone } from "./agentOpsView";
import styles from "./AgentOps.module.css";

type Exception = QueueOutput["exceptions"][number];
type Status = "pendente" | "aprovada" | "rejeitada";
const STATUS_TABS: Array<{ value: Status; label: string }> = [{ value: "pendente", label: "Pendentes" }, { value: "aprovada", label: "Aprovadas" }, { value: "rejeitada", label: "Rejeitadas" }];
const badge = (tone: Tone) => (tone === "ok" ? "success" : tone === "attention" ? "destructive" : tone === "info" ? "secondary" : "outline") as "success" | "destructive" | "secondary" | "outline";

/**
 * Fila de exceções: a automação parou por uma regra de proteção e uma PESSOA decide. Nada é executado ao aprovar — o agente reexecuta o pedido citando a exceção aprovada (uso único).
 * Aprovar e rejeitar passam por um diálogo de confirmação com justificativa (obrigatória ao rejeitar); dupla autorização exige duas pessoas diferentes (a mesma pessoa não conta duas vezes).
 */
export function AgentExceptionsPanel({ organizationId, canDecide }: { organizationId: number; canDecide: boolean }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>("pendente");
  const [target, setTarget] = useState<{ exception: Exception; decision: "aprovar" | "rejeitar" } | null>(null);
  const [notes, setNotes] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);

  const query = useQuery({ queryKey: ["exception-queue", organizationId, status], queryFn: () => getExceptionQueue({ organizationId, status, limit: 100 }), retry: false });
  const pendingCount = useQuery({ queryKey: ["exception-queue", organizationId, "pendente"], queryFn: () => getExceptionQueue({ organizationId, status: "pendente", limit: 100 }), retry: false, enabled: status !== "pendente" });

  const decide = useMutation({
    mutationFn: () => postExceptionQueueDecide({ organizationId, exceptionId: target!.exception.id, decision: target!.decision, notes: notes.trim() || undefined }),
    onSuccess: (res) => {
      const done = res.exception.status === "pendente" ? `Decisão registrada. Falta ${res.exception.approvalsRequired - res.exception.approvals} aprovação de outra pessoa.` : res.exception.status === "aprovada" ? "Exceção aprovada. Nada foi executado: o agente precisa repetir o pedido." : "Exceção rejeitada.";
      toast.success(done);
      closeDialog();
      queryClient.invalidateQueries({ queryKey: ["exception-queue", organizationId] });
      queryClient.invalidateQueries({ queryKey: ["agents", organizationId] });
    },
    onError: (e) => {
      const message = e instanceof Error ? e.message : "Não foi possível registrar a decisão";
      setConflict(message); // permanece no diálogo (role=alert); a lista é recarregada para refletir o estado real
      queryClient.invalidateQueries({ queryKey: ["exception-queue", organizationId] });
    },
  });
  function closeDialog() { setTarget(null); setNotes(""); setConflict(null); decide.reset(); }

  const rejecting = target?.decision === "rejeitar";

  return (
    <section className={styles.section} aria-labelledby="excecoes-titulo" aria-busy={query.isFetching}>
      <h2 id="excecoes-titulo" className={styles.sectionTitle}><ShieldAlert size={18} aria-hidden="true" /> Fila de exceções</h2>
      <p className={styles.help}>
        Quando uma regra de proteção interrompe um agente, a ação fica aqui à espera de uma pessoa. <strong>Aprovar não executa nada</strong>: a aprovação vale uma única vez, para o mesmo agente, a mesma ferramenta e o mesmo pedido.
        Exceções de <strong>dupla autorização</strong> precisam de duas pessoas diferentes; qualquer rejeição encerra a exceção.
      </p>
      <div className={styles.chips} role="group" aria-label="Filtrar exceções por situação" style={{ marginBottom: "1rem" }}>
        {STATUS_TABS.map((t) => (
          <button key={t.value} type="button" className={`${styles.chip} ${status === t.value ? styles.chipActive : ""}`} aria-pressed={status === t.value} onClick={() => setStatus(t.value)}>
            {t.label}{t.value === "pendente" && (status === "pendente" ? query.data : pendingCount.data) ? ` (${(status === "pendente" ? query.data : pendingCount.data)!.exceptions.length})` : ""}
          </button>
        ))}
      </div>

      {query.isError ? (
        <div className={styles.error}>
          <p className={styles.errorText} role="alert">Não foi possível carregar a fila. {query.error instanceof Error ? query.error.message : ""}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>Tentar de novo</Button>
        </div>
      ) : !query.data ? (
        <Skeleton className={styles.skeleton} />
      ) : query.data.exceptions.length === 0 ? (
        <p className={styles.empty} role="status">{status === "pendente" ? "Nenhuma exceção aguardando decisão. Quando uma regra de proteção interromper um agente, o pedido aparecerá aqui." : `Nenhuma exceção ${status === "aprovada" ? "aprovada" : "rejeitada"} no período carregado.`}</p>
      ) : (
        <ul className={styles.list} aria-label={`Exceções ${EXCEPTION_STATUS_LABEL[status].label.toLowerCase()}`}>
          {query.data.exceptions.map((e) => {
            const rule = ruleLabel(e.ruleCode);
            const st = EXCEPTION_STATUS_LABEL[e.status] ?? { label: e.status, tone: "neutral" as Tone };
            const missing = approvalsMissing(e);
            const request = summarizeRequest(e.request);
            return (
              <li key={e.id} className={`${styles.row} ${e.status === "pendente" ? styles.rowAttention : ""}`}>
                <div className={styles.rowMain}>
                  <h3 className={styles.rowTitle}>{rule.title} <Badge variant={badge(st.tone)}>{st.label}</Badge> <Badge variant={e.approvalsRequired === 2 ? "destructive" : "secondary"}>{e.approvalsRequired === 2 ? "Dupla autorização" : "Revisão de uma pessoa"}</Badge></h3>
                  <p className={styles.rowText}>{rule.help}</p>
                  <span className={styles.rowMeta}>Agente: {e.agentName} · ferramenta: {TOOL_LABEL[e.toolName] ?? e.toolName} · regra {e.ruleCode} · aberta em {fmtDateTime(e.createdAt)}{e.consumedAt ? ` · usada em ${fmtDateTime(e.consumedAt)}` : ""}</span>
                  {e.run && <span className={styles.rowMeta}>Origem: {eventTypeLabel(e.run.eventType)} (execução #{e.run.id}) · estado da execução: <strong>{runStatusLabel(e.run.status).label}</strong>{e.run.status === "autorizado_simulacao" ? " — aprovado; falta o motor concluir a simulação (nada é executado fora do sistema)" : ""}</span>}
                  {e.approvalsRequired === 2 && e.status === "pendente" && <span className={styles.progress}>Aprovações: {e.approvals} de {e.approvalsRequired}{missing > 0 ? ` — falta ${missing} de outra pessoa` : ""}</span>}
                  {request.length > 0 && (
                    <dl className={styles.kv} aria-label="Resumo do pedido">
                      {request.map((r) => (<React.Fragment key={r.key}><dt>{r.key}</dt><dd>{r.value}</dd></React.Fragment>))}
                    </dl>
                  )}
                  {e.decisions.length > 0 && (
                    <ul className={styles.history} aria-label="Histórico de decisões">
                      {e.decisions.map((d, i) => (<li key={i}>{d.byYou ? "Você" : d.userDisplayName} {d.decision === "aprovar" ? "aprovou" : "rejeitou"} em {fmtDateTime(d.decidedAt)}{d.notes ? ` — “${d.notes}”` : ""}</li>))}
                    </ul>
                  )}
                </div>
                {e.status === "pendente" && (
                  <div className={styles.rowActions}>
                    {canDecide ? (
                      e.myDecision ? <span className={styles.rowMeta} role="status">Você já {e.myDecision === "aprovar" ? "aprovou" : "rejeitou"} — aguarde outra pessoa.</span> : (
                        <>
                          <Button type="button" size="sm" onClick={() => { setTarget({ exception: e, decision: "aprovar" }); setNotes(""); setConflict(null); }}>Aprovar…</Button>
                          <Button type="button" size="sm" variant="outline" onClick={() => { setTarget({ exception: e, decision: "rejeitar" }); setNotes(""); setConflict(null); }}>Rejeitar…</Button>
                        </>
                      )
                    ) : <span className={styles.rowMeta}>Somente leitura para o seu papel.</span>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={!!target} onOpenChange={(open) => { if (!open && !decide.isPending) closeDialog(); }}>
        <DialogContent>
          {target && (
            <form onSubmit={(ev) => { ev.preventDefault(); decide.mutate(); }} className={styles.form}>
              <DialogHeader>
                <DialogTitle>{rejecting ? "Rejeitar esta exceção?" : "Aprovar esta exceção?"}</DialogTitle>
                <DialogDescription>
                  {ruleLabel(target.exception.ruleCode).title} · agente {target.exception.agentName}. {rejecting ? "A rejeição encerra a exceção e o pedido não poderá ser executado." : target.exception.approvalsRequired === 2 ? "Esta exceção exige duas pessoas diferentes; a sua é a decisão registrada agora." : "A aprovação libera UMA reexecução do mesmo pedido; nada é executado agora."}
                </DialogDescription>
              </DialogHeader>
              <label className={styles.label} htmlFor="excecao-justificativa">Justificativa (opcional, mas recomendada: fica no histórico visível a quem lê a fila; sem dados pessoais)</label>
              <Textarea id="excecao-justificativa" maxLength={500} value={notes} onChange={(ev) => setNotes(ev.target.value)} disabled={decide.isPending} />
              {conflict && <p className={styles.errorText} role="alert">{conflict} A lista foi atualizada; confira o estado atual antes de tentar de novo.</p>}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={closeDialog} disabled={decide.isPending}>Cancelar</Button>
                <Button type="submit" variant={rejecting ? "destructive" : "primary"} disabled={decide.isPending}>{decide.isPending ? "Registrando..." : rejecting ? "Confirmar rejeição" : "Confirmar aprovação"}</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
