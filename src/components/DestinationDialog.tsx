import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getNeeds } from "../endpoints/needs_GET.schema";
import { postStockDestinations } from "../endpoints/stock-destinations_POST.schema";
import { Button } from "./Button";
import { Input } from "./Input";
import { Textarea } from "./Textarea";
import { Skeleton } from "./Skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import { checkEffectiveDate, businessDateOf, MAX_RETROACTIVE_DAYS } from "../helpers/businessDate";
import { DESTINATION_LABELS, DESTINATION_TYPES, evaluateDestinationRisk, isAttendanceType, NOTES_MIN_WHEN_REQUIRED, REASON_REQUIRED_TYPES, RISK_LABELS, type DestinationType } from "../helpers/destinationRules";
import { UnitText } from "./UnitText";
import { classifyUnit } from "../helpers/unitVocabulary";
import inputStyles from "./Input.module.css";
import styles from "./DestinationDialog.module.css";

export interface DestinationItem {
  id: number;
  name: string;
  unit: string;
  currentStock: number;
}

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2, 12)}`);

/**
 * Registro de saída física + destinação (Fase 99E). A interface orienta e evita erros evitáveis; a AUTORIDADE de validação, de risco, de data e de idempotência é o servidor. A chave de
 * idempotência nasce ao abrir o diálogo e é reenviada em qualquer nova tentativa (rede, duplo clique, outra aba): o servidor nunca cria duas saídas para a mesma chave.
 */
export function DestinationDialog({ organizationId, item, canAuthorizeLate, onClose }: { organizationId: number; item: DestinationItem | null; canAuthorizeLate: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const today = businessDateOf(new Date());
  const [quantity, setQuantity] = useState("");
  const [type, setType] = useState<DestinationType | "">("");
  const [needId, setNeedId] = useState("");
  const [deliveredOn, setDeliveredOn] = useState(today);
  const [people, setPeople] = useState("");
  const [peopleUnit, setPeopleUnit] = useState<"familias" | "pessoas">("pessoas");
  const [notes, setNotes] = useState("");
  const [lateReason, setLateReason] = useState("");
  const [surplusOk, setSurplusOk] = useState(false);
  const [surplusReason, setSurplusReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);

  useEffect(() => {
    if (item) {
      setQuantity(""); setType(""); setNeedId(""); setDeliveredOn(businessDateOf(new Date())); setPeople(""); setPeopleUnit("pessoas"); setNotes(""); setLateReason(""); setSurplusOk(false); setSurplusReason(""); setError(null); setKey(newKey());
    }
  }, [item?.id]);

  const needsQuery = useQuery({ queryKey: ["needs", organizationId], queryFn: () => getNeeds({ organizationId }), enabled: !!item });
  const attendance = type !== "" && isAttendanceType(type);
  const eligibleNeeds = useMemo(
    () => (needsQuery.data?.needs ?? []).filter((n) => n.status === "aberta" && (n.itemId === null || n.itemId === item?.id)),
    [needsQuery.data, item?.id]
  );

  const qty = quantity === "" ? NaN : Number(quantity);
  const qtyValid = Number.isFinite(qty) && qty > 0 && Math.round(qty * 1000) / 1000 === qty;
  const unitReliable = item ? (() => { const c = classifyUnit(item.unit); return c.kind === "canonica" && c.canonicalLabel === item.unit; })() : false;
  const insufficient = !!item && qtyValid && qty > item.currentStock;
  const dateCheck = checkEffectiveDate(deliveredOn, new Date());
  const retroactive = dateCheck.ok && dateCheck.retroactive;
  const selectedNeed = eligibleNeeds.find((n) => String(n.id) === needId);
  const unitMismatchNeed = !!selectedNeed && !!item && classifyUnit(selectedNeed.unit).canonicalId !== classifyUnit(item.unit).canonicalId;
  // Fase 99F: quanto FALTA da necessidade (vem do servidor, derivado das destinações); a decisão final é sempre do servidor, aqui só se antecipa o aviso
  const needRemaining = selectedNeed && !unitMismatchNeed ? selectedNeed.attendance.remaining : null;
  const surplusPreview = needRemaining !== null && qtyValid && qty > needRemaining ? Math.round((qty - needRemaining) * 1000) / 1000 : 0;
  const risk = type !== "" && item && qtyValid ? evaluateDestinationRisk({ destinationType: type, quantity: qty, balanceBefore: item.currentStock }) : [];
  const notesRequired = type !== "" && REASON_REQUIRED_TYPES.includes(type);

  const problems: string[] = [];
  if (!unitReliable) problems.push("A unidade deste item não é uma unidade canônica confiável: regularize a unidade antes de registrar uma saída.");
  if (quantity !== "" && !qtyValid) problems.push("Informe uma quantidade positiva com no máximo 3 casas decimais.");
  if (insufficient) problems.push(`Saldo insuficiente: há ${item!.currentStock} ${item!.unit} em estoque.`);
  if (!dateCheck.ok) problems.push(dateCheck.reason === "futura" ? "A data efetiva não pode ser futura." : "Informe uma data válida.");
  if (retroactive && !canAuthorizeLate) problems.push(`Datas com mais de ${MAX_RETROACTIVE_DAYS} dias exigem proprietário ou administrador.`);
  if (retroactive && canAuthorizeLate && lateReason.trim().length < 10) problems.push("Explique por que a data é retroativa (mínimo de 10 caracteres).");
  if (surplusPreview > 0 && !canAuthorizeLate) problems.push(`A quantidade supera o que falta da necessidade (faltam ${needRemaining} ${selectedNeed!.unit}). Reduza a quantidade: só proprietário ou administrador autoriza excedente.`);
  if (surplusPreview > 0 && canAuthorizeLate && !surplusOk) problems.push(`A quantidade supera em ${surplusPreview} o que falta (${needRemaining} ${selectedNeed!.unit}). Reduza a quantidade ou autorize o excedente.`);
  if (surplusPreview > 0 && canAuthorizeLate && surplusOk && surplusReason.trim().length < 10) problems.push("Explique o excedente (mínimo de 10 caracteres).");
  if (notesRequired && notes.trim().length < NOTES_MIN_WHEN_REQUIRED) problems.push(`Descreva o motivo (mínimo de ${NOTES_MIN_WHEN_REQUIRED} caracteres).`);
  if (people !== "" && !(Number.isInteger(Number(people)) && Number(people) >= 0)) problems.push("Pessoas atendidas deve ser um número inteiro.");
  const ready = !!item && type !== "" && qtyValid && problems.length === 0 && quantity !== "";

  const mutation = useMutation({
    mutationFn: () =>
      postStockDestinations({
        organizationId,
        itemId: item!.id,
        quantity: quantity as unknown as number,
        destinationType: type as DestinationType,
        needId: attendance && needId ? Number(needId) : null,
        deliveredOn,
        peopleServed: attendance && people !== "" ? Number(people) : null,
        peopleUnit: attendance && people !== "" ? peopleUnit : null,
        notes: notes.trim() || null,
        lateRegistrationReason: retroactive ? lateReason.trim() : null,
        authorizeSurplus: surplusPreview > 0 && surplusOk ? true : undefined,
        surplusReason: surplusPreview > 0 && surplusOk ? surplusReason.trim() : null,
        idempotencyKey: key,
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["inventory-items", organizationId] });
      queryClient.invalidateQueries({ queryKey: ["stock-transactions", organizationId] });
      queryClient.invalidateQueries({ queryKey: ["approval-requests", organizationId] });
      queryClient.invalidateQueries({ queryKey: ["needs", organizationId] });
      if (result.requiresApproval) toast.info(result.message, { duration: 12000 });
      else toast.success(result.notice ?? (result.replayed ? "Esta saída já estava registrada." : "Saída registrada com a destinação."), { duration: result.notice ? 12000 : 5000 });
      onClose();
    },
    // o erro fica visível no diálogo (role=alert) e a MESMA chave é mantida: tentar de novo é seguro
    onError: (e) => setError(e instanceof Error ? e.message : "Não foi possível registrar a saída"),
  });

  if (!item) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); setError(null); if (ready) mutation.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Registrar destinação: {item.name}</DialogTitle>
            <DialogDescription>
              Saldo disponível: <strong>{item.currentStock} <UnitText unit={item.unit} /></strong>. A saída e a finalidade são registradas juntas e de forma permanente.
            </DialogDescription>
          </DialogHeader>

          <label className={styles.label} htmlFor="dest-qty">Quantidade que sairá ({item.unit})</label>
          <Input id="dest-qty" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="ex.: 12,5" aria-describedby="dest-problems" />

          <label className={styles.label} htmlFor="dest-type">Finalidade</label>
          <select id="dest-type" className={`${inputStyles.input} ${styles.select}`} value={type} onChange={(e) => { setType(e.target.value as DestinationType | ""); setNeedId(""); }}>
            <option value="">Escolha a finalidade</option>
            {DESTINATION_TYPES.map((t) => <option key={t} value={t}>{DESTINATION_LABELS[t].label}</option>)}
          </select>
          {type !== "" && <p className={styles.help}>{DESTINATION_LABELS[type].description}</p>}

          {attendance && (
            <>
              <label className={styles.label} htmlFor="dest-need">Necessidade atendida (opcional)</label>
              {needsQuery.isLoading ? <Skeleton className={styles.skeleton} /> : needsQuery.isError ? (
                <p className={styles.help} role="alert">Não foi possível carregar as necessidades. Você pode registrar sem vincular.</p>
              ) : eligibleNeeds.length === 0 ? (
                <p className={styles.help} role="status">Nenhuma necessidade aberta compatível com este item.</p>
              ) : (
                <select id="dest-need" className={`${inputStyles.input} ${styles.select}`} value={needId} onChange={(e) => setNeedId(e.target.value)}>
                  <option value="">Não vincular</option>
                  {eligibleNeeds.map((n) => <option key={n.id} value={n.id}>{n.title} (faltam {n.attendance.remaining} de {n.quantityNeeded} {n.unit})</option>)}
                </select>
              )}
              {unitMismatchNeed && <p className={styles.warning} role="status">A unidade da necessidade ({selectedNeed!.unit}) não é a do item ({item.unit}): a saída será registrada, mas NÃO contará como atendimento da necessidade. Nada é convertido.</p>}

              {surplusPreview > 0 && canAuthorizeLate && (
                <>
                  <label className={styles.label} htmlFor="dest-surplus-ok">
                    <input id="dest-surplus-ok" type="checkbox" checked={surplusOk} onChange={(e) => setSurplusOk(e.target.checked)} /> Autorizo o excedente de {surplusPreview} {item.unit} (o atendimento conta só o que faltava)
                  </label>
                  {surplusOk && (
                    <>
                      <label className={styles.label} htmlFor="dest-surplus-reason">Motivo do excedente</label>
                      <Textarea id="dest-surplus-reason" value={surplusReason} maxLength={500} onChange={(e) => setSurplusReason(e.target.value)} />
                    </>
                  )}
                </>
              )}

              <div className={styles.row}>
                <div>
                  <label className={styles.label} htmlFor="dest-people">Pessoas atendidas (opcional, agregado)</label>
                  <Input id="dest-people" inputMode="numeric" value={people} onChange={(e) => setPeople(e.target.value)} />
                </div>
                <div>
                  <label className={styles.label} htmlFor="dest-people-unit">Contagem em</label>
                  <select id="dest-people-unit" className={`${inputStyles.input} ${styles.select}`} value={peopleUnit} onChange={(e) => setPeopleUnit(e.target.value as "familias" | "pessoas")}>
                    <option value="pessoas">Pessoas</option>
                    <option value="familias">Famílias</option>
                  </select>
                </div>
              </div>
              <p className={styles.help}>Pessoas atendidas é um número agregado, diferente da quantidade física. Não registre nomes, contatos ou documentos.</p>
            </>
          )}

          <label className={styles.label} htmlFor="dest-date">Data efetiva da saída</label>
          <Input id="dest-date" type="date" value={deliveredOn} max={today} onChange={(e) => setDeliveredOn(e.target.value)} />
          {retroactive && canAuthorizeLate && (
            <>
              <label className={styles.label} htmlFor="dest-late">Justificativa da data retroativa</label>
              <Textarea id="dest-late" value={lateReason} maxLength={500} onChange={(e) => setLateReason(e.target.value)} />
            </>
          )}

          <label className={styles.label} htmlFor="dest-notes">{notesRequired ? "Motivo / descrição (obrigatório)" : "Observações (opcional, sem dados pessoais)"}</label>
          <Textarea id="dest-notes" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />

          {risk.length > 0 && (
            <p className={styles.approval} role="status">
              <strong>Exige segunda aprovação:</strong> {risk.map((r) => RISK_LABELS[r]).join("; ")}. Nada será baixado do estoque até outra pessoa aprovar.
            </p>
          )}
          <div id="dest-problems" aria-live="polite">
            {problems.length > 0 && <ul className={styles.problems}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          </div>
          {mutation.isPaused && <p className={styles.approval} role="status">Sem conexão com o servidor. A saída ficou na fila e será enviada sozinha quando a conexão voltar; não é preciso clicar de novo (a mesma solicitação nunca cria duas saídas).</p>}
          {error && <p className={styles.error} role="alert">{error} Você pode tentar de novo: a mesma solicitação nunca cria duas saídas.</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancelar</Button>
            <Button type="submit" disabled={!ready || mutation.isPending}>
              {mutation.isPending ? "Registrando..." : risk.length > 0 ? "Enviar para aprovação" : "Confirmar saída"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
