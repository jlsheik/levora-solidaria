import React, { useState } from "react";
import { Spinner } from "./Spinner";
import { ApiRequestError } from "../helpers/apiRequestError";
import styles from "./GoogleButton.module.css";

export interface OauthStartButtonProps {
  intent: "login" | "signup" | "reauth";
  /** Só no cadastro: o código JÁ validado. Vai no CORPO do POST (nunca na URL) e fica apenas em memória. */
  accessCode?: string;
  /** Inicia o fluxo no servidor (state/nonce/PKCE só lá) e devolve a URL do provedor. */
  start: (body: { intent: "login" | "signup" | "reauth"; accessCode?: string }) => Promise<{ authorizationUrl: string }>;
  logo: React.ReactNode;
  /** Texto enquanto abre o provedor (ex.: "Abrindo o Google..."). */
  loadingLabel: string;
  /** Mensagem genérica de falha (ex.: "Não foi possível iniciar o login com o Google. Tente novamente."). */
  failureMessage: string;
  /** Mensagens por `code` do servidor (conjunto fechado). */
  messages: Record<string, string>;
  children: React.ReactNode;
}

const COMMON_MESSAGES: Record<string, string> = {
  codigo_indisponivel: "Código de acesso inválido ou indisponível. Confira o código ou peça um novo à plataforma.",
};

/**
 * Botão de provedor externo (Google/Microsoft). O servidor cria a tentativa e devolve a URL; o navegador só segue o redirecionamento.
 * Nada do provedor, do token ou do código de acesso é guardado no navegador.
 */
export const OauthStartButton: React.FC<OauthStartButtonProps> = ({ intent, accessCode, start, logo, loadingLabel, failureMessage, messages, children }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (loading) return; // impede cliques/signups simultâneos
    setError(null);
    setLoading(true);
    try {
      const { authorizationUrl } = await start(intent === "signup" ? { intent, accessCode } : { intent });
      window.location.assign(authorizationUrl);
    } catch (err) {
      setLoading(false);
      const all = { ...COMMON_MESSAGES, ...messages };
      if (err instanceof ApiRequestError && err.code && all[err.code]) setError(all[err.code]);
      else if (err instanceof ApiRequestError && err.status === 429) setError("Muitas tentativas. Aguarde um pouco antes de tentar de novo.");
      else setError(failureMessage);
    }
  };

  return (
    <div className={styles.wrap}>
      {error && <div className={styles.error} role="alert">{error}</div>}
      <button type="button" className={styles.button} onClick={run} disabled={loading} aria-busy={loading}>
        {loading ? <Spinner size="sm" /> : logo}
        <span>{loading ? loadingLabel : children}</span>
      </button>
    </div>
  );
};
