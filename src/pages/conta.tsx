import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Eye, EyeOff, Monitor } from "lucide-react";
import { toast } from "sonner";
import { useAuth, AUTH_QUERY_KEY } from "../helpers/useAuth";
import { postProfile, DISPLAY_NAME_MAX } from "../endpoints/auth/profile_POST.schema";
import { postPasswordChange, newPasswordSchema } from "../endpoints/auth/password-change_POST.schema";
import { getSessions, type UserSessionInfo } from "../endpoints/auth/sessions_GET.schema";
import { postSessionRevoke } from "../endpoints/auth/sessions-revoke_POST.schema";
import { postSessionsRevokeOthers } from "../endpoints/auth/sessions-revoke-others_POST.schema";
import { Input } from "../components/Input";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { Skeleton } from "../components/Skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/Dialog";
import styles from "./conta.module.css";

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

function formatDateTime(value: Date | string | null): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function PasswordField({ id, label, value, onChange, autoComplete, error, help }: { id: string; label: string; value: string; onChange: (v: string) => void; autoComplete: string; error?: string | null; help?: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>{label}</label>
      <div className={styles.inputWrap}>
        <Input id={id} type={visible ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} aria-invalid={error ? true : undefined} />
        <Button type="button" variant="ghost" size="icon-sm" className={styles.toggle} onClick={() => setVisible((v) => !v)} aria-label={visible ? "Ocultar senha" : "Mostrar senha"} aria-pressed={visible}>
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </Button>
      </div>
      {help && !error && <span className={styles.fieldHelp}>{help}</span>}
      {error && <span className={styles.fieldError} role="alert">{error}</span>}
    </div>
  );
}

