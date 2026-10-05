import React, { useState } from "react";
import { Button } from "./Button";
import { Input } from "./Input";
import { Spinner } from "./Spinner";
import { QrCode } from "./QrCode";
import { ApiRequestError } from "../helpers/apiRequestError";
import { postMfaSetupBegin } from "../endpoints/auth/mfa-setup-begin_POST.schema";
import { postMfaSetupConfirm } from "../endpoints/auth/mfa-setup-confirm_POST.schema";
import type { User } from "../helpers/User";
import styles from "./mfa.module.css";

interface MfaSetupPanelProps {
  /** `challenge`: fluxo de login/bootstrap (a senha já foi provada); `session`: ativação voluntária (pede a senha). */
  mode: "challenge" | "session";
  /** Chamado quando a pessoa confirma que guardou os recovery codes. `user` só vem no modo challenge (a confirmação cria a sessão). */
  onDone: (user?: User) => void;
  /** Challenge esgotado/expirado: volta ao início do fluxo. */
  onRestart?: () => void;
  intro?: string;
}

type Stage = "start" | "scan" | "codes";

/**
 * Configuração do TOTP: gerar segredo → QR/chave manual → digitar o código → só então "ativo" → recovery codes (exibidos UMA vez).
 * O backend nunca devolve os códigos de recuperação de novo; a interface obriga a confirmar que foram guardados.
 */
export const MfaSetupPanel: React.FC<MfaSetupPanelProps> = ({ mode, onDone, onRestart, intro }) => {
  const [stage, setStage] = useState<Stage>("start");
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<{ otpauthUri: string; manualKey: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [pendingUser, setPendingUser] = useState<User | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleError = (err: unknown, fallback: string) => {
    if (err instanceof ApiRequestError && (err.code === "challenge_invalido" || err.code === "challenge_esgotado")) {
      setError(err.message);
      onRestart?.();
    } else if (err instanceof ApiRequestError && err.code === "configuracao_descartada") {
      setError(err.message);
      setStage("start");
      setSetup(null);
    } else if (err instanceof ApiRequestError && err.status === 401 && err.code === "senha_incorreta") {
      setError("Senha incorreta.");
    } else if (err instanceof ApiRequestError && err.status === 401) {
      setError("Código incorreto. Confira o código atual do aplicativo.");
    } else if (err instanceof ApiRequestError && err.status === 409 && err.code === "ativacao_falhou") {
      setError(err.message);
    } else if (err instanceof ApiRequestError) {
      setError(err.message || fallback);
    } else {
      setError(fallback);
    }
  };

  const begin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      setSetup(await postMfaSetupBegin(mode === "session" ? { password } : {}));
      setStage("scan");
      setPassword("");
    } catch (err) {
      handleError(err, "Não foi possível iniciar. Tente novamente.");
    } finally {
      setLoading(false);
    }
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await postMfaSetupConfirm({ code });
      setCodes(result.recoveryCodes);
      setPendingUser(result.user);
      setStage("codes");
    } catch (err) {
      handleError(err, "Não foi possível confirmar. Tente novamente.");
      setCode("");
    } finally {
      setLoading(false);
    }
  };

  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      setCopied(false);
      setError("Não foi possível copiar automaticamente. Selecione os códigos e copie manualmente.");
    }
  };

  if (stage === "start") {
    return (
      <form className={styles.stack} onSubmit={begin} noValidate>
        <h2 className={styles.title}>Configurar o autenticador</h2>
        <p className={styles.hint}>{intro ?? "Use um aplicativo autenticador (Google Authenticator, Microsoft Authenticator ou similar) para gerar códigos de 6 dígitos."}</p>
        {error && (
          <div className={styles.errorBox} role="alert">
            {error}
          </div>
        )}
        {mode === "session" && (
          <div className={styles.field}>
            <label htmlFor="mfa-setup-password" className={styles.label}>
              Confirme sua senha
            </label>
            <Input id="mfa-setup-password" type="password" autoComplete="current-password" value={password} disabled={loading} onChange={(ev) => setPassword(ev.target.value)} />
          </div>
        )}
        <div className={styles.actions}>
          <Button type="submit" disabled={loading || (mode === "session" && password.length === 0)}>
            {loading ? (
              <>
                <Spinner size="sm" /> Gerando…
              </>
            ) : (
              "Gerar QR code"
            )}
          </Button>
        </div>
      </form>
    );
  }

  if (stage === "scan" && setup) {
    return (
      <form className={styles.stack} onSubmit={confirm} noValidate>
        <h2 className={styles.title}>Escaneie e confirme</h2>
        <p className={styles.hint}>Abra o aplicativo autenticador, escolha “adicionar conta” e escaneie o QR code. Depois digite o código de 6 dígitos que ele mostrar.</p>
        <div className={styles.qrWrap}>
          <QrCode value={setup.otpauthUri} label="QR code para configurar o autenticador" />
          <p className={styles.hint}>Sem câmera? Digite esta chave no aplicativo:</p>
          <div className={styles.manualKey} aria-label="Chave de configuração manual">
            {setup.manualKey.replace(/(.{4})/g, "$1 ").trim()}
          </div>
        </div>
        {error && (
          <div className={styles.errorBox} role="alert">
            {error}
          </div>
        )}
        <div className={styles.field}>
          <label htmlFor="mfa-setup-code" className={styles.label}>
            Código do autenticador
          </label>
          <Input
            id="mfa-setup-code"
            className={styles.codeInput}
            value={code}
            disabled={loading}
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={7}
            placeholder="000000"
            onChange={(ev) => setCode(ev.target.value.replace(/[^\d\s]/g, ""))}
          />
        </div>
        <div className={styles.actions}>
          <Button type="submit" disabled={loading || !/^\d{6}$/.test(code.replace(/\s/g, ""))}>
            {loading ? (
              <>
                <Spinner size="sm" /> Confirmando…
              </>
            ) : (
              "Ativar autenticador"
            )}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className={styles.stack}>
      <h2 className={styles.title}>Guarde seus códigos de recuperação</h2>
      <p className={styles.hint}>
        Se você perder o acesso ao aplicativo, cada código abaixo entra uma única vez. Eles aparecem <strong>somente agora</strong> — o sistema não consegue mostrá-los de novo.
      </p>
      <ul className={styles.codes} aria-label="Códigos de recuperação">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      {error && (
        <div className={styles.errorBox} role="alert">
          {error}
        </div>
      )}
      <div className={styles.actions}>
        <Button type="button" variant="outline" onClick={copyCodes}>
          {copied ? "Copiado" : "Copiar códigos"}
        </Button>
      </div>
      <label className={styles.check}>
        <input type="checkbox" checked={saved} onChange={(ev) => setSaved(ev.target.checked)} />
        <span>Guardei estes códigos em um lugar seguro.</span>
      </label>
      <div className={styles.actions}>
        <Button type="button" disabled={!saved} onClick={() => onDone(pendingUser)}>
          Concluir
        </Button>
      </div>
    </div>
  );
};
