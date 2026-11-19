import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { postOpportunitiesCategory, type OutputType as CategoryResult } from "../endpoints/opportunities-category_POST.schema";
import { getOpportunityChanges } from "../endpoints/opportunity-changes_GET.schema";
import { Button } from "./Button";
import { Input } from "./Input";
import { Skeleton } from "./Skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import { MISSING_CATEGORY_HELP, SUGGESTION_SOURCE_LABEL, validateCategoryDraft } from "./opportunityCategoryView";
import { fmtDateTime } from "./agentOpsView";
import styles from "./OpportunityAgent.module.css";

type Target = { id: number; title: string; category: string | null; version: number };
type Conflict = { message: string; current?: { version: number; category: string | null; status: string }; code?: string };

/**
 * Corrigir/definir a CATEGORIA de uma oportunidade (permissão `oportunidades.gerencie`, verificada no servidor). Controle otimista: envia a versão vista; se o registro mudou, o servidor recusa e esta caixa
 * mostra a versão atual para a pessoa decidir. Salvar NÃO dispara nenhuma análise (editar não é autorizar): a nova análise é um pedido separado. Nada é preenchido por padrão e nenhuma categoria é inventada.
 */
export function OpportunityCategoryDialog({ organizationId, target, suggestions, onClose, onSaved }: { organizationId: number; target: Target | null; suggestions: Array<{ value: string; source: string }>; onClose: () => void; onSaved?: (r: CategoryResult) => void }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(""); const [reason, setReason] = useState("");
  const [version, setVersion] = useState(1); const [shownCategory, setShownCategory] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null); const [touched, setTouched] = useState(false);

  useEffect(() => { if (target) { setValue(target.category ?? ""); setReason(""); setVersion(target.version); setShownCategory(target.category); setConflict(null); setTouched(false); } }, [target]);

  const changes = useQuery({ queryKey: ["opportunity-changes", organizationId, target?.id], queryFn: () => getOpportunityChanges({ organizationId, opportunityId: target!.id }), enabled: !!target, retry: false });
  const draft = validateCategoryDraft(value);
  const unchanged = draft.ok && target !== null && draft.value === (shownCategory ?? "");

  const save = useMutation({
    mutationFn: () => postOpportunitiesCategory({ organizationId, opportunityId: target!.id, category: value, expectedVersion: version, reason: reason.trim() || undefined }),
    onSuccess: (r) => {
      toast.success(r.changed ? "Categoria salva. Se houver uma avaliação incompleta, já é possível pedir nova análise." : "A categoria já era essa; nada foi alterado.");
      for (const key of ["opportunities", "opportunity-changes", "agent-events", "agents"]) queryClient.invalidateQueries({ queryKey: [key, organizationId] });
      onSaved?.(r); onClose();
    },
    onError: (e) => {
      const err = e as Error & { code?: string; current?: Conflict["current"] };
      setConflict({ message: err.message, current: err.current, code: err.code });
      for (const key of ["opportunities", "opportunity-changes"]) queryClient.invalidateQueries({ queryKey: [key, organizationId] });
    },
  });

  function useCurrent() { if (conflict?.current) { setVersion(conflict.current.version); setShownCategory(conflict.current.category); setValue(conflict.current.category ?? value); setConflict(null); } }

  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o && !save.isPending) onClose(); }}>
      <DialogContent>
        {target && (
          <form onSubmit={(ev) => { ev.preventDefault(); setTouched(true); if (draft.ok && !unchanged && !save.isPending) save.mutate(); }} className={styles.form}>
            <DialogHeader>
              <DialogTitle>{shownCategory ? "Corrigir a categoria" : "Definir a categoria"}</DialogTitle>
              <DialogDescription>{target.title}. {shownCategory ? <>Categoria atual: <strong>{shownCategory}</strong>.</> : MISSING_CATEGORY_HELP} Salvar não dispara nenhuma análise nem executa nada.</DialogDescription>
            </DialogHeader>
            <label className={styles.label} htmlFor="categoria-oportunidade">Categoria</label>
            <Input id="categoria-oportunidade" list="categoria-sugestoes" value={value} onChange={(e) => { setValue(e.target.value); setTouched(true); }} disabled={save.isPending} maxLength={80} autoComplete="off" aria-invalid={touched && !draft.ok ? true : undefined} aria-describedby={touched && !draft.ok ? "categoria-erro" : "categoria-ajuda"} />
            <datalist id="categoria-sugestoes">{suggestions.map((s) => <option key={s.value} value={s.value}>{SUGGESTION_SOURCE_LABEL[s.source] ?? s.source}</option>)}</datalist>
            <p id="categoria-ajuda" className={styles.help}>Texto livre (2 a 60 caracteres). As sugestões vêm de categorias já usadas aqui ou com regra na política — não há lista oficial e você pode digitar outra.</p>
            {touched && !draft.ok && <p id="categoria-erro" className={styles.fieldError} role="alert">{draft.message}</p>}
            <label className={styles.label} htmlFor="categoria-motivo">Motivo (opcional; fica no histórico; sem dados pessoais)</label>
            <Input id="categoria-motivo" value={reason} onChange={(e) => setReason(e.target.value)} disabled={save.isPending} maxLength={300} />
            {conflict && (
              <div className={styles.conflict} role="alert">
                <p><strong>{conflict.code === "conflito_de_versao" ? "Conflito de versão." : conflict.code === "estado_nao_permite" ? "Edição não permitida." : "Não foi possível salvar."}</strong> {conflict.message}</p>
                {conflict.code === "conflito_de_versao" && conflict.current && <Button type="button" size="sm" variant="outline" onClick={useCurrent}>Ver a versão atual (categoria: {conflict.current.category ?? "sem categoria"})</Button>}
              </div>
            )}
            <h3 className={styles.sectionHeading}>Histórico da categoria</h3>
            {changes.isError ? <p className={styles.errorText} role="alert">Não foi possível carregar o histórico.</p> : !changes.data ? <Skeleton className={styles.skeletonSmall} /> : changes.data.changes.length === 0 ? <p className={styles.help}>Nenhuma alteração registrada: a categoria é a do cadastro.</p> : (
              <ul className={styles.history} aria-label="Histórico da categoria">
                {changes.data.changes.map((c) => <li key={c.id}>{fmtDateTime(c.createdAt)} — {c.previousValue ?? "sem categoria"} → <strong>{c.newValue ?? "sem categoria"}</strong> por {c.changedByName ?? "uma pessoa"} (versão {c.versionBefore} → {c.versionAfter}){c.reason ? ` — “${c.reason}”` : ""}</li>)}
              </ul>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>Cancelar</Button>
              <Button type="submit" disabled={save.isPending || !draft.ok || unchanged}>{save.isPending ? "Salvando..." : "Salvar categoria"}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
