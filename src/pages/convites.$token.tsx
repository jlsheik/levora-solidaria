import React, { useEffect, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { getOrganizationInvitesLookup } from "../endpoints/organization-invites-lookup_GET.schema";
import { postOrganizationInvitesAccept } from "../endpoints/organization-invites-accept_POST.schema";
import { useAuth } from "../helpers/useAuth";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/Tabs";
import { PasswordLoginForm } from "../components/PasswordLoginForm";
import { PasswordRegisterForm } from "../components/PasswordRegisterForm";
import { Spinner } from "../components/Spinner";
import { HeartHandshake, CheckCircle2, XCircle } from "lucide-react";
import styles from "./convites.$token.module.css";

const roleLabels: Record<string, string> = {
  administrador: "Administrador",
  operador: "Operador",
  voluntario: "Voluntário",
};

const invalidReasonMessages: Record<string, string> = {
  nao_encontrado: "Este link de convite não é válido.",
  expirado: "Este convite expirou. Peça para quem convidou enviar um novo.",
  ja_usado: "Este convite já foi utilizado.",
  revogado: "Este convite foi revogado por quem o criou.",
};

export default function AcceptInvitePage() {
  const params = useParams<{ token: string }>();
  const token = params.token ?? "";
  const navigate = useNavigate();
  const { authState } = useAuth();
  const [acceptedTriggered, setAcceptedTriggered] = useState(false);
  const autoAcceptAttempted = useRef(false);
  // Fase 51 (SEC-03): PasswordRegisterForm não loga mais automaticamente
  // (ver docs/SECURITY.md) — depois de um cadastro enviado, troca para a
  // aba "Já tenho conta" em vez de deixar a pessoa parada sem próximo
  // passo óbvio.
  const [authTab, setAuthTab] = useState<"entrar" | "cadastro">("cadastro");
  const [justSubmittedRegistration, setJustSubmittedRegistration] = useState(false);

  const lookupQuery = useQuery({
    queryKey: ["organization-invites-lookup", token],
    queryFn: () => getOrganizationInvitesLookup({ token }),
    enabled: token.length > 0,
  });

  const acceptMutation = useMutation({
    mutationFn: () => postOrganizationInvitesAccept({ token }),
    onSuccess: (data) => {
      setTimeout(() => navigate(`/organizacoes/${data.organizationId}`), 1200);
    },
  });

  const invite = lookupQuery.data;
  const isAuthenticated = authState.type === "authenticated";
  const emailMatches =
    isAuthenticated && invite?.valid && invite.email
      ? authState.user.email.toLowerCase() === invite.email.toLowerCase()
      : false;

  // Assim que a pessoa está logada com o e-mail certo, aceita automaticamente
  // — evita um clique extra depois de já ter passado por login/cadastro.
  useEffect(() => {
    if (emailMatches && !autoAcceptAttempted.current && !acceptMutation.isPending && !acceptMutation.isSuccess) {
      autoAcceptAttempted.current = true;
      setAcceptedTriggered(true);
      acceptMutation.mutate();
    }
  }, [emailMatches, acceptMutation]);

  if (!token || lookupQuery.isFetching) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <Spinner size="md" />
        </div>
      </div>
    );
  }

  if (!invite || !invite.valid) {
    const reason = invite?.reason ?? "nao_encontrado";
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.iconRow}>
            <XCircle size={32} className={styles.errorIcon} />
          </div>
          <p className={styles.message}>{invalidReasonMessages[reason] ?? invalidReasonMessages.nao_encontrado}</p>
          <Link to="/" className={styles.backLink}>
            Voltar ao início
          </Link>
        </div>
      </div>
    );
  }

  if (acceptMutation.isSuccess) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.iconRow}>
            <CheckCircle2 size={32} className={styles.successIcon} />
          </div>
          <p className={styles.message}>
            Convite aceito! Você agora faz parte de {acceptMutation.data.organizationName} como{" "}
            {roleLabels[acceptMutation.data.role] ?? acceptMutation.data.role}. Redirecionando...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <HeartHandshake className={styles.brandIcon} size={28} />
          <span className={styles.brandName}>Levora Solidária</span>
        </div>
        <p className={styles.tagline}>
          Você foi convidado(a) para participar de <strong>{invite.organizationName}</strong> como{" "}
          <strong>{roleLabels[invite.role ?? ""] ?? invite.role}</strong>.
        </p>

        {isAuthenticated && !emailMatches && (
          <p className={styles.warning}>
            Este convite foi enviado para <strong>{invite.email}</strong>, mas você está conectado(a) com outra
            conta. Saia e entre com a conta correspondente para aceitar.
          </p>
        )}

        {isAuthenticated && emailMatches && (acceptedTriggered || acceptMutation.isPending) && (
          <div className={styles.iconRow}>
            <Spinner size="md" />
            <span>Aceitando convite...</span>
          </div>
        )}

        {isAuthenticated && emailMatches && acceptMutation.isError && (
          <p className={styles.warning}>
            {acceptMutation.error instanceof Error ? acceptMutation.error.message : "Não foi possível aceitar o convite."}
          </p>
        )}

        {!isAuthenticated && (
          <>
            <p className={styles.instructions}>
              Entre com uma conta que use o e-mail <strong>{invite.email}</strong>, ou crie uma conta agora, para
              aceitar o convite.
            </p>
            <Tabs
              value={authTab}
              onValueChange={(value) => setAuthTab(value as "entrar" | "cadastro")}
              className={styles.tabs}
            >
              <TabsList className={styles.tabsList}>
                <TabsTrigger value="entrar">Já tenho conta</TabsTrigger>
                <TabsTrigger value="cadastro">Criar conta</TabsTrigger>
              </TabsList>
              <TabsContent value="entrar" className={styles.tabsContent}>
                {justSubmittedRegistration && (
                  <p className={styles.instructions}>
                    Cadastro enviado — entre com o e-mail e a senha que você acabou de definir.
                  </p>
                )}
                <PasswordLoginForm redirectTo={`/convites/${token}`} />
              </TabsContent>
              <TabsContent value="cadastro" className={styles.tabsContent}>
                <PasswordRegisterForm
                  defaultValues={{ email: invite.email }}
                  onSubmitted={() => {
                    setJustSubmittedRegistration(true);
                    setAuthTab("entrar");
                  }}
                />
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>
    </div>
  );
}
