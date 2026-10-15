import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getStockDestinations, type InputType as DestinationQuery } from "../endpoints/stock-destinations_GET.schema";
import { postStockDestinationReversal } from "../endpoints/stock-destination-reversal_POST.schema";
import { postStockDestinationCorrection } from "../endpoints/stock-destination-correction_POST.schema";
import type { DestinationView } from "../helpers/destinationCorrections";
import { DESTINATION_LABELS, isAttendanceType } from "../helpers/destinationRules";
import { businessDateOf, checkEffectiveDate, MAX_RETROACTIVE_DAYS } from "../helpers/businessDate";
import { Button } from "./Button";
import { Badge } from "./Badge";
import { Input } from "./Input";
import { Textarea } from "./Textarea";
import { Skeleton } from "./Skeleton";
import { AttachProofDialog, RemoveProofDialog, proofSizeLabel } from "./DestinationProofDialogs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import inputStyles from "./Input.module.css";
import styles from "./DestinationHistory.module.css";

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2, 12)}`);

type Kind = "estorno_documental" | "devolucao_fisica" | "correcao_quantidade";
const KIND_INFO: Record<Kind, { label: string; consequence: string }> = {
  estorno_documental: { label: "Estorno documental (o registro estava errado)", consequence: "NÃO movimenta o estoque: o material saiu de fato e continua fora. Só o registro e o atendimento da necessidade são compensados." },
  devolucao_fisica: { label: "Devolução física (o material voltou)", consequence: "Cria uma ENTRADA de estoque da quantidade informada: o saldo do item aumenta." },
  correcao_quantidade: { label: "Correção de quantidade (parte nunca saiu)", consequence: "Cria um AJUSTE positivo de estoque da quantidade informada: o saldo do item aumenta." },
};
const STATE_LABEL = { ativa: "Ativa", parcialmente_revertida: "Parcialmente revertida", revertida: "Revertida" } as const;

const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("pt-BR");

/** Histórico das destinações (Fase 99G): original, correções documentais, reversões, saldo reversível e efeito físico de cada evento. O servidor decide tudo; a interface só mostra e pede. */
export type HistoryFilters = Partial<Pick<DestinationQuery, "itemId" | "needId" | "destinationType" | "state" | "basis" | "from" | "to">>;

export function DestinationHistory({ organizationId, filters = {}, initialLimit = 10, showTotals = false }: { organizationId: number; filters?: HistoryFilters; initialLimit?: number; showTotals?: boolean }) {
  const queryClient = useQueryClient();
  const [reverseTarget, setReverseTarget] = useState<DestinationView | null>(null);
  const [correctTarget, setCorrectTarget] = useState<DestinationView | null>(null);
  const [proofTarget, setProofTarget] = useState<DestinationView | null>(null);
  const [removeProofTarget, setRemoveProofTarget] = useState<DestinationView | null>(null);
  const [limit, setLimit] = useState(initialLimit);
  const filterKey = JSON.stringify(filters);
  // mudar o filtro volta à primeira página (a ordenação é sempre por id decrescente, estável)
  useEffect(() => { setLimit(initialLimit); }, [filterKey, initialLimit]);
  const query = useQuery({ queryKey: ["stock-destinations", organizationId, filterKey, limit], queryFn: () => getStockDestinations({ organizationId, limit, ...filters }), enabled: Number.isFinite(organizationId), placeholderData: (prev) => prev });

  const refreshAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["stock-destinations", organizationId] }),
      queryClient.invalidateQueries({ queryKey: ["inventory-items", organizationId] }),
      queryClient.invalidateQueries({ queryKey: ["stock-transactions", organizationId] }),
      queryClient.invalidateQueries({ queryKey: ["needs", organizationId] }),
    ]);
  };

  return (
    <section className={styles.section} aria-labelledby="dest-history-title">
      <h2 id="dest-history-title" className={styles.title}>Destinações registradas</h2>
      <p className={styles.help}>Nada é apagado: correções e reversões são novos registros ligados à destinação original.</p>
      {query.isLoading ? (
        <Skeleton className={styles.skeleton} />
      ) : query.isError ? (
        <p className={styles.error} role="alert">Não foi possível carregar as destinações. {query.error instanceof Error ? query.error.message : ""}</p>
      ) : query.data && query.data.destinations.length > 0 ? (
        <>
          {showTotals && query.data.totals.byUnit.length > 0 && (
            <div className={styles.totals} data-testid="destination-totals" aria-label="Totais do conjunto filtrado, por unidade">
              <strong>{query.data.totals.records} destinação(ões) no filtro</strong>
              {query.data.totals.byUnit.map((t) => (
                <span key={t.unit}>{t.unit}: físico líquido {t.physicalNet} (saiu {t.physical}, revertido {t.reverted}) · atendimento {t.appliedNet} · excedente {t.surplusNet}</span>
              ))}
              <span className={styles.help}>Unidades diferentes nunca são somadas. Revertido é o acumulado até hoje.</span>
            </div>
          )}
          <ul className={styles.list}>
            {query.data.destinations.map((d) => (
              <li key={d.id} className={styles.card} data-testid="destination-card" data-state={d.state}>
                <div className={styles.headerRow}>
                  <strong className={styles.name}>{d.itemName}</strong>
                  <Badge variant={d.state === "ativa" ? "outline" : d.state === "revertida" ? "secondary" : "outline"}>{STATE_LABEL[d.state]}</Badge>
                </div>
                <p className={styles.meta}>
                  {DESTINATION_LABELS[d.destinationType].label} · {d.quantity} {d.unit} · {fmtDate(d.effective.deliveredOn)}
                  {d.need ? <> · necessidade “{d.need.title}”{d.isCountable ? "" : " (unidade incompatível: não conta como atendimento)"}</> : null}
                </p>
                <p className={styles.meta}>
                  Registrada por {d.createdByDisplayName} em {new Date(d.createdAt).toLocaleString("pt-BR")}
                  {d.effective.peopleServed !== null ? ` · ${d.effective.peopleServed} ${d.effective.peopleUnit === "familias" ? "famílias" : "pessoas"}` : ""}
                  {d.effective.notes ? ` · ${d.effective.notes}` : ""}
                </p>
                <p className={styles.numbers}>
                  Revertido: <strong>{d.reversedQuantity} {d.unit}</strong> · ainda reversível: <strong>{d.reversibleQuantity} {d.unit}</strong>
                  {d.reversedQuantity > 0 ? <> (devolvido ao estoque: {d.physicallyReturnedQuantity} · estorno documental: {d.documentallyRevertedQuantity} · correção de quantidade: {d.quantityCorrectedQuantity})</> : null}
                </p>
                <div className={styles.proofBox} data-testid="destination-proof">
                  {d.proof ? (
                    <>
                      <span><strong>Comprovante:</strong> {d.proof.name} ({proofSizeLabel(d.proof.sizeBytes)}) · anexado por {d.proof.attachedByDisplayName} em {new Date(d.proof.attachedAt).toLocaleString("pt-BR")}</span>
                      <a className={styles.proofLink} href={d.proof.downloadUrl} target="_blank" rel="noopener noreferrer" aria-label={`Abrir o comprovante ${d.proof.name}`}>Abrir comprovante</a>
                    </>
                  ) : (
                    <span>Sem comprovante anexado (opcional).</span>
                  )}
                </div>
                {d.events.length > 0 && (
                  <ol className={styles.events} aria-label="Histórico de correções e reversões">
                    {d.events.map((e) => (
                      <li key={e.id}>
                        <strong>{e.proof ? (e.proof.action === "anexado" ? "Comprovante anexado" : "Referência ao comprovante removida") : e.entryType === "reversal" ? (e.reversalKind ? KIND_INFO[e.reversalKind as Kind].label.split(" (")[0] : "Reversão") : "Correção documental"}</strong>
                        {e.proof ? ` (${e.proof.name})` : ""}
                        {e.entryType === "reversal" ? ` de ${e.quantity} ${d.unit}` : ""}
                        {e.entryType === "reversal" ? (e.physicalMovement ? ` — com movimento físico (${e.physicalMovement === "entrada" ? "entrada" : "ajuste"} de estoque)` : " — sem movimento de estoque") : " — sem movimento de estoque"}
                        {e.entryType === "correction" && !e.proof ? <> — {[e.changes.deliveredOn ? `data: ${fmtDate(e.changes.deliveredOn)}` : null, e.changes.peopleServed !== null ? `pessoas: ${e.changes.peopleServed}` : null, e.changes.notes ? `observações: ${e.changes.notes}` : null].filter(Boolean).join("; ")}</> : null}
                        {" · "}“{e.reason}” · {e.createdByDisplayName} em {new Date(e.createdAt).toLocaleString("pt-BR")}
                      </li>
                    ))}
                  </ol>
                )}
                <div className={styles.actions}>
                  {d.canAttachProof && <Button variant="outline" size="sm" onClick={() => setProofTarget(d)} aria-label={`Anexar comprovante à destinação de ${d.itemName}`}>Anexar comprovante</Button>}
                  {d.proof && query.data!.canReverse && <Button variant="outline" size="sm" onClick={() => setRemoveProofTarget(d)} aria-label={`Remover o comprovante da destinação de ${d.itemName}`}>Remover comprovante</Button>}
                  <Button variant="outline" size="sm" onClick={() => setCorrectTarget(d)} aria-label={`Corrigir dados da destinação de ${d.itemName}`}>Corrigir dados</Button>
                  {query.data!.canReverse && d.reversibleQuantity > 0 && (
                    <Button variant="outline" size="sm" onClick={() => setReverseTarget(d)} aria-label={`Reverter a destinação de ${d.itemName}`}>Reverter</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {query.data.hasMore && (
            <Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + 10)} disabled={query.isFetching}>Mostrar mais</Button>
          )}
        </>
      ) : (
        <p className={styles.help}>{Object.values(filters).some((v) => v !== undefined && v !== "") ? "Nenhuma destinação corresponde aos filtros. Ajuste o período, a finalidade ou a situação." : "Nenhuma destinação registrada ainda."}</p>
      )}
      <ReversalDialog organizationId={organizationId} target={reverseTarget} onClose={() => setReverseTarget(null)} onDone={refreshAll} />
      <AttachProofDialog organizationId={organizationId} target={proofTarget} onClose={() => setProofTarget(null)} onDone={refreshAll} />
      <RemoveProofDialog organizationId={organizationId} target={removeProofTarget} onClose={() => setRemoveProofTarget(null)} onDone={refreshAll} />
      <CorrectionDialog organizationId={organizationId} target={correctTarget} onClose={() => setCorrectTarget(null)} onDone={refreshAll} />
    </section>
  );
}

function ReversalDialog({ organizationId, target, onClose, onDone }: { organizationId: number; target: DestinationView | null; onClose: () => void; onDone: () => Promise<void> }) {
  const [kind, setKind] = useState<Kind | "">("");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);

  useEffect(() => {
    if (target) { setKind(""); setQuantity(""); setReason(""); setError(null); setKey(newKey()); }
  }, [target]);

  const qty = quantity === "" ? NaN : Number(quantity.replace(",", "."));
  const qtyValid = Number.isFinite(qty) && qty > 0 && Math.round(qty * 1000) / 1000 === qty;
  const tooMuch = !!target && qtyValid && qty > target.reversibleQuantity;
  const problems: string[] = [];
  if (quantity !== "" && !qtyValid) problems.push("Informe uma quantidade positiva com no máximo 3 casas decimais.");
  if (tooMuch) problems.push(`A quantidade excede o que ainda pode ser revertido (${target!.reversibleQuantity} ${target!.unit}).`);
  if (reason.trim().length > 0 && reason.trim().length < 5) problems.push("Explique o motivo (mínimo de 5 caracteres).");
  const ready = !!target && kind !== "" && qtyValid && !tooMuch && reason.trim().length >= 5;

  const mutation = useMutation({
    mutationFn: () => postStockDestinationReversal({ organizationId, destinationId: target!.id, kind: kind as Kind, quantity: qty, reason: reason.trim(), idempotencyKey: key }),
    onSuccess: async (r) => {
      await onDone();
      toast.success(
        r.need?.reopened
          ? "Destinação revertida. A necessidade voltou a ficar aberta, pois o atendimento caiu abaixo do solicitado."
          : r.stockMovement
            ? `Destinação revertida; ${r.stockMovement.type === "entrada" ? "entrada" : "ajuste"} de ${r.stockMovement.delta} registrado no estoque.`
            : "Destinação revertida sem movimento de estoque.",
        { duration: 8000 }
      );
      onClose();
    },
    // o erro fica visível e a MESMA chave é mantida: tentar de novo é seguro (nunca duplica a reversão nem a entrada)
    onError: (e) => setError(e instanceof Error ? e.message : "Não foi possível reverter a destinação"),
  });

  if (!target) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
      <DialogContent>
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); setError(null); if (ready && !mutation.isPending) mutation.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Reverter destinação: {target.itemName}</DialogTitle>
            <DialogDescription>
              Destinada: {target.quantity} {target.unit} · já revertido: {target.reversedQuantity} · reversível: <strong>{target.reversibleQuantity} {target.unit}</strong>. A original permanece no histórico.
            </DialogDescription>
          </DialogHeader>
          <label className={styles.label} htmlFor="rev-kind">Tipo da reversão</label>
          <select id="rev-kind" className={`${inputStyles.input} ${styles.select}`} value={kind} onChange={(e) => setKind(e.target.value as Kind | "")}>
            <option value="">Escolha o tipo</option>
            {(Object.keys(KIND_INFO) as Kind[]).map((k) => <option key={k} value={k}>{KIND_INFO[k].label}</option>)}
          </select>
          {kind !== "" && <p className={styles.notice} role="status" data-testid="reversal-consequence">{KIND_INFO[kind].consequence}</p>}
          {kind !== "" && target.need && target.isCountable && (
            <p className={styles.notice} role="status">O atendimento da necessidade “{target.need.title}” será recalculado; se cair abaixo do solicitado, ela volta a ficar aberta.</p>
          )}
          <label className={styles.label} htmlFor="rev-qty">Quantidade a reverter ({target.unit})</label>
          <Input id="rev-qty" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder={`até ${target.reversibleQuantity}`} aria-describedby="rev-problems" />
          <label className={styles.label} htmlFor="rev-reason">Motivo (obrigatório)</label>
          <Textarea id="rev-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          <div id="rev-problems" aria-live="polite">{problems.length > 0 && <ul className={styles.problems}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}</div>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancelar</Button>
            <Button type="submit" disabled={!ready || mutation.isPending}>{mutation.isPending ? "Revertendo..." : "Confirmar reversão"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CorrectionDialog({ organizationId, target, onClose, onDone }: { organizationId: number; target: DestinationView | null; onClose: () => void; onDone: () => Promise<void> }) {
  const [deliveredOn, setDeliveredOn] = useState("");
  const [people, setPeople] = useState("");
  const [peopleUnit, setPeopleUnit] = useState<"familias" | "pessoas">("pessoas");
  const [notes, setNotes] = useState("");
  const [lateReason, setLateReason] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);
  const today = businessDateOf(new Date());

  useEffect(() => {
    if (target) { setDeliveredOn(target.effective.deliveredOn); setPeople(target.effective.peopleServed === null ? "" : String(target.effective.peopleServed)); setPeopleUnit(target.effective.peopleUnit ?? "pessoas"); setNotes(target.effective.notes ?? ""); setLateReason(""); setReason(""); setError(null); setKey(newKey()); }
  }, [target]);

  const attendance = !!target && isAttendanceType(target.destinationType);
  const dateChanged = !!target && deliveredOn !== "" && deliveredOn !== target.effective.deliveredOn;
  const check = dateChanged ? checkEffectiveDate(deliveredOn, new Date()) : null;
  const retroactive = !!check && check.ok && check.retroactive;
  const peopleChanged = !!target && people !== "" && (Number(people) !== target.effective.peopleServed || peopleUnit !== target.effective.peopleUnit);
  const notesChanged = !!target && notes.trim() !== "" && notes.trim() !== (target.effective.notes ?? "");
  const anyChange = dateChanged || peopleChanged || notesChanged;
  const problems: string[] = [];
  if (check && !check.ok) problems.push(check.reason === "futura" ? "A data efetiva não pode ser futura." : "Informe uma data válida.");
  if (peopleChanged && !(Number.isInteger(Number(people)) && Number(people) >= 0)) problems.push("Pessoas atendidas deve ser um número inteiro.");
  if (retroactive && lateReason.trim().length < 10) problems.push(`Datas com mais de ${MAX_RETROACTIVE_DAYS} dias exigem justificativa (mínimo de 10 caracteres) e proprietário ou administrador.`);
  if (reason.trim().length > 0 && reason.trim().length < 5) problems.push("Explique o motivo da correção (mínimo de 5 caracteres).");
  const ready = anyChange && problems.length === 0 && reason.trim().length >= 5;

  const mutation = useMutation({
    mutationFn: () =>
      postStockDestinationCorrection({
        organizationId,
        destinationId: target!.id,
        deliveredOn: dateChanged ? deliveredOn : null,
        peopleServed: peopleChanged ? Number(people) : null,
        peopleUnit: peopleChanged ? peopleUnit : null,
        notes: notesChanged ? notes.trim() : null,
        lateRegistrationReason: retroactive ? lateReason.trim() : null,
        reason: reason.trim(),
        idempotencyKey: key,
      }),
    onSuccess: async () => {
      await onDone();
      toast.success("Dados da destinação corrigidos. O registro original foi preservado.");
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Não foi possível corrigir a destinação"),
  });

  if (!target) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
      <DialogContent>
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); setError(null); if (ready && !mutation.isPending) mutation.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Corrigir dados: {target.itemName}</DialogTitle>
            <DialogDescription>Correção documental: só data, pessoas atendidas e observações. Não altera quantidade, finalidade, necessidade nem estoque — para isso use “Reverter”.</DialogDescription>
          </DialogHeader>
          <label className={styles.label} htmlFor="cor-date">Data efetiva</label>
          <Input id="cor-date" type="date" value={deliveredOn} max={today} onChange={(e) => setDeliveredOn(e.target.value)} />
          {retroactive && (
            <>
              <label className={styles.label} htmlFor="cor-late">Justificativa da data retroativa</label>
              <Textarea id="cor-late" value={lateReason} maxLength={500} onChange={(e) => setLateReason(e.target.value)} />
            </>
          )}
          {attendance && (
            <div className={styles.row}>
              <div>
                <label className={styles.label} htmlFor="cor-people">Pessoas atendidas</label>
                <Input id="cor-people" inputMode="numeric" value={people} onChange={(e) => setPeople(e.target.value)} />
              </div>
              <div>
                <label className={styles.label} htmlFor="cor-people-unit">Contagem em</label>
                <select id="cor-people-unit" className={`${inputStyles.input} ${styles.select}`} value={peopleUnit} onChange={(e) => setPeopleUnit(e.target.value as "familias" | "pessoas")}>
                  <option value="pessoas">Pessoas</option>
                  <option value="familias">Famílias</option>
                </select>
              </div>
            </div>
          )}
          <label className={styles.label} htmlFor="cor-notes">Observações (sem dados pessoais)</label>
          <Textarea id="cor-notes" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
          <label className={styles.label} htmlFor="cor-reason">Motivo da correção (obrigatório)</label>
          <Textarea id="cor-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          <div aria-live="polite">{problems.length > 0 && <ul className={styles.problems}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}</div>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancelar</Button>
            <Button type="submit" disabled={!ready || mutation.isPending}>{mutation.isPending ? "Corrigindo..." : "Confirmar correção"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
