import React from "react";
import { OauthStartButton } from "./OauthStartButton";
import { postMicrosoftStart } from "../endpoints/auth/microsoft-start_POST.schema";
import styles from "./GoogleButton.module.css";

/** Marca da Microsoft (quatro quadrados, cores oficiais, decorativa: o rótulo textual é quem nomeia o botão). */
const MicrosoftLogo: React.FC = () => (
  <svg className={styles.logo} width="18" height="18" viewBox="0 0 21 21" aria-hidden="true" focusable="false">
    <rect x="1" y="1" width="9" height="9" fill="#F25022" />
    <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
    <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
    <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
  </svg>
);

interface MicrosoftButtonProps {
  intent: "login" | "signup" | "reauth";
  /** Só no cadastro: o código JÁ validado. Vai no CORPO do POST (nunca na URL) e fica apenas em memória. */
  accessCode?: string;
  children: React.ReactNode;
}

const MESSAGES: Record<string, string> = {
  microsoft_nao_vinculado: "Esta conta não está vinculada à Microsoft.",
  microsoft_nao_configurado: "Entrar com a Microsoft não está disponível neste ambiente.",
  microsoft_indisponivel: "Não foi possível falar com a Microsoft agora. Tente novamente em instantes.",
};

/** Inicia o fluxo Microsoft (contas pessoais e corporativas/escolares): o servidor cria a tentativa e devolve a URL; o navegador só segue o redirecionamento. */
export const MicrosoftButton: React.FC<MicrosoftButtonProps> = ({ intent, accessCode, children }) => (
  <OauthStartButton
    intent={intent}
    accessCode={accessCode}
    start={postMicrosoftStart}
    logo={<MicrosoftLogo />}
    loadingLabel="Abrindo a Microsoft..."
    failureMessage="Não foi possível iniciar o login com a Microsoft. Tente novamente."
    messages={MESSAGES}
  >
    {children}
  </OauthStartButton>
);
