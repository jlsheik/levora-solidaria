import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getAllocationsReceiptHistory } from "../endpoints/allocations-receipt-history_GET.schema";
import { postAllocationsReceiptCorrect } from "../endpoints/allocations-receipt-correct_POST.schema";
import { postAllocationsReceiptReverse } from "../endpoints/allocations-receipt-reverse_POST.schema";
import { postApprovalRequestsDecide } from "../endpoints/approval-requests-decide_POST.schema";
import { ApiRequestError } from "../helpers/apiRequestError";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./Dialog";
import { Input } from "./Input";
import { Textarea } from "./Textarea";
import { Button } from "./Button";
import { Badge } from "./Badge";
import { Skeleton } from "./Skeleton";
import styles from "./ReceiptHistoryPanel.module.css";

const entryLabels = { original: "Recebimento", correction: "Correção", reversal: "Estorno" } as const;
const stateLabels = { vigente: "Vigente", substituida: "Substituída", estornada: "Estornada", estorno: "Estorno" } as const;

/** Códigos estáveis de conflito: a tela recarrega o histórico em vez de repetir a ação. */
const STALE_CODES = new Set(["recebimento_alterado", "pedido_obsoleto", "pedido_pendente", "ja_estornado", "pedido_expirado"]);

function formatQuantity(value: number): string {
  return value.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
}

interface Props {
  organizationId: number;
  allocationId: number;
}

