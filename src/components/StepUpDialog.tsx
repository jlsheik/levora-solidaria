import React, { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./Dialog";
import { Button } from "./Button";
import { Input } from "./Input";
import { Spinner } from "./Spinner";
import { ApiRequestError } from "../helpers/apiRequestError";
import { postStepUp } from "../endpoints/auth/step-up_POST.schema";
import styles from "./mfa.module.css";

interface StepUpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Chamado depois do step-up concluído (a sessão já foi rotacionada); repita a ação crítica aqui. */
  onConfirmed: () => void;
}

/** Reautenticação com o segundo fator para ações críticas (403 `reauth_required`). Não cria sessão paralela. */
export const StepUpDialog: React.FC<StepUpDialogProps> = ({ open, onOpenChange, onConfirmed }) => {
  const [mode, setMode] = useState<"totp" | "recovery">("totp");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await postStepUp(mode === "totp" ? { code: value } : { recoveryCode: value });
      setValue("");
      onOpenChange(false);
      onConfirmed();
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 429) setError("Muitas tentativas incorretas. Aguarde um pouco antes de tentar de novo.");
      else if (err instanceof ApiRequestError && err.status === 401) setError("Código incorreto. Se acabou de usar este código, aguarde o próximo (30 s).");
      else if (err instanceof ApiRequestError && err.code === "mfa_nao_configurado") setError(err.message);
      else setError("Não foi possível confirmar. Verifique sua conexão e tente de novo.");
      setValue("");
    } finally {
      setLoading(false);
    }
  };

  const canSubmit = mode === "totp" ? /^\d{6}$/.test(value.replace(/\s/g, "")) : value.replace(/[\s-]/g, "").length >= 16;

  return (
    <Dialog open={open} onOpenChange={(next) => !loading && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirme sua identidade</DialogTitle>
          <DialogDescription>Esta ação é crítica. Informe o código do seu autenticador para continuar.</DialogDescription>
        </DialogHeader>
        <form className={styles.stack} onSubmit={submit} noValidate>
          {error && (
            <div className={styles.errorBox} role="alert">
              {error}
            </div>
          )}
          <div className={styles.field}>
            <label htmlFor="stepup-code" className={styles.label}>
              {mode === "totp" ? "Código do autenticador" : "Código de recuperação"}
            </label>
            <Input
              id="stepup-code"
              className={mode === "totp" ? styles.codeInput : undefined}
              value={value}
              disabled={loading}
              autoFocus
              autoComplete="one-time-code"
              inputMode={mode === "totp" ? "numeric" : "text"}
              maxLength={mode === "totp" ? 7 : 24}
              placeholder={mode === "totp" ? "000000" : "XXXX-XXXX-XXXX-XXXX"}
              onChange={(ev) => setValue(mode === "totp" ? ev.target.value.replace(/[^\d\s]/g, "") : ev.target.value.toUpperCase())}
            />
          </div>
          <div className={styles.actions}>
            <Button type="submit" disabled={loading || !canSubmit}>
              {loading ? (
                <>
                  <Spinner size="sm" /> Confirmando…
                </>
              ) : (
                "Confirmar"
              )}
            </Button>
            <Button type="button" variant="outline" disabled={loading} onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
          </div>
          <Button
            type="button"
            variant="link"
            size="sm"
            className={styles.linkButton}
            disabled={loading}
            onClick={() => {
              setMode(mode === "totp" ? "recovery" : "totp");
              setValue("");
              setError(null);
            }}
          >
            {mode === "totp" ? "Usar um código de recuperação" : "Usar o aplicativo autenticador"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
};
