import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/Tabs";
import { PasswordLoginForm } from "../components/PasswordLoginForm";
import { PasswordRegisterForm } from "../components/PasswordRegisterForm";
import { MfaCodeForm } from "../components/MfaCodeForm";
import { MfaSetupPanel } from "../components/MfaSetupPanel";
import { useAuth } from "../helpers/useAuth";
import { HeartHandshake } from "lucide-react";
import styles from "./login.module.css";

/** Retorno do callback do Google: só um conjunto FECHADO de códigos curtos (nunca texto do Google, nunca tokens, nunca o código de acesso). */
const GOOGLE_MESSAGES: Record<string, string> = {
  nao_vinculada: "Não encontramos uma conta LEVORA vinculada a esta conta Google. Para criar uma conta, use um código de acesso na aba “Criar conta”.",
  ja_cadastrada: "Esta conta Google já está cadastrada. Use “Entrar com Google” na aba “Entrar”.",
  codigo_indisponivel: "O código de acesso não está mais disponível. Peça um novo à plataforma.",
  cancelado: "O login com o Google foi cancelado.",
  limite: "Muitas tentativas. Aguarde um pouco antes de tentar de novo.",
  falha: "Não foi possível concluir o login com o Google. Tente novamente.",
};

type GoogleReturn = { kind: "mfa" | "mfa_setup" } | { kind: "erro"; message: string } | null;

function readGoogleReturn(params: URLSearchParams): GoogleReturn {
  const google = params.get("google");
  if (google === "mfa" || google === "mfa_setup") return { kind: google };
  if (google === "erro") return { kind: "erro", message: GOOGLE_MESSAGES[params.get("motivo") ?? ""] ?? GOOGLE_MESSAGES.falha };
  return null;
}

export default function LoginPage() {
  const [params, setParams] = useSearchParams();
  const [googleReturn, setGoogleReturn] = useState<GoogleReturn>(() => readGoogleReturn(params));
  const { onLogin } = useAuth();
  const navigate = useNavigate();

  // O retorno vem na URL só como código curto; limpa a barra de endereço (replace: sem entrada extra no histórico).
  useEffect(() => {
    if (params.has("google") || params.has("motivo")) setParams({}, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = (user?: Parameters<typeof onLogin>[0]) => {
    if (user) onLogin(user);
    setTimeout(() => navigate("/"), 200);
  };
  const restart = () => setGoogleReturn(null);

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <HeartHandshake className={styles.brandIcon} size={28} />
          <span className={styles.brandName}>Levora Solidária</span>
        </div>
        <p className={styles.tagline}>
          Infraestrutura de solidariedade: doações rastreadas do recebimento à
          prestação de contas.
        </p>

        {googleReturn?.kind === "mfa" ? (
          <MfaCodeForm onVerified={finish} onRestart={restart} />
        ) : googleReturn?.kind === "mfa_setup" ? (
          <MfaSetupPanel
            mode="challenge"
            intro="Contas com acesso à plataforma precisam de um segundo fator. Configure o autenticador para entrar."
            onRestart={restart}
            onDone={finish}
          />
        ) : (
          <>
            {googleReturn?.kind === "erro" && (
              <div className={styles.googleError} role="alert">
                {googleReturn.message}
              </div>
            )}
            <Tabs defaultValue="entrar" className={styles.tabs}>
              <TabsList className={styles.tabsList}>
                <TabsTrigger value="entrar">Entrar</TabsTrigger>
                <TabsTrigger value="cadastro">Criar conta</TabsTrigger>
              </TabsList>
              <TabsContent value="entrar" className={styles.tabsContent}>
                <PasswordLoginForm />
              </TabsContent>
              <TabsContent value="cadastro" className={styles.tabsContent}>
                <PasswordRegisterForm />
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>
    </div>
  );
}
