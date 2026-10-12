import React, { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import { Button } from "./Button";
import { Input } from "./Input";
import { Textarea } from "./Textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./Select";
import { ApiRequestError } from "../helpers/apiRequestError";
import { NeedPriorityArrayValues, type NeedPriority } from "../helpers/schema";
import { NEED_DESCRIPTION_MAX, NEED_TITLE_MAX, NEED_TITLE_MIN, postNeedDetails } from "../endpoints/need-details_POST.schema";
import styles from "./EditNeedDialog.module.css";

export interface EditableNeed {
  id: number;
  title: string;
  description: string | null;
  priority: NeedPriority;
}

interface EditNeedDialogProps {
  organizationId: number;
  need: EditableNeed | null;
  onOpenChange: (open: boolean) => void;
}

const priorityLabels: Record<NeedPriority, string> = { baixa: "Baixa", media: "Média", alta: "Alta", critica: "Crítica" };

/**
 * Editar os dados CADASTRAIS da necessidade: título, descrição e prioridade (só isso; quantidade, unidade, item e status não são editáveis aqui).
 * A decisão é do servidor (`necessidades.gerencie`). Sem atualização otimista: após o sucesso a lista é RECARREGADA e o diálogo só fecha
 * quando os valores persistidos já chegaram. Só os campos alterados são enviados.
 */
export const EditNeedDialog: React.FC<EditNeedDialogProps> = ({ organizationId, need, onOpenChange }) => {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<NeedPriority>("media");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (need) {
      setTitle(need.title);
      setDescription(need.description ?? "");
      setPriority(need.priority);
      setError(null);
    }
  }, [need]);

  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();
  const titleChanged = need !== null && trimmedTitle !== need.title;
  const descriptionChanged = need !== null && trimmedDescription !== (need.description ?? "");
  const priorityChanged = need !== null && priority !== need.priority;
  const anyChange = titleChanged || descriptionChanged || priorityChanged;
  // valida só o que foi ALTERADO (dados antigos fora do teto não travam a edição de outro campo)
  const titleInvalid = titleChanged && (trimmedTitle.length < NEED_TITLE_MIN || trimmedTitle.length > NEED_TITLE_MAX);
  const descriptionInvalid = descriptionChanged && trimmedDescription.length > NEED_DESCRIPTION_MAX;
  const invalid = titleInvalid || descriptionInvalid;

  const mutation = useMutation({
    mutationFn: () =>
      postNeedDetails({
        organizationId,
        needId: need!.id,
        ...(titleChanged ? { title } : {}),
        ...(descriptionChanged ? { description } : {}),
        ...(priorityChanged ? { priority } : {}),
      }),
    onSuccess: async (result) => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["needs", organizationId] }), queryClient.invalidateQueries({ queryKey: ["audit-log", organizationId] })]);
      toast.success(result.changed ? "Necessidade atualizada" : "Nada mudou");
      onOpenChange(false);
    },
    onError: (err) => {
      if (err instanceof ApiRequestError && err.status === 403) setError("Seu papel nesta organização não permite editar necessidades.");
      else if (err instanceof ApiRequestError && err.status === 404) setError("Esta necessidade não existe mais. Atualize a página.");
      else if (err instanceof ApiRequestError && err.status === 429) setError("Muitas alterações em pouco tempo. Aguarde um pouco e tente de novo.");
      else setError(err instanceof Error && err.message ? err.message : "Não foi possível salvar. Tente novamente.");
    },
  });

  return (
    <Dialog open={need !== null} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar necessidade</DialogTitle>
          <DialogDescription>
            Altera título, descrição e prioridade. Quantidade, unidade, item vinculado, status e o histórico de recebimentos não mudam. A prioridade e o título são considerados na próxima
            avaliação do matching; avaliações já feitas não são reescritas.
          </DialogDescription>
        </DialogHeader>
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (need && anyChange && !invalid && !mutation.isPending) {
              setError(null);
              mutation.mutate();
            }
          }}
        >
          <label className={styles.field}>
            <span>Título</span>
            <Input value={title} autoComplete="off" onChange={(e) => setTitle(e.target.value)} aria-invalid={titleInvalid} disabled={mutation.isPending} />
            <span className={styles.counter}>{trimmedTitle.length}/{NEED_TITLE_MAX}</span>
          </label>
          {titleInvalid && <p className={styles.hint}>O título precisa ter de {NEED_TITLE_MIN} a {NEED_TITLE_MAX} caracteres.</p>}
          <label className={styles.field}>
            <span>Descrição</span>
            <Textarea value={description} rows={4} onChange={(e) => setDescription(e.target.value)} aria-invalid={descriptionInvalid} disabled={mutation.isPending} />
            <span className={styles.counter}>{trimmedDescription.length}/{NEED_DESCRIPTION_MAX}</span>
          </label>
          {descriptionInvalid && <p className={styles.hint}>A descrição pode ter no máximo {NEED_DESCRIPTION_MAX} caracteres.</p>}
          <div className={styles.field}>
            <span>Prioridade</span>
            <Select value={priority} onValueChange={(v) => setPriority(v as NeedPriority)} disabled={mutation.isPending}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NeedPriorityArrayValues.map((p) => (
                  <SelectItem key={p} value={p}>
                    {priorityLabels[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!anyChange || invalid || mutation.isPending}>
              {mutation.isPending ? "Salvando..." : "Salvar alterações"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
