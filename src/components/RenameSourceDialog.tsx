import React, { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import { Button } from "./Button";
import { Input } from "./Input";
import { ApiRequestError } from "../helpers/apiRequestError";
import { SOURCE_NAME_MAX, SOURCE_NAME_MIN, postSourceName } from "../endpoints/source-name_POST.schema";
import styles from "./RenameSourceDialog.module.css";

interface RenameSourceDialogProps {
  source: { id: number; name: string } | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Renomear a fonte (somente o NOME; só o administrador da plataforma — a decisão é do servidor). Sem atualização otimista: após o sucesso a
 * lista de fontes é RECARREGADA e o diálogo só fecha quando o nome confirmado pelo servidor já chegou. Nenhum dado operacional é exibido.
 */
export const RenameSourceDialog: React.FC<RenameSourceDialogProps> = ({ source, onOpenChange }) => {
  const queryClient = useQueryClient();
  const [name, setName] = useState(source?.name ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (source) {
      setName(source.name);
      setError(null);
    }
  }, [source]);

  const trimmed = name.trim();
  const unchanged = source !== null && trimmed === source.name;
  const invalid = trimmed.length < SOURCE_NAME_MIN || trimmed.length > SOURCE_NAME_MAX;

  const mutation = useMutation({
    mutationFn: () => postSourceName({ sourceId: source!.id, name }),
    onSuccess: async (result) => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["sources"] }), queryClient.invalidateQueries({ queryKey: ["opportunity-registry"] })]);
      toast.success(result.changed ? "Nome da fonte atualizado" : "O nome já era este");
      onOpenChange(false);
    },
    onError: (err) => {
      if (err instanceof ApiRequestError && err.status === 403) setError("Somente administradores da plataforma podem renomear fontes.");
      else if (err instanceof ApiRequestError && err.status === 404) setError("Esta fonte não existe mais. Atualize a página.");
      else if (err instanceof ApiRequestError && err.status === 429) setError("Muitas alterações em pouco tempo. Aguarde um pouco e tente de novo.");
      else setError(err instanceof Error && err.message ? err.message : "Não foi possível alterar o nome. Tente novamente.");
    },
  });

  return (
    <Dialog open={source !== null} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Renomear fonte</DialogTitle>
          <DialogDescription>Altera apenas o nome. Tipo, conector, acesso, status e execução não mudam, e a alteração fica registrada na auditoria.</DialogDescription>
        </DialogHeader>
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (source && !invalid && !unchanged && !mutation.isPending) {
              setError(null);
              mutation.mutate();
            }
          }}
        >
          <label className={styles.field}>
            <span>Nome da fonte</span>
            <Input value={name} maxLength={SOURCE_NAME_MAX + 20} autoComplete="off" onChange={(e) => setName(e.target.value)} aria-invalid={invalid} disabled={mutation.isPending} />
            <span className={styles.counter}>{trimmed.length}/{SOURCE_NAME_MAX}</span>
          </label>
          {trimmed.length > SOURCE_NAME_MAX && <p className={styles.hint}>O nome pode ter no máximo {SOURCE_NAME_MAX} caracteres.</p>}
          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              Cancelar
            </Button>
            <Button type="submit" disabled={invalid || unchanged || mutation.isPending}>
              {mutation.isPending ? "Salvando..." : "Salvar nome"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
