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

/** Retorno do callback do provedor (Google/Microsoft): só um conjunto FECHADO de códigos curtos (nunca texto do provedor, nunca tokens, nunca o código de acesso). */
const PROVIDER_NAMES = { google: "Google", microsoft: "Microsoft" } as const;
const messagesFor = (name: string): Record<string, string> => ({
  nao_vinculada: `Não encontramos uma conta LEVORA vinculada a esta conta ${name}. Para criar uma conta, use um código de acesso na aba “Criar conta”.`,
  ja_cadastrada: `Esta conta ${name} já está cadastrada. Use “Entrar com ${name}” na aba “Entrar”.`,
  codigo_indisponivel: "O código de acesso não está mais disponível. Peça um novo à plataforma.",
  email_nao_verificado: name === "Microsoft"
    ? "O cadastro pela Microsoft está indisponível por enquanto. Crie a conta com e-mail e senha usando o seu código de acesso (o código não foi usado)."
    : `O ${name} não confirmou que este e-mail é seu, então a conta não foi criada. Confirme o e-mail na sua conta ${name} e tente de novo, ou crie a conta com e-mail e senha (o código de acesso não foi usado).`,
  cancelado: `O login com ${name === "Microsoft" ? "a" : "o"} ${name} foi cancelado.`,
  limite: "Muitas tentativas. Aguarde um pouco antes de tentar de novo.",
  falha: `Não foi possível concluir o login com ${name === "Microsoft" ? "a" : "o"} ${name}. Tente novamente.`,
});

type ProviderReturn = { kind: "mfa" | "mfa_setup" } | { kind: "erro"; message: string } | null;

function readProviderReturn(params: URLSearchParams): ProviderReturn {
  for (const provider of ["google", "microsoft"] as const) {
    const value = params.get(provider);
    if (value === "mfa" || value === "mfa_setup") return { kind: value };
    if (value === "erro") {
      const messages = messagesFor(PROVIDER_NAMES[provider]);
      return { kind: "erro", message: messages[params.get("motivo") ?? ""] ?? messages.falha };
    }
  }
  return null;
}

export default function LoginPage() {
  const [params, setParams] = useSearchParams();
  const [providerReturn, setProviderReturn] = useState<ProviderReturn>(() => readProviderReturn(params));
  const { onLogin } = useAuth();
  const navigate = useNavigate();

  // O retorno vem na URL só como código curto; limpa a barra de endereço (replace: sem entrada extra no histórico).
  useEffect(() => {
    if (params.has("google") || params.has("microsoft") || params.has("motivo")) setParams({}, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = (user?: Parameters<typeof onLogin>[0]) => {
    if (user) onLogin(user);
    setTimeout(() => navigate("/"), 200);
  };
  const restart = () => setProviderReturn(null);

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

        {providerReturn?.kind === "mfa" ? (
          <MfaCodeForm onVerified={finish} onRestart={restart} />
        ) : providerReturn?.kind === "mfa_setup" ? (
          <MfaSetupPanel
            mode="challenge"
            intro="Contas com acesso à plataforma precisam de um segundo fator. Configure o autenticador para entrar."
            onRestart={restart}
            onDone={finish}
          />
        ) : (
          <>
            {providerReturn?.kind === "erro" && (
              <div className={styles.googleError} role="alert">
                {providerReturn.message}
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