export default function AccountPage() {
  const { authState, onLogin } = useAuth();
  const queryClient = useQueryClient();
  const user = authState.type === "authenticated" ? authState.user : null;

  // ---- Perfil ----
  const [name, setName] = useState(user?.displayName ?? "");
  useEffect(() => { if (user) setName(user.displayName); }, [user?.displayName]);
  const nameTrimmed = name.trim();
  const nameError = nameTrimmed.length === 0 ? "Informe seu nome" : nameTrimmed.length > DISPLAY_NAME_MAX ? `No máximo ${DISPLAY_NAME_MAX} caracteres` : null;
  const profileMutation = useMutation({
    mutationFn: () => postProfile({ displayName: nameTrimmed }),
    onSuccess: ({ user: updated }) => {
      // O nome aparece no cabeçalho da Home e na equipe/auditoria das organizações: atualiza a sessão em memória e
      // invalida só os caches que exibem nomes de pessoas. Nenhum dado de outra conta está nesses caches.
      onLogin(updated);
      void queryClient.invalidateQueries({ queryKey: ["organization-members"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-log"] });
      toast.success("Nome atualizado");
    },
    onError: (e) => toast.error(errMsg(e, "Não foi possível salvar o perfil")),
  });

  // ---- Senha ----
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const parsedNew = newPasswordSchema.safeParse(next);
  const currentError = touched && current.length === 0 ? "Informe sua senha atual" : null;
  const newError = touched && !parsedNew.success ? parsedNew.error.issues[0].message : touched && next === current && next ? "A nova senha precisa ser diferente da atual" : null;
  const confirmError = touched && confirm !== next ? "A confirmação não é igual à nova senha" : null;
  const passwordMutation = useMutation({
    mutationFn: () => postPasswordChange({ currentPassword: current, newPassword: next }),
    onSuccess: (r) => {
      setCurrent(""); setNext(""); setConfirm(""); setTouched(false); setServerError(null);
      toast.success(r.revokedSessions > 0 ? `Senha alterada. ${r.revokedSessions} outra(s) sessão(ões) encerrada(s).` : "Senha alterada.");
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
    onError: (e) => {
      setServerError(errMsg(e, "Não foi possível alterar a senha"));
    },
  });
  const submitPassword = (ev: React.FormEvent) => {
    ev.preventDefault();
    setTouched(true);
    setServerError(null);
    if (!current || !parsedNew.success || next === current || confirm !== next) return;
    passwordMutation.mutate();
  };

  // ---- Sessões ----
  const sessionsQuery = useQuery({ queryKey: SESSIONS_KEY, queryFn: () => getSessions(), staleTime: 0, refetchOnMount: "always" });
  const refreshSessions = () => void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
  const [confirmAll, setConfirmAll] = useState(false);
  const revokeMutation = useMutation({
    mutationFn: (handle: string) => postSessionRevoke({ sessionHandle: handle }),
    onSuccess: () => { toast.success("Sessão encerrada"); refreshSessions(); },
    onError: (e) => { toast.error(errMsg(e, "Não foi possível encerrar a sessão")); refreshSessions(); },
  });
  const revokeAllMutation = useMutation({
    mutationFn: () => postSessionsRevokeOthers(),
    onSuccess: (r) => { setConfirmAll(false); toast.success(r.revoked > 0 ? `${r.revoked} sessão(ões) encerrada(s)` : "Não havia outras sessões"); refreshSessions(); },
    onError: (e) => { setConfirmAll(false); toast.error(errMsg(e, "Não foi possível encerrar as outras sessões")); refreshSessions(); },
  });

  const sessions: UserSessionInfo[] = sessionsQuery.data?.sessions ?? [];
  const others = sessions.filter((s) => !s.current);

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.backLink}><ArrowLeft size={14} /> Voltar</Link>
      <h1 className={styles.title}>Minha conta</h1>
      <p className={styles.subtitle}>{user?.email}</p>

      <section className={styles.section} aria-labelledby="perfil-titulo">
        <h2 id="perfil-titulo" className={styles.sectionTitle}>Perfil</h2>
        <p className={styles.sectionHint}>Seu nome aparece para as pessoas das suas organizações. O e-mail não pode ser alterado aqui.</p>
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); if (!nameError && nameTrimmed !== user?.displayName) profileMutation.mutate(); }}>
          <div className={styles.field}>
            <label htmlFor="conta-nome" className={styles.label}>Nome</label>
            <Input id="conta-nome" value={name} onChange={(e) => setName(e.target.value)} maxLength={DISPLAY_NAME_MAX + 20} autoComplete="name" aria-invalid={nameError ? true : undefined} />
            {nameError && <span className={styles.fieldError} role="alert">{nameError}</span>}
          </div>
          <div className={styles.actions}>
            <Button type="submit" disabled={!!nameError || nameTrimmed === user?.displayName || profileMutation.isPending}>
              {profileMutation.isPending ? "Salvando…" : "Salvar nome"}
            </Button>
          </div>
        </form>
      </section>

      <section className={styles.section} aria-labelledby="senha-titulo">
        <h2 id="senha-titulo" className={styles.sectionTitle}>Senha</h2>
        <p className={styles.sectionHint}>Ao trocar a senha, as suas outras sessões (outros dispositivos e navegadores) são encerradas. Esta continua ativa.</p>
        <form className={styles.form} onSubmit={submitPassword} noValidate>
          <PasswordField id="conta-senha-atual" label="Senha atual" value={current} onChange={setCurrent} autoComplete="current-password" error={currentError} />
          <PasswordField id="conta-senha-nova" label="Nova senha" value={next} onChange={setNext} autoComplete="new-password" error={newError} help="Pelo menos 8 caracteres (máximo de 72 bytes)." />
          <PasswordField id="conta-senha-confirmar" label="Confirmar nova senha" value={confirm} onChange={setConfirm} autoComplete="new-password" error={confirmError} />
          {serverError && <div className={styles.errorBox} role="alert">{serverError}</div>}
          <div className={styles.actions}>
            <Button type="submit" disabled={passwordMutation.isPending}>{passwordMutation.isPending ? "Alterando…" : "Alterar senha"}</Button>
          </div>
        </form>
      </section>

      <section className={styles.section} aria-labelledby="sessoes-titulo">
        <div className={styles.sessionHead}>
          <div>
            <h2 id="sessoes-titulo" className={styles.sectionTitle}>Sessões</h2>
            <p className={styles.sectionHint}>Lugares em que sua conta está conectada.</p>
          </div>
          {others.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => setConfirmAll(true)}>Sair de todas as outras</Button>
          )}
        </div>
        {sessionsQuery.isLoading ? (
          <Skeleton className={styles.skeleton} />
        ) : sessionsQuery.isError ? (
          <div className={styles.errorBox} role="alert">
            {errMsg(sessionsQuery.error, "Não foi possível carregar as sessões")}{" "}
            <Button variant="link" size="sm" onClick={() => void sessionsQuery.refetch()}>Tentar de novo</Button>
          </div>
        ) : (
          <>
            <ul className={styles.sessionList}>
              {sessions.map((s) => (
                <li key={s.sessionHandle} className={styles.sessionItem}>
                  <div className={styles.sessionInfo}>
                    <div className={styles.sessionTop}>
                      <Monitor size={14} />
                      <strong>{s.current ? "Esta sessão" : "Outra sessão"}</strong>
                      {s.current && <Badge variant="success">Atual</Badge>}
                    </div>
                    <span className={styles.sessionMeta}>Iniciada em {formatDateTime(s.createdAt)}</span>
                    <span className={styles.sessionMeta}>Último acesso {formatDateTime(s.lastAccessed)}</span>
                  </div>
                  {!s.current && (
                    <Button variant="outline" size="sm" disabled={revokeMutation.isPending} onClick={() => revokeMutation.mutate(s.sessionHandle)}>Encerrar</Button>
                  )}
                </li>
              ))}
            </ul>
            {others.length === 0 && <p className={styles.emptyText} style={{ marginTop: "var(--spacing-3)" }}>Nenhuma outra sessão ativa.</p>}
          </>
        )}
      </section>

      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sair de todas as outras sessões?</DialogTitle>
            <DialogDescription>
              {others.length} sessão(ões) serão encerradas. Quem estiver usando a conta nesses lugares precisará entrar de novo. Esta sessão continua ativa.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAll(false)}>Cancelar</Button>
            <Button variant="destructive" disabled={revokeAllMutation.isPending} onClick={() => revokeAllMutation.mutate()}>
              {revokeAllMutation.isPending ? "Encerrando…" : "Encerrar outras sessões"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const SESSIONS_KEY = ["account", "sessions"] as const;
