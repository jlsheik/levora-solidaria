import React, { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { toast } from "sonner";
import { postAgentEventReevaluate } from "../endpoints/agent-event-reevaluate_POST.schema";
import type { OpportunityAssessment } from "../endpoints/opportunities_GET.schema";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Input } from "./Input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import { REEVALUATION_BLOCK_TEXT, decisionLabel } from "./agentOpsView";
import { REEVALUATION_STATE_TEXT, assessmentSummary } from "./opportunityCategoryView";
import styles from "./OpportunityAgent.module.css";

const badge = (tone: string) => (tone === "ok" ? "success" : tone === "attention" ? "destructive" : tone === "info" ? "secondary" : "outline") as "success" | "destructive" | "secondary" | "outline";

/**
 * Situação da avaliação do Risk Engine NA lista de oportunidades (só para quem lê a automação). Mostra o estado em texto, avisa quando a categoria corrigida já permite nova análise, permite pedi-la
 * (permissão de automação, verificada no servidor) e leva à justificativa completa. Tudo é simulação: nada é executado fora do sistema.
 */
export function OpportunityAssessmentBox({ organizationId, opportunityId, assessment, canRequest, justificationHref, onOpenJustification, traceHref, onOpenTrace }: { organizationId: number; opportunityId: number; assessment: OpportunityAssessment; canRequest: boolean; justificationHref: string; onOpenJustification?: () => void; /** M38: rastreabilidade e auditoria desta oportunidade (só para quem lê a auditoria). */ traceHref?: string; onOpenTrace?: () => void }) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false); const [reason, setReason] = useState(""); const [error, setError] = useState<string | null>(null);
  const s = assessmentSummary(assessment);
  const reeval = useMutation({
    mutationFn: () => postAgentEventReevaluate({ organizationId, runId: assessment.runId, reason: reason.trim() || undefined }),
    onSuccess: (r) => {
      toast.success(r.newStatus === "simulacao_concluida" ? "Nova análise concluída (simulação)." : r.newStatus === "aguardando_aprovacao" ? "Nova análise concluída: agora aguarda a decisão de uma pessoa." : "Nova análise registrada.");
      setConfirm(false); setReason(""); setError(null);
      for (const key of ["opportunities", "agent-events", "agent-event-detail", "agents", "exception-queue", "integrity-alerts"]) queryClient.invalidateQueries({ queryKey: [key, organizationId] });
    },
    onError: (e) => { setError(e instanceof Error ? e.message : "Não foi possível solicitar a nova análise"); queryClient.invalidateQueries({ queryKey: ["opportunities", organizationId] }); },
  });

  return (
    <div className={`${styles.assessmentBox} ${s.tone === "attention" ? styles.assessmentAttention : ""}`} aria-label={`Avaliação do Risk Engine da oportunidade ${opportunityId}`}>
      <div className={styles.assessmentHeader}><Bot size={14} aria-hidden="true" /> <strong>Risk Engine</strong> <Badge variant={badge(s.tone)}>{s.title}</Badge> <Badge variant="outline">Simulação</Badge></div>
      <p className={styles.assessmentText}>{s.text}{assessment.decision && assessment.status !== "dados_insuficientes" ? ` Decisão: ${decisionLabel(assessment.decision)}.` : ""}</p>
      {assessment.status === "dados_insuficientes" && assessment.reevaluation && (
        <p className={styles.assessmentText} role="status">
          {assessment.reevaluation === "indisponivel" && assessment.blockCode ? REEVALUATION_BLOCK_TEXT[assessment.blockCode] ?? REEVALUATION_STATE_TEXT.indisponivel : REEVALUATION_STATE_TEXT[assessment.reevaluation]}
          {assessment.reevaluation === "elegivel" && <strong> Há uma informação nova disponível para análise.</strong>}
        </p>
      )}
      <div className={styles.assessmentActions}>
        {assessment.status === "dados_insuficientes" && assessment.reevaluation === "elegivel" && canRequest && <Button type="button" size="sm" onClick={() => { setError(null); setConfirm(true); }}>Solicitar nova análise…</Button>}
        <a className={styles.link} href={justificationHref} onClick={(e) => { if (onOpenJustification) { e.preventDefault(); onOpenJustification(); } }}>Ver a justificativa do Risk Engine</a>
        {traceHref && <a className={styles.link} href={traceHref} onClick={(e) => { if (onOpenTrace) { e.preventDefault(); onOpenTrace(); } }}>Ver rastreabilidade e auditoria</a>}
      </div>
      <Dialog open={confirm} onOpenChange={(o) => { if (!o && !reeval.isPending) { setConfirm(false); setError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Solicitar nova análise?</DialogTitle>
            <DialogDescription>O Risk Engine vai avaliar esta oferta de novo com a categoria que hoje consta no registro. Isto NÃO cria um evento novo, NÃO apaga a avaliação anterior (ela fica no histórico) e é só simulação: nada é executado fora do sistema. Pausa, limites, política e agente ligado são conferidos de novo, e a decisão pode exigir aprovação.</DialogDescription>
          </DialogHeader>
          <label className={styles.label} htmlFor={`reavaliar-motivo-${opportunityId}`}>Motivo (opcional; fica no histórico; sem dados pessoais)</label>
          <Input id={`reavaliar-motivo-${opportunityId}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} disabled={reeval.isPending} />
          {error && <p className={styles.errorText} role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => { setConfirm(false); setError(null); }} disabled={reeval.isPending}>Cancelar</Button>
            <Button type="button" onClick={() => reeval.mutate()} disabled={reeval.isPending}>{reeval.isPending ? "Reavaliando..." : "Solicitar nova análise (simulação)"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
