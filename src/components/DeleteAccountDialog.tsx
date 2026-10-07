import React, { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import { Button } from "./Button";
import { Input } from "./Input";
import { GoogleButton } from "./GoogleButton";
import { MicrosoftButton } from "./MicrosoftButton";
import { StepUpDialog } from "./StepUpDialog";
import { ApiRequestError } from "../helpers/apiRequestError";
import { postAccountDelete } from "../endpoints/auth/account-delete_POST.schema";
import { getAccountMethods } from "../endpoints/auth/account-methods_GET.schema";
import styles from "./DeleteAccountDialog.module.css";

interface DeleteAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Chamado depois da exclusão (a sessão já foi encerrada pelo servidor). */
  onDeleted: () => void;
  /** Quando a pessoa acabou de voltar de uma reautenticação bem-sucedida. */
  justReauthenticated?: boolean;
}

/**
 * Exclusão de conta. Conta COM senha: confirma a senha. Conta SEM senha (ex.: só Google ou só Microsoft): NÃO há senha inventada — digita-se "EXCLUIR" e
 * confirma-se a identidade de novo com o provedor ("reautenticar identidade"); com MFA ativo, o step-up do autenticador também é pedido.
 * Toda a decisão é do servidor (esta tela só reage aos códigos `reauth_social_required` e `reauth_required`).
 */
export const DeleteAccountDialog: React.FC<DeleteAccountDialogProps> = ({ open, onOpenChange, onDeleted, justReauthenticated }) => {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [needsSocialReauth, setNeedsSocialReauth] = useState(false);
  const [stepUp, setStepUp] = useState(false);

  const methods = useQuery({ queryKey: ["account-methods"], queryFn: () => getAccountMethods(), enabled: open });
  const passwordless = methods.data ? !methods.data.hasPassword : false;

  const mutation = useMutation({
    mutationFn: () => postAccountDelete(passwordless ? { confirmation: confirmation as "EXCLUIR" } : { password }),
    onSuccess: () => {
      setPassword("");
      setConfirmation("");
      onDeleted();
    },
    onError: (err) => {
      if (err instanceof ApiRequestError && err.code === "reauth_social_required") return setNeedsSocialReauth(true);
      if (err instanceof ApiRequestError && err.code === "reauth_required") return setStepUp(true);
      toast.error(err instanceof Error ? err.message : "Não foi possível excluir a conta");
    },
  });

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setPassword("");
      setConfirmation("");
      setNeedsSocialReauth(false);
    }
  };

  const canSubmit = passwordless ? confirmation === "EXCLUIR" : password.length > 0;

  return (
    <>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Excluir minha conta</DialogTitle>
            <DialogDescription>
              Isto encerra sua sessão em todos os dispositivos e remove seus dados pessoais (e-mail, nome). Ações que você já realizou
              continuam registradas na trilha de auditoria das organizações (exigido para rastreabilidade), mas sem seu nome/e-mail
              associado. Esta ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit && !mutation.isPending) mutation.mutate();
            }}
          >
            {methods.isLoading ? (
              <p className={styles.hint}>Carregando...</p>
            ) : passwordless ? (
              <>
                <label className={styles.field}>
                  <span>Para confirmar, digite EXCLUIR</span>
                  <Input value={confirmation} autoComplete="off" onChange={(e) => setConfirmation(e.target.value)} />
                </label>
                {justReauthenticated && !needsSocialReauth && <p className={styles.ok}>Identidade confirmada. Agora confirme a exclusão.</p>}
                {needsSocialReauth && (
                  <div className={styles.reauth} role="group" aria-label="Confirmar identidade">
                    {methods.data?.providers.includes("microsoft") ? (
                      <>
                        <p className={styles.hint}>Por segurança, confirme sua identidade novamente com a Microsoft antes de excluir.</p>
                        <MicrosoftButton intent="reauth">Confirmar com a Microsoft</MicrosoftButton>
                      </>
                    ) : (
                      <>
                        <p className={styles.hint}>Por segurança, confirme sua identidade novamente com o Google antes de excluir.</p>
                        <GoogleButton intent="reauth">Confirmar com o Google</GoogleButton>
                      </>
                    )}
                  </div>
                )}
              </>
            ) : (
              <label className={styles.field}>
                <span>Confirme sua senha</span>
                <Input type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
              </label>
            )}
            <DialogFooter>
              <Button type="submit" variant="destructive" disabled={mutation.isPending || methods.isLoading || !canSubmit}>
                {mutation.isPending ? "Excluindo..." : "Excluir minha conta"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <StepUpDialog
        open={stepUp}
        onOpenChange={setStepUp}
        onConfirmed={() => {
          setStepUp(false);
          mutation.mutate();
        }}
      />
    </>
  );
};
