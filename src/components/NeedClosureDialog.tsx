import React, { useEffect, useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import { Button } from "./Button";
import { Textarea } from "./Textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./Select";
import { CLOSURE_REASON_CODES, CLOSURE_REASON_LABELS, postNeedClosure } from "../endpoints/need-closure_POST.schema";
import styles from "./NeedClosureDialog.module.css";

export interface ClosableNeed {
  id: number;
  title: string;
  unit: string;
  requested: number;
  attended: number;
  remaining: number;
  /** "encerrar" para necessidade aberta; "reabrir" para necessidade encerrada com evento. */
  action: "encerrar" | "reabrir";
}

interface NeedClosureDialogProps {
  organizationId: number;
  need: ClosableNeed | null;
  onOpenChange: (open: boolean) => void;
}

type ReasonCode = (typeof CLOSURE_REASON_CODES)[number];

/**
 * Fase 99F — encerra uma necessidade SEM atendimento integral (motivo estruturado; o atendimento parcial já registrado é preservado e NENHUM estoque se move) ou a reabre
 * (o encerramento continua no histórico). Sem atualização otimista: a decisão e o progresso vêm do servidor e a lista é recarregada.
 */
export const NeedClosureDialog: React.FC<NeedClosureDialogProps> = ({ organizationId, need, onOpenChange }) => {
  const queryClient = useQueryClient();
  const [reasonCode, setReasonCode] = useState<ReasonCode | "">("");
  const [reasonText, setReasonText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  useEffect(() => {
    if (need) {
      setReasonCode("");
      setReasonText("");
      setError(null);
    }
  }, [need]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!need) throw new Error("Necessidade não selecionada");
      if (need.action === "encerrar") {
        if (!reasonCode) throw new Error("Escolha o motivo do encerramento");
        return postNeedClosure({ action: "encerrar", organizationId, needId: need.id, reasonCode, reasonText: reasonText.trim() || null });
      }
      return postNeedClosure({ action: "reabrir", organizationId, needId: need.id, reasonText: reasonText.trim() });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["needs", organizationId] });
      toast.success(need?.action === "reabrir" ? "Necessidade reaberta" : "Necessidade encerrada");
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Não foi possível concluir a operação"),
  });

  const closing = need?.action !== "reabrir";
  const partial = (need?.attended ?? 0) > 0;
  return (
    <Dialog open={need !== null} onOpenChange={(open) => !mutation.isPending && onOpenChange(open)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{closing ? "Encerrar necessidade" : "Reabrir necessidade"}</DialogTitle>
          <DialogDescription>
            {need?.title}
          </DialogDescription>
        </DialogHeader>
        {need && (
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              mutation.mutate();
            }}
          >
            {closing ? (
              <>
                <p className={styles.summary}>
                  Atendido até agora: <strong>{need.attended} de {need.requested} {need.unit}</strong>
                  {need.remaining > 0 ? <> · não atendido: <strong>{need.remaining} {need.unit}</strong></> : null}.
                </p>
                <p className={styles.note}>
                  O encerramento não movimenta estoque e não apaga as entregas já registradas{partial ? ": o atendimento parcial acima é preservado" : ""}.
                </p>
                <label className={styles.field} htmlFor={`${ids}-motivo`}>
                  <span>Motivo do encerramento</span>
                  <Select value={reasonCode || undefined} onValueChange={(v) => setReasonCode(v as ReasonCode)}>
                    <SelectTrigger id={`${ids}-motivo`} aria-label="Motivo do encerramento">
                      <SelectValue placeholder="Escolha o motivo" />
                    </SelectTrigger>
                    <SelectContent>
                      {CLOSURE_REASON_CODES.map((c) => (
                        <SelectItem key={c} value={c}>{CLOSURE_REASON_LABELS[c]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className={styles.field} htmlFor={`${ids}-descricao`}>
                  <span>Descrição {partial || reasonCode === "outro" ? "(obrigatória)" : "(opcional)"}</span>
                  <Textarea id={`${ids}-descricao`} rows={3} value={reasonText} onChange={(e) => setReasonText(e.target.value)} disabled={mutation.isPending} />
                </label>
              </>
            ) : (
              <>
                <p className={styles.note}>
                  A necessidade volta a ficar aberta. O progresso é recalculado a partir das entregas já registradas ({need.attended} de {need.requested} {need.unit}); o encerramento anterior permanece no histórico.
                </p>
                <label className={styles.field} htmlFor={`${ids}-descricao`}>
                  <span>Por que está sendo reaberta?</span>
                  <Textarea id={`${ids}-descricao`} rows={3} value={reasonText} onChange={(e) => setReasonText(e.target.value)} disabled={mutation.isPending} />
                </label>
              </>
            )}
            {error && <p role="alert" className={styles.error}>{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>Cancelar</Button>
              <Button type="submit" disabled={mutation.isPending || (closing ? !reasonCode : reasonText.trim().length < 5)}>
                {mutation.isPending ? "Salvando..." : closing ? "Encerrar necessidade" : "Reabrir necessidade"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
};
