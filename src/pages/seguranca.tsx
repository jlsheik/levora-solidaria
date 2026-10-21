import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { Skeleton } from "../components/Skeleton";
import { MfaSetupPanel } from "../components/MfaSetupPanel";
import { StepUpDialog } from "../components/StepUpDialog";
import { ApiRequestError } from "../helpers/apiRequestError";
import { getMfaStatus } from "../endpoints/auth/mfa-status_GET.schema";
import { postMfaRecoveryRegenerate } from "../endpoints/auth/mfa-recovery-regenerate_POST.schema";
import { postMfaDisable } from "../endpoints/auth/mfa-disable_POST.schema";
import mfa from "../components/mfa.module.css";
import styles from "./seguranca.module.css";

const STATUS_KEY = ["account", "mfa-status"] as const;

/** Segurança da conta: autenticador (TOTP), códigos de recuperação e desativação. Ações críticas pedem step-up. */
export default function SecurityPage() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: STATUS_KEY, queryFn: () => getMfaStatus(), staleTime: 0, refetchOnMount: "always" });
  const [stepUpFor, setStepUpFor] = useState<null | "regenerate" | "disable">(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: STATUS_KEY });

  const regenerate = useMutation({
    mutationFn: () => postMfaRecoveryRegenerate(),
    // Os códigos novos NÃO podem ficar no cache de mutações do React Query: gcTime 0 + reset() após copiar para o estado local
    // (que some ao clicar em "Já guardei" ou ao sair da página).
    gcTime: 0,
    onSuccess: (r) => {
      setCodes(r.recoveryCodes);
      regenerate.reset();
      refresh();
    },
    onError: (err) => {
      if (err instanceof ApiRequestError && err.code === "reauth_required") setStepUpFor("regenerate");
      else toast.error(err instanceof Error ? err.message : "Falha ao gerar códigos");
    },
  });
  const disable = useMutation({
    mutationFn: () => postMfaDisable(),
    onSuccess: () => {
      toast.success("Autenticador desativado");
      refresh();
    },
    onError: (err) => {
      if (err instanceof ApiRequestError && err.code === "reauth_required") setStepUpFor("disable");
      else toast.error(err instanceof Error ? err.message : "Falha ao desativar");
    },
  });

  const data = status.data;

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.backLink}>
        <ArrowLeft size={14} /> Voltar
      </Link>
      <h1 className={styles.title}>Segurança da conta</h1>
      <p className={styles.subtitle}>Proteja o acesso com um segundo fator.</p>

      <section className={styles.section} aria-labelledby="mfa-titulo">
        <h2 id="mfa-titulo" className={styles.sectionTitle}>
          <ShieldCheck size={16} style={{ verticalAlign: "-2px" }} /> Autenticador (TOTP)
        </h2>
        {status.isLoading ? (
          <Skeleton className={styles.skeleton} />
        ) : status.isError || !data ? (
          <div className={mfa.errorBox} role="alert">
            Não foi possível carregar o estado do autenticador.{" "}
            <Button variant="link" size="sm" onClick={() => void status.refetch()}>
              Tentar de novo
            </Button>
          </div>
        ) : data.active ? (
          <div className={mfa.stack}>
            <div>
              <Badge variant="success">Ativo</Badge>
            </div>
            <p className={mfa.hint}>
              Códigos de recuperação restantes: <strong>{data.recoveryCodesRemaining}</strong>
              {data.requiredByPolicy ? ". O autenticador é obrigatório para quem tem acesso à plataforma." : "."}
            </p>
            {codes && (
              <div className={mfa.stack}>
                <p className={mfa.hint}>Novos códigos (aparecem somente agora; os anteriores foram invalidados):</p>
                <ul className={mfa.codes}>
                  {codes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                <Button variant="outline" size="sm" onClick={() => setCodes(null)}>
                  Já guardei os códigos
                </Button>
              </div>
            )}
            <div className={mfa.actions}>
              <Button variant="outline" disabled={regenerate.isPending} onClick={() => regenerate.mutate()}>
                Gerar novos códigos de recuperação
              </Button>
              <Button variant="destructive" disabled={disable.isPending || data.requiredByPolicy} onClick={() => disable.mutate()}>
                Desativar
              </Button>
            </div>
          </div>
        ) : (
          <MfaSetupPanel
            mode="session"
            onDone={() => {
              toast.success("Autenticador ativado");
              refresh();
            }}
          />
        )}
      </section>

      <StepUpDialog
        open={stepUpFor !== null}
        onOpenChange={(open) => !open && setStepUpFor(null)}
        onConfirmed={() => {
          const action = stepUpFor;
          setStepUpFor(null);
          if (action === "regenerate") regenerate.mutate();
          if (action === "disable") disable.mutate();
        }}
      />
    </div>
  );
}
