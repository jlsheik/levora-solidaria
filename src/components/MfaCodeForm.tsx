import React, { useState } from "react";
import { Button } from "./Button";
import { Input } from "./Input";
import { Spinner } from "./Spinner";
import { ApiRequestError } from "../helpers/apiRequestError";
import { postMfaVerify } from "../endpoints/auth/mfa-verify_POST.schema";
import type { User } from "../helpers/User";
import styles from "./mfa.module.css";

interface MfaCodeFormProps {
  onVerified: (user: User) => void;
  /** Volta ao login (challenge expirou/esgotou ou a pessoa desistiu). */
  onRestart: () => void;
}

/** Segundo fator do login: código do autenticador (6 dígitos) ou código de recuperação (uso único). */
export const MfaCodeForm: React.FC<MfaCodeFormProps> = ({ onVerified, onRestart }) => {
  const [mode, setMode] = useState<"totp" | "recovery">("totp");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dead, setDead] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading || dead) return;
    setError(null);
    setLoading(true);
    try {
      const result = await postMfaVerify(mode === "totp" ? { code: value } : { recoveryCode: value });
      onVerified(result.user);
    } catch (err) {
      if (err instanceof ApiRequestError && (err.code === "challenge_invalido" || err.code === "challenge_esgotado")) {
        setDead(true);
        setError(err.message);
      } else if (err instanceof ApiRequestError && err.status === 429) {
        setError("Muitas tentativas incorretas. Aguarde um pouco antes de tentar de novo.");
      } else if (err instanceof ApiRequestError && err.status === 401) {
        setError(mode === "totp" ? "Código incorreto. Confira o código atual do aplicativo." : "Código de recuperação inválido ou já utilizado.");
      } else {
        setError("Não foi possível verificar. Verifique sua conexão e tente de novo.");
      }
      setValue("");
    } finally {
      setLoading(false);
    }
  };

  const canSubmit = mode === "totp" ? /^\d{6}$/.test(value.replace(/\s/g, "")) : value.replace(/[\s-]/g, "").length >= 16;

  return (
    <form className={styles.stack} onSubmit={submit} noValidate>
      <h2 className={styles.title}>Confirme que é você</h2>
      <p className={styles.hint}>
        {mode === "totp"
          ? "Digite o código de 6 dígitos do seu aplicativo autenticador (Google Authenticator, Microsoft Authenticator ou similar)."
          : "Digite um dos códigos de recuperação que você guardou. Cada código funciona uma única vez."}
      </p>
      {error && (
        <div className={styles.errorBox} role="alert">
          {error}
        </div>
      )}
      {!dead && (
        <div className={styles.field}>
          <label htmlFor="mfa-code" className={styles.label}>
            {mode === "totp" ? "Código do autenticador" : "Código de recuperação"}
          </label>
          <Input
            id="mfa-code"
            className={mode === "totp" ? styles.codeInput : undefined}
            value={value}
            disabled={loading}
            autoFocus
            autoComplete="one-time-code"
            inputMode={mode === "totp" ? "numeric" : "text"}
            autoCapitalize={mode === "totp" ? "off" : "characters"}
            spellCheck={false}
            maxLength={mode === "totp" ? 7 : 24}
            placeholder={mode === "totp" ? "000000" : "XXXX-XXXX-XXXX-XXXX"}
            onChange={(ev) => setValue(mode === "totp" ? ev.target.value.replace(/[^\d\s]/g, "") : ev.target.value.toUpperCase())}
          />
        </div>
      )}
      <div className={styles.actions}>
        {dead ? (
          <Button type="button" onClick={onRestart}>
            Voltar ao login
          </Button>
        ) : (
          <>
            <Button type="submit" disabled={loading || !canSubmit}>
              {loading ? (
                <>
                  <Spinner size="sm" /> Verificando…
                </>
              ) : (
                "Verificar"
              )}
            </Button>
            <Button type="button" variant="outline" onClick={onRestart} disabled={loading}>
              Cancelar
            </Button>
          </>
        )}
      </div>
      {!dead && (
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
      )}
    </form>
  );
};
