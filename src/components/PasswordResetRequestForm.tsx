import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "./Button";
import { Input } from "./Input";
import { Spinner } from "./Spinner";
import { ApiRequestError } from "../helpers/apiRequestError";
import { postPasswordResetRequest, schema } from "../endpoints/auth/password-reset-request_POST.schema";
import styles from "./mfa.module.css";
import resetStyles from "./passwordReset.module.css";

/** Intervalo mínimo entre dois pedidos pela interface (o servidor tem o próprio cooldown de 60 s e limites por IP/e-mail). */
export const RESEND_COOLDOWN_SECONDS = 60;

type Stage = "form" | "sent";

/**
 * Pedido de redefinição de senha. A confirmação é SEMPRE a mesma mensagem genérica (o servidor responde igual exista a conta ou não): a tela nunca
 * diz se o e-mail tem conta. Reenvio controlado com contagem regressiva; limite de pedidos (429) e falha temporária têm mensagens próprias.
 */
export const PasswordResetRequestForm: React.FC = () => {
  const [email, setEmail] = useState("");
  const [stage, setStage] = useState<Stage>("form");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [wait, setWait] = useState(0);
  const sentHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const t = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(t);
  }, [wait]);

  useEffect(() => {
    if (stage === "sent") sentHeading.current?.focus();
  }, [stage]);

  const send = async () => {
    setError(null);
    const parsed = schema.safeParse({ email });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Informe um e-mail válido");
      return;
    }
    setLoading(true);
    try {
      const result = await postPasswordResetRequest(parsed.data);
      setMessage(result.message);
      setStage("sent");
      setWait(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 429) setError("Muitos pedidos em pouco tempo. Aguarde alguns minutos antes de tentar de novo.");
      else if (err instanceof ApiRequestError && err.status === 400) setError("Informe um e-mail válido.");
      else setError("Não foi possível enviar o pedido agora. Verifique sua conexão e tente de novo em instantes.");
    } finally {
      setLoading(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!loading) void send();
  };

  if (stage === "sent") {
    return (
      <div className={styles.stack}>
        <h1 className={styles.title} ref={sentHeading} tabIndex={-1}>
          Confira seu e-mail
        </h1>
        <div className={styles.infoBox} role="status">
          {message}
        </div>
        <p className={styles.hint}>O link vale por tempo limitado e só pode ser usado uma vez. Se não chegar em alguns minutos, confira a caixa de spam.</p>
        {error && (
          <div className={styles.errorBox} role="alert">
            {error}
          </div>
        )}
        <div className={styles.actions}>
          <Button type="button" variant="outline" disabled={loading || wait > 0} onClick={() => void send()}>
            {loading ? (
              <>
                <Spinner size="sm" /> Enviando…
              </>
            ) : wait > 0 ? (
              `Reenviar em ${wait} s`
            ) : (
              "Reenviar e-mail"
            )}
          </Button>
          <Button asChild>
            <Link to="/login" className={resetStyles.linkInButton}>
              Voltar ao login
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form className={styles.stack} onSubmit={submit} noValidate aria-labelledby="reset-request-title">
      <h1 className={styles.title} id="reset-request-title">
        Esqueci minha senha
      </h1>
      <p className={styles.hint}>Informe o e-mail da sua conta. Se ela existir, enviaremos um link para você escolher uma nova senha.</p>
      {error && (
        <div className={styles.errorBox} role="alert" id="reset-request-error">
          {error}
        </div>
      )}
      <div className={styles.field}>
        <label htmlFor="reset-email" className={styles.label}>
          E-mail
        </label>
        <Input
          id="reset-email"
          type="email"
          value={email}
          disabled={loading}
          autoFocus
          autoComplete="email"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="voce@email.com"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "reset-request-error" : undefined}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className={styles.actions}>
        <Button type="submit" disabled={loading || email.trim() === ""}>
          {loading ? (
            <>
              <Spinner size="sm" /> Enviando…
            </>
          ) : (
            "Enviar link"
          )}
        </Button>
        <Button asChild variant="outline">
          <Link to="/login" className={resetStyles.linkInButton}>
            Voltar ao login
          </Link>
        </Button>
      </div>
    </form>
  );
};
