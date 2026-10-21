import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { HeartHandshake } from "lucide-react";
import { Button } from "../components/Button";
import { Input } from "../components/Input";
import { Spinner } from "../components/Spinner";
import { MfaSetupPanel } from "../components/MfaSetupPanel";
import { ApiRequestError } from "../helpers/apiRequestError";
import { useAuth } from "../helpers/useAuth";
import { postBootstrapActivate } from "../endpoints/auth/bootstrap-activate_POST.schema";
import { postBootstrapCredentials } from "../endpoints/auth/bootstrap-credentials_POST.schema";
import { newPasswordSchema } from "../helpers/passwordPolicy";
import mfa from "../components/mfa.module.css";
import styles from "./login.module.css";

type Step = "token" | "credentials" | "totp";

/**
 * Ativação do Platform Owner (bootstrap offline). O token vem do CLI no servidor e é colado AQUI — nunca em URL (URL aparece em
 * logs e histórico). O token não é guardado em storage nem registrado no console; o campo é limpo ao avançar.
 * Nada vira conta até o último passo: a transação final cria usuário, senha, acesso de owner e MFA juntos.
 */
export default function PlatformActivatePage() {
  const navigate = useNavigate();
  const { onLogin } = useAuth();
  const [step, setStep] = useState<Step>("token");
  const [token, setToken] = useState("");
  const [info, setInfo] = useState<{ purpose: "owner" | "owner_recovery"; email: string } | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isRecovery = info?.purpose === "owner_recovery";

  const restart = () => {
    setStep("token");
    setToken("");
    setInfo(null);
    setError("A ativação expirou ou foi encerrada. Gere um novo token no servidor.");
  };

  const activate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await postBootstrapActivate({ token });
      setInfo({ purpose: result.purpose, email: result.email });
      setToken("");
      setStep("credentials");
    } catch (err) {
      setError(err instanceof ApiRequestError && err.status === 429 ? "Muitas tentativas. Aguarde antes de tentar de novo." : err instanceof ApiRequestError && err.status === 401 ? "Token inválido, expirado ou já utilizado." : "Não foi possível verificar. Verifique sua conexão e tente de novo.");
    } finally {
      setLoading(false);
    }
  };

  const passwordProblem = password.length > 0 ? (() => {
    const parsed = newPasswordSchema.safeParse(password);
    return parsed.success ? null : parsed.error.issues[0].message;
  })() : null;
  const mismatch = confirmPassword.length > 0 && confirmPassword !== password;
  const credentialsReady = isRecovery ? (password.length === 0 || (!passwordProblem && !mismatch && confirmPassword === password)) : name.trim().length > 0 && password.length > 0 && !passwordProblem && confirmPassword === password;

  const saveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await postBootstrapCredentials({ ...(name.trim() ? { displayName: name.trim() } : {}), ...(password ? { password } : {}) });
      setPassword("");
      setConfirmPassword("");
      setStep("totp");
    } catch (err) {
      if (err instanceof ApiRequestError && (err.code === "challenge_invalido" || err.code === "challenge_esgotado")) restart();
      else setError(err instanceof ApiRequestError ? err.message : "Não foi possível salvar. Tente novamente.");
    } finally {
      setLoading(false);
    }
  };

  const steps: Array<[Step, string]> = [["token", "1. Token"], ["credentials", isRecovery ? "2. Senha" : "2. Conta"], ["totp", "3. Autenticador"]];

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <HeartHandshake className={styles.brandIcon} size={28} />
          <span className={styles.brandName}>Levora Solidária</span>
        </div>
        <p className={styles.tagline}>{isRecovery ? "Recuperação do proprietário da plataforma" : "Ativação do proprietário da plataforma"}</p>
        <div className={mfa.steps} aria-label="Etapas">
          {steps.map(([key, label]) => (
            <span key={key} className={key === step ? mfa.stepActive : undefined} aria-current={key === step ? "step" : undefined}>
              {label}
            </span>
          ))}
        </div>

        {error && step !== "totp" && (
          <div className={mfa.errorBox} role="alert" style={{ marginTop: "var(--spacing-4)" }}>
            {error}
          </div>
        )}

        {step === "token" && (
          <form className={mfa.stack} onSubmit={activate} noValidate style={{ marginTop: "var(--spacing-4)" }}>
            <p className={mfa.hint}>Cole o token de ativação exibido uma única vez no terminal do servidor (válido por 15 minutos, uso único).</p>
            <div className={mfa.field}>
              <label htmlFor="bootstrap-token" className={mfa.label}>
                Token de ativação
              </label>
              <Input
                id="bootstrap-token"
                value={token}
                disabled={loading}
                autoFocus
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="LEVB-XXXX-XXXX-…"
                onChange={(ev) => setToken(ev.target.value)}
              />
            </div>
            <div className={mfa.actions}>
              <Button type="submit" disabled={loading || token.trim().length < 8}>
                {loading ? (
                  <>
                    <Spinner size="sm" /> Verificando…
                  </>
                ) : (
                  "Continuar"
                )}
              </Button>
            </div>
          </form>
        )}

        {step === "credentials" && info && (
          <form className={mfa.stack} onSubmit={saveCredentials} noValidate style={{ marginTop: "var(--spacing-4)" }}>
            <div className={mfa.infoBox}>
              Conta: <strong>{info.email}</strong>
            </div>
            {!isRecovery && (
              <div className={mfa.field}>
                <label htmlFor="bootstrap-name" className={mfa.label}>
                  Nome
                </label>
                <Input id="bootstrap-name" value={name} disabled={loading} autoComplete="name" maxLength={80} onChange={(ev) => setName(ev.target.value)} />
              </div>
            )}
            <div className={mfa.field}>
              <label htmlFor="bootstrap-password" className={mfa.label}>
                {isRecovery ? "Nova senha (opcional)" : "Senha"}
              </label>
              <Input id="bootstrap-password" type="password" autoComplete="new-password" value={password} disabled={loading} onChange={(ev) => setPassword(ev.target.value)} />
              <span className={mfa.hint}>{passwordProblem ?? "Pelo menos 8 caracteres (máximo de 72 bytes)."}</span>
            </div>
            {(password.length > 0 || !isRecovery) && (
              <div className={mfa.field}>
                <label htmlFor="bootstrap-confirm" className={mfa.label}>
                  Confirmar senha
                </label>
                <Input id="bootstrap-confirm" type="password" autoComplete="new-password" value={confirmPassword} disabled={loading} onChange={(ev) => setConfirmPassword(ev.target.value)} />
                {mismatch && <span className={mfa.hint}>As senhas não são iguais.</span>}
              </div>
            )}
            <div className={mfa.actions}>
              <Button type="submit" disabled={loading || !credentialsReady}>
                {loading ? (
                  <>
                    <Spinner size="sm" /> Salvando…
                  </>
                ) : (
                  "Continuar"
                )}
              </Button>
            </div>
          </form>
        )}

        {step === "totp" && (
          <div style={{ marginTop: "var(--spacing-4)" }}>
            {error && (
              <div className={mfa.errorBox} role="alert" style={{ marginBottom: "var(--spacing-3)" }}>
                {error}
              </div>
            )}
            <MfaSetupPanel
              mode="challenge"
              intro={isRecovery ? "O autenticador anterior será substituído e todas as sessões do proprietário serão encerradas." : "O acesso de proprietário só existe com o segundo fator ativo. A conta é criada somente ao concluir esta etapa."}
              onRestart={restart}
              onDone={(user) => {
                if (user) onLogin(user);
                setTimeout(() => navigate("/plataforma"), 200);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
