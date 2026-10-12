import React, { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import { Button } from "./Button";
import { Input } from "./Input";
import { ApiRequestError } from "../helpers/apiRequestError";
import { ORGANIZATION_NAME_MAX, ORGANIZATION_NAME_MIN, postOrganizationName } from "../endpoints/organization-name_POST.schema";
import styles from "./RenameOrganizationDialog.module.css";

interface RenameOrganizationDialogProps {
  organizationId: number;
  currentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Renomear a organização (somente o NOME; só o proprietário ativo — a decisão é do servidor). A tela NÃO atualiza de forma otimista:
 * depois do sucesso a lista de organizações é RECARREGADA e o diálogo só fecha quando o nome persistido já chegou.
 */
export const RenameOrganizationDialog: React.FC<RenameOrganizationDialogProps> = ({ organizationId, currentName, open, onOpenChange }) => {
  const queryClient = useQueryClient();
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(currentName);
      setError(null);
    }
  }, [open, currentName]);

  const trimmed = name.trim();
  const unchanged = trimmed === currentName;
  const invalid = trimmed.length < ORGANIZATION_NAME_MIN || trimmed.length > ORGANIZATION_NAME_MAX;

  const mutation = useMutation({
    mutationFn: () => postOrganizationName({ organizationId, name }),
    onSuccess: async (result) => {
      // recarrega a fonte da verdade (servidor) antes de fechar; nenhum setQueryData otimista
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["organizations"] }), queryClient.invalidateQueries({ queryKey: ["audit-log", organizationId] })]);
      toast.success(result.changed ? "Nome da organização atualizado" : "O nome já era este");
      onOpenChange(false);
    },
    onError: (err) => {
      if (err instanceof ApiRequestError && err.status === 403) setError("Somente o proprietário ativo pode alterar o nome da organização.");
      else if (err instanceof ApiRequestError && err.status === 429) setError("Muitas alterações em pouco tempo. Aguarde um pouco e tente de novo.");
      else setError(err instanceof Error && err.message ? err.message : "Não foi possível alterar o nome. Tente novamente.");
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Renomear organização</DialogTitle>
          <DialogDescription>
            Altera apenas o nome cadastral. Endereço, tipo, status, estoque e histórico não mudam, e a alteração fica registrada na auditoria.
          </DialogDescription>
        </DialogHeader>
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (!invalid && !unchanged && !mutation.isPending) {
              setError(null);
              mutation.mutate();
            }
          }}
        >
          <label className={styles.field}>
            <span>Nome da organização</span>
            <Input value={name} maxLength={ORGANIZATION_NAME_MAX + 20} autoComplete="off" onChange={(e) => setName(e.target.value)} aria-invalid={invalid} disabled={mutation.isPending} />
            <span className={styles.counter}>{trimmed.length}/{ORGANIZATION_NAME_MAX}</span>
          </label>
          {trimmed.length > ORGANIZATION_NAME_MAX && <p className={styles.hint}>O nome pode ter no máximo {ORGANIZATION_NAME_MAX} caracteres.</p>}
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
