import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "./Button";
import { Input } from "./Input";
import { Spinner } from "./Spinner";
import { ApiRequestError } from "../helpers/apiRequestError";
import { postPasswordResetValidate } from "../endpoints/auth/password-reset-validate_POST.schema";
import { postPasswordResetConfirm, newPasswordSchema, PASSWORD_MIN_LENGTH } from "../endpoints/auth/password-reset-confirm_POST.schema";
import styles from "./mfa.module.css";
import resetStyles from "./passwordReset.module.css";

type LinkProblem = "expirado" | "utilizado" | "invalido";
type Stage = { kind: "checking" } | { kind: "form"; mfaRequired: boolean } | { kind: "link"; problem: LinkProblem } | { kind: "unavailable" } | { kind: "done" };

const LINK_COPY: Record<LinkProblem, { title: string; text: string }> = {
  expirado: { title: "Este link expirou", text: "Por segurança, o link de redefinição vale por pouco tempo. Peça um novo para continuar." },
  utilizado: { title: "Este link já foi usado", text: "Cada link funciona uma única vez. Se a senha ainda não foi trocada, peça um novo." },
  invalido: { title: "Link inválido", text: "Este link não é válido ou foi substituído por um pedido mais recente. Peça um novo para continuar." },
};

/** Lê o token do FRAGMENTO (`#token=…`) e o remove da barra de endereço e do histórico: o token fica só na memória desta tela. */
export function takeTokenFromLocation(): string {
  const raw = window.location.hash.replace(/^#/, "");
  const token = new URLSearchParams(raw).get("token") ?? "";
  if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  return token;
}

/**
 * Redefinição de senha a partir do link do e-mail. Estados: verificando, formulário (com segundo fator quando a conta o exige), link expirado /
 * já usado / inválido, serviço temporariamente indisponível (com nova tentativa) e conclusão. Não mostra nada sobre a conta além do que o token válido
 * permite (só se há segundo fator).
 */
export const PasswordResetForm: React.FC = () => {
  const tokenRef = useRef<string | null>(null);
  if (tokenRef.current === null) tokenRef.current = takeTokenFromLocation();
  const token = tokenRef.current;

  const [stage, setStage] = useState<Stage>(token ? { kind: "checking" } : { kind: "link", problem: "invalido" });
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [mfaMode, setMfaMode] = useState<"totp" | "recovery">("totp");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const check = useCallback(async () => {
    if (!token) return;
    setStage({ kind: "checking" });
    try {
      const result = await postPasswordResetValidate({ token });
      setStage(result.state === "valido" ? { kind: "form", mfaRequired: result.mfaRequired } : { kind: "link", problem: result.state });
    } catch {
      setStage({ kind: "unavailable" });
    }
  }, [token]);

  useEffect(() => {
    void check();
  }, [check]);

  // Foco no título a cada mudança de estado: leitores de tela e teclado acompanham a transição.
  useEffect(() => {
    if (stage.kind !== "checking") heading.current?.focus();
  }, [stage.kind]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading || stage.kind !== "form") return;
    setError(null);
    setFieldError(null);
    const parsed = newPasswordSchema.safeParse(password);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? `A senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres`);
      return;
    }
    if (password !== confirmation) {
      setFieldError("As senhas não são iguais.");
      return;
    }
    if (stage.mfaRequired && code.trim() === "") {
      setError("Informe o código de verificação em duas etapas.");
      return;
    }
    setLoading(true);
    try {
      await postPasswordResetConfirm({
        token,
        newPassword: password,
        ...(stage.mfaRequired ? (mfaMode === "totp" ? { totpCode: code.replace(/\s/g, "") } : { recoveryCode: code }) : {}),
      });
      setPassword("");
      setConfirmation("");
      setCode("");
      setStage({ kind: "done" });
    } catch (err) {
      if (err instanceof ApiRequestError) {
        if (err.code === "link_expirado") setStage({ kind: "link", problem: "expirado" });
        else if (err.code === "link_utilizado") setStage({ kind: "link", problem: "utilizado" });
        else if (err.code === "link_invalido") setStage({ kind: "link", problem: "invalido" });
        else if (err.code === "senha_igual") setFieldError("A nova senha precisa ser diferente da atual.");
        else if (err.code === "mfa_obrigatorio") setError("Informe o código de verificação em duas etapas.");
        else if (err.code === "mfa_invalido") {
          setError(mfaMode === "totp" ? "Código incorreto. Confira o código atual do aplicativo." : "Código de recuperação inválido ou já utilizado.");
          setCode("");
        } else if (err.code === "mfa_bloqueado" || err.status === 429) setError("Muitas tentativas incorretas. Aguarde um pouco ou use um código de recuperação.");
        else if (err.status === 400) setFieldError(err.message);
        else setError("Não foi possível redefinir a senha agora. Tente novamente em instantes.");
      } else {
        setError("Não foi possível redefinir a senha agora. Verifique sua conexão e tente de novo.");
      }
    } finally {
      setLoading(false);
    }
  };

  if (stage.kind === "checking") {
    return (
      <div className={styles.stack} aria-busy="true">
        <h1 className={styles.title}>Verificando o link…</h1>
        <div className={resetStyles.center} role="status">
          <Spinner size="sm" /> <span>Aguarde um instante.</span>
        </div>
      </div>
    );
  }

  if (stage.kind === "unavailable") {
    return (
      <div className={styles.stack}>
        <h1 className={styles.title} ref={heading} tabIndex={-1}>
          Serviço temporariamente indisponível
        </h1>
        <div className={styles.errorBox} role="alert">
          Não conseguimos verificar o link agora. Seu link continua valendo; tente de novo em instantes.
        </div>
        <div className={styles.actions}>
          <Button type="button" onClick={() => void check()}>
            Tentar novamente
          </Button>
          <Button asChild variant="outline">
            <Link to="/login" className={resetStyles.linkInButton}>
              Voltar ao login
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  if (stage.kind === "link") {
    const copy = LINK_COPY[stage.problem];
    return (
      <div className={styles.stack}>
        <h1 className={styles.title} ref={heading} tabIndex={-1}>
          {copy.title}
        </h1>
        <div className={styles.infoBox} role="status">
          {copy.text}
        </div>
        <div className={styles.actions}>
          <Button asChild>
            <Link to="/recuperar-senha" className={resetStyles.linkInButton}>
              Pedir um novo link
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/login" className={resetStyles.linkInButton}>
              Voltar ao login
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  if (stage.kind === "done") {
    return (
      <div className={styles.stack}>
        <h1 className={styles.title} ref={heading} tabIndex={-1}>
          Senha redefinida
        </h1>
        <div className={styles.infoBox} role="status">
          Pronto! Sua senha foi alterada e todas as sessões abertas foram encerradas. Entre com a nova senha. Se a sua conta tem verificação em duas etapas,
          ela continua sendo exigida no login.
        </div>
        <div className={styles.actions}>
          <Button asChild>
            <Link to="/login" className={resetStyles.linkInButton}>
              Ir para o login
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form className={styles.stack} onSubmit={submit} noValidate aria-labelledby="reset-title">
      <h1 className={styles.title} id="reset-title" ref={heading} tabIndex={-1}>
        Escolha uma nova senha
      </h1>
      <p className={styles.hint}>
        Use pelo menos {PASSWORD_MIN_LENGTH} caracteres. Depois de salvar, todas as sessões abertas serão encerradas.
      </p>
      {error && (
        <div className={styles.errorBox} role="alert" id="reset-error">
          {error}
        </div>
      )}
      <div className={styles.field}>
        <label htmlFor="reset-password" className={styles.label}>
          Nova senha
        </label>
        <Input
          id="reset-password"
          type="password"
          value={password}
          disabled={loading}
          autoComplete="new-password"
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? "reset-field-error" : undefined}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="reset-password-confirm" className={styles.label}>
          Confirme a nova senha
        </label>
        <Input
          id="reset-password-confirm"
          type="password"
          value={confirmation}
          disabled={loading}
          autoComplete="new-password"
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? "reset-field-error" : undefined}
          onChange={(e) => setConfirmation(e.target.value)}
        />
        {fieldError && (
          <div className={resetStyles.fieldError} role="alert" id="reset-field-error">
            {fieldError}
          </div>
        )}
      </div>
      {stage.mfaRequired && (
        <div className={styles.field}>
          <label htmlFor="reset-mfa" className={styles.label}>
            {mfaMode === "totp" ? "Código do autenticador" : "Código de recuperação"}
          </label>
          <Input
            id="reset-mfa"
            className={mfaMode === "totp" ? styles.codeInput : undefined}
            value={code}
            disabled={loading}
            autoComplete="one-time-code"
            inputMode={mfaMode === "totp" ? "numeric" : "text"}
            autoCapitalize={mfaMode === "totp" ? "off" : "characters"}
            spellCheck={false}
            maxLength={mfaMode === "totp" ? 7 : 24}
            placeholder={mfaMode === "totp" ? "000000" : "XXXX-XXXX-XXXX-XXXX"}
            onChange={(e) => setCode(mfaMode === "totp" ? e.target.value.replace(/[^\d\s]/g, "") : e.target.value.toUpperCase())}
          />
          <p className={styles.hint}>Sua conta tem verificação em duas etapas; o link do e-mail sozinho não basta.</p>
          <Button
            type="button"
            variant="link"
            size="sm"
            className={styles.linkButton}
            disabled={loading}
            onClick={() => {
              setMfaMode(mfaMode === "totp" ? "recovery" : "totp");
              setCode("");
              setError(null);
            }}
          >
            {mfaMode === "totp" ? "Usar um código de recuperação" : "Usar o aplicativo autenticador"}
          </Button>
        </div>
      )}
      <div className={styles.actions}>
        <Button type="submit" disabled={loading || password === "" || confirmation === ""}>
          {loading ? (
            <>
              <Spinner size="sm" /> Salvando…
            </>
          ) : (
            "Redefinir senha"
          )}
        </Button>
        <Button asChild variant="outline">
          <Link to="/login" className={resetStyles.linkInButton}>
            Cancelar
          </Link>
        </Button>
      </div>
    </form>
  );
};