export function ReceiptHistoryPanel({ organizationId, allocationId }: Props) {
  const queryClient = useQueryClient();
  const historyKey = ["allocation-receipt-history", organizationId, allocationId];
  const [mode, setMode] = useState<null | "corrigir" | "estornar">(null);
  const [field, setField] = useState<"quantidade" | "unidade">("quantidade");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [reason, setReason] = useState("");

  const historyQuery = useQuery({
    queryKey: historyKey,
    queryFn: () => getAllocationsReceiptHistory({ organizationId, allocationId }),
    staleTime: 0,
  });

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: historyKey });
    queryClient.invalidateQueries({ queryKey: ["approval-requests", organizationId] });
    queryClient.invalidateQueries({ queryKey: ["organization-allocations", organizationId] });
    queryClient.invalidateQueries({ queryKey: ["needs", organizationId] });
    queryClient.invalidateQueries({ queryKey: ["impact-report", organizationId] });
  };

  const onError = (err: unknown) => {
    if (err instanceof ApiRequestError && err.code && STALE_CODES.has(err.code)) {
      toast.error(`${err.message}`);
      setMode(null);
      queryClient.invalidateQueries({ queryKey: historyKey });
      return;
    }
    if (err instanceof ApiRequestError && err.status === 403) {
      toast.error("Você não tem permissão para esta ação nesta organização");
      return;
    }
    toast.error(err instanceof Error ? err.message : "Não foi possível concluir a operação");
  };

  const closeDialog = () => {
    setMode(null);
    setQuantity("");
    setUnit("");
    setReason("");
    setField("quantidade");
  };

  const data = historyQuery.data;

  const correctMutation = useMutation({
    mutationFn: () =>
      postAllocationsReceiptCorrect({
        organizationId,
        allocationId,
        expectedVigenteFulfillmentId: data!.vigenteFulfillmentId!,
        quantity: field === "quantidade" ? Number(quantity.replace(",", ".")) : undefined,
        unit: field === "unidade" ? unit : undefined,
        reason,
      }),
    onSuccess: (result) => {
      toast.success(result.status === "pendente_aprovacao" ? "Pedido enviado: outra pessoa precisa aprovar" : "Correção registrada");
      closeDialog();
      refreshAll();
    },
    onError,
  });

  const reverseMutation = useMutation({
    mutationFn: () => postAllocationsReceiptReverse({ organizationId, allocationId, expectedVigenteFulfillmentId: data!.vigenteFulfillmentId!, reason }),
    onSuccess: () => {
      toast.success("Pedido de estorno enviado: outra pessoa precisa aprovar");
      closeDialog();
      refreshAll();
    },
    onError,
  });

  const decideMutation = useMutation({
    mutationFn: (vars: { requestId: number; decision: "aprovada" | "rejeitada" }) => postApprovalRequestsDecide({ organizationId, ...vars }),
    onSuccess: (_r, vars) => {
      toast.success(vars.decision === "aprovada" ? "Pedido aprovado e executado" : "Pedido rejeitado");
      refreshAll();
    },
    onError,
  });

  if (historyQuery.isFetching && !data) return <Skeleton className={styles.skeleton} />;
  if (historyQuery.isError || !data) {
    return <p className={styles.hint}>Não foi possível carregar o histórico do recebimento.</p>;
  }

  const headRow = data.rows.find((r) => r.state === "vigente" || r.state === "estornada");
  const pending = data.pendingRequest;
  const isRequester = pending?.requestedByUserId === data.viewer.userId;
  const busy = correctMutation.isPending || reverseMutation.isPending;

  const newQuantity = Number(quantity.replace(",", "."));
  const reduces = field === "quantidade" && headRow && newQuantity > 0 && newQuantity < headRow.quantity;
  const needsApproval = mode === "estornar" || reduces || (field === "unidade" && headRow?.isCountable && !!unit.trim());
  const validForm = reason.trim().length >= 3 && (mode === "estornar" || (field === "quantidade" ? newQuantity > 0 : unit.trim().length > 0));

  return (
    <div className={styles.panel}>
      <h4 className={styles.title}>Histórico do recebimento</h4>

      {data.progress && data.need && (
        <p className={styles.summary}>
          Necessidade “{data.need.title}”: atendido {formatQuantity(data.progress.fulfilled)} de {formatQuantity(data.need.quantityNeeded)} {data.need.unit}
          {data.progress.requiredRemaining > 0 ? ` · faltam ${formatQuantity(data.progress.requiredRemaining)}` : ""}
          {data.progress.surplus > 0 ? ` · excedente ${formatQuantity(data.progress.surplus)}` : ""}
        </p>
      )}
      {data.chainState === "estornada" && <p className={styles.warning}>Este recebimento está estornado: não conta mais para a necessidade. O registro original continua abaixo.</p>}

      <ol className={styles.rows}>
        {data.rows.map((r) => (
          <li key={r.id} className={styles.row} data-state={r.state}>
            <div className={styles.rowHead}>
              <strong>{entryLabels[r.entryType]}</strong>
              <span>
                {formatQuantity(r.quantity)} {r.unit}
              </span>
              <Badge variant={r.state === "vigente" ? "success" : r.state === "estornada" ? "destructive" : "outline"}>{stateLabels[r.state]}</Badge>
              {!r.isCountable && <Badge variant="warning">Não conta no saldo</Badge>}
              {r.entryType === "reversal" && r.pairedWithCorrection && <Badge variant="secondary">Par de correção</Badge>}
            </div>
            <div className={styles.rowMeta}>
              {r.createdByDisplayName ?? "sistema"} · {new Date(r.createdAt).toLocaleString("pt-BR")}
              {r.countedEffect !== 0 ? ` · efeito no saldo ${r.countedEffect > 0 ? "+" : ""}${formatQuantity(r.countedEffect)}` : ""}
            </div>
            {r.reason && <div className={styles.rowReason}>Motivo: {r.reason}</div>}
          </li>
        ))}
        {data.rows.length === 0 && <li className={styles.hint}>Nenhum recebimento registrado.</li>}
      </ol>

      {pending && (
        <div className={styles.pending} role="status">
          <Badge variant="warning">Aguardando aprovação</Badge>
          <p>{pending.reason}</p>
          <p className={styles.rowMeta}>
            Solicitado por {pending.requestedByDisplayName} · {new Date(pending.createdAt).toLocaleString("pt-BR")}
          </p>
          {data.viewer.canDecide && !isRequester && (
            <div className={styles.actions}>
              <Button size="sm" disabled={decideMutation.isPending} onClick={() => decideMutation.mutate({ requestId: pending.id, decision: "aprovada" })}>
                Aprovar
              </Button>
              <Button size="sm" variant="secondary" disabled={decideMutation.isPending} onClick={() => decideMutation.mutate({ requestId: pending.id, decision: "rejeitada" })}>
                Rejeitar
              </Button>
            </div>
          )}
          {isRequester && <p className={styles.hint}>Você solicitou este pedido: outra pessoa com permissão de aprovação precisa decidir.</p>}
        </div>
      )}

      {data.viewer.canRequest && data.vigenteFulfillmentId && !pending && (
        <div className={styles.actions}>
          <Button size="sm" variant="secondary" onClick={() => setMode("corrigir")}>
            {data.chainState === "estornada" ? "Desfazer estorno" : "Corrigir recebimento"}
          </Button>
          {data.chainState === "ativa" && (
            <Button size="sm" variant="outline" onClick={() => setMode("estornar")}>
              Estornar recebimento
            </Button>
          )}
        </div>
      )}

      <Dialog open={mode !== null} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mode === "estornar" ? "Estornar recebimento" : data.chainState === "estornada" ? "Desfazer estorno" : "Corrigir recebimento"}</DialogTitle>
            <DialogDescription>
              {mode === "estornar"
                ? "O recebimento deixa de contar para a necessidade; o registro original permanece no histórico. Exige a aprovação de outra pessoa. Não altera o estoque físico."
                : "A correção cria novas linhas no histórico (nada é apagado) e não altera o estoque físico. Reduções exigem a aprovação de outra pessoa."}
            </DialogDescription>
          </DialogHeader>

          {mode === "corrigir" && headRow && (
            <div className={styles.form}>
              <p className={styles.hint}>
                Hoje: {formatQuantity(headRow.quantity)} {headRow.unit}
              </p>
              <div className={styles.choice}>
                <label>
                  <input type="radio" checked={field === "quantidade"} onChange={() => setField("quantidade")} /> Corrigir a quantidade
                </label>
                <label>
                  <input type="radio" checked={field === "unidade"} onChange={() => setField("unidade")} /> Corrigir a unidade (sem conversão)
                </label>
              </div>
              {field === "quantidade" ? (
                <Input type="number" step="0.001" min="0" inputMode="decimal" aria-label="Nova quantidade" placeholder="Nova quantidade" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              ) : (
                <Input aria-label="Nova unidade" placeholder="Nova unidade (ex.: kg)" value={unit} onChange={(e) => setUnit(e.target.value)} />
              )}
              {needsApproval && <p className={styles.warning}>Esta correção reduz o que conta para a necessidade: ela fica pendente até outra pessoa aprovar.</p>}
            </div>
          )}

          <div className={styles.form}>
            <Textarea aria-label="Motivo" placeholder="Motivo (obrigatório, até 200 caracteres, sem dados pessoais)" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>

          <DialogFooter>
            <Button variant="secondary" onClick={closeDialog}>
              Cancelar
            </Button>
            <Button
              disabled={!validForm || busy}
              onClick={() => (mode === "estornar" ? reverseMutation.mutate() : correctMutation.mutate())}
            >
              {busy ? "Enviando..." : mode === "estornar" ? "Solicitar estorno" : needsApproval ? "Solicitar correção" : "Registrar correção"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
