import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, Copy, Plus } from "lucide-react";
import { getPlatformAccessCodes, type AccessCodeRow, type AccessCodeStatus } from "../endpoints/platform-access-codes_GET.schema";
import { postPlatformAccessCodesCreate, type OutputType as CreatedCode } from "../endpoints/platform-access-codes-create_POST.schema";
import { postPlatformAccessCodesRevoke } from "../endpoints/platform-access-codes-revoke_POST.schema";
import { ApiRequestError } from "../helpers/apiRequestError";
import { StepUpDialog } from "./StepUpDialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import { Button } from "./Button";
import { Input } from "./Input";
import { Skeleton } from "./Skeleton";
import styles from "./AccessCodesPanel.module.css";

const statusLabels: Record<AccessCodeStatus, string> = { active: "Ativo", redeemed: "Utilizado", revoked: "Revogado", expired: "Expirado" };

/** Presets de validade (minutos). Os limites reais (5 min … 90 dias) são decididos pelo servidor. */
const presets = [
  { label: "1 hora", minutes: 60 },
  { label: "24 horas", minutes: 24 * 60 },
  { label: "7 dias", minutes: 7 * 24 * 60 },
  { label: "30 dias", minutes: 30 * 24 * 60 },
] as const;

const fmt = (d: Date | string) => new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

type Pending = { kind: "create"; label: string; minutes: number | null; at: string } | { kind: "revoke"; id: number };

export const AccessCodesPanel: React.FC = () => {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AccessCodeStatus | "">("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [preset, setPreset] = useState<number | "custom">(24 * 60);
  const [customAt, setCustomAt] = useState(() => toLocalInput(new Date(Date.now() + 24 * 3600 * 1000)));
  const [created, setCreated] = useState<CreatedCode | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AccessCodeRow | null>(null);
  const [stepUp, setStepUp] = useState<Pending | null>(null);

  const listQuery = useQuery({
    queryKey: ["platform-access-codes", status, q, from, to],
    queryFn: () =>
      getPlatformAccessCodes({
        status: status || undefined,
        q: q.trim() || undefined,
        createdFrom: from ? new Date(`${from}T00:00:00`) : undefined,
        createdTo: to ? new Date(new Date(`${to}T00:00:00`).getTime() + 24 * 3600 * 1000) : undefined,
      }),
  });

  const createMutation = useMutation({
    gcTime: 0, // o resultado (com o código completo) não fica retido no cache de mutações do React Query
    mutationFn: (v: { label: string; minutes: number | null; at: string }) =>
      postPlatformAccessCodesCreate({ label: v.label || undefined, ...(v.minutes !== null ? { expiresInMinutes: v.minutes } : { expiresAt: new Date(v.at) }) }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["platform-access-codes"] });
      setCreateOpen(false);
      setCreated(result);
      setLabel("");
    },
    onError: (err, v) => {
      if (err instanceof ApiRequestError && err.code === "reauth_required") return setStepUp({ kind: "create", ...v });
      toast.error(err instanceof Error ? err.message : "Falha ao gerar o código");
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: number) => postPlatformAccessCodesRevoke({ id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["platform-access-codes"] });
      setRevokeTarget(null);
      toast.success("Código revogado");
    },
    onError: (err, id) => {
      if (err instanceof ApiRequestError && err.code === "reauth_required") return setStepUp({ kind: "revoke", id });
      setRevokeTarget(null);
      queryClient.invalidateQueries({ queryKey: ["platform-access-codes"] });
      toast.error(err instanceof Error ? err.message : "Falha ao revogar o código");
    },
  });

  const submitCreate = () => createMutation.mutate({ label: label.trim(), minutes: preset === "custom" ? null : preset, at: customAt });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Código copiado");
    } catch {
      toast.error("Não foi possível copiar. Selecione e copie manualmente.");
    }
  };

  const rows = listQuery.data?.codes ?? [];

  return (
    <section className={styles.panel} aria-labelledby="access-codes-title">
      <div className={styles.header}>
        <h2 id="access-codes-title" className={styles.title}><KeyRound size={18} aria-hidden /> Códigos de acesso</h2>
        <Button size="sm" onClick={() => setCreateOpen(true)}><Plus size={16} aria-hidden /> Gerar código</Button>
      </div>
      <p className={styles.hint}>Cada código libera a criação de uma única conta. Ele não é senha e é exibido completo somente no momento da geração.</p>

      <div className={styles.filters}>
        <label className={styles.field}>
          <span>Situação</span>
          <select className={styles.native} value={status} onChange={(e) => setStatus(e.target.value as AccessCodeStatus | "")}>
            <option value="">Todas</option>
            {Object.entries(statusLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span>Descrição, final ou usuário</span>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar" />
        </label>
        <label className={styles.field}>
          <span>Criado de</span>
          <input className={styles.native} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span>Criado até</span>
          <input className={styles.native} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>

      {listQuery.isLoading ? (
        <Skeleton style={{ height: "6rem" }} />
      ) : listQuery.isError ? (
        <p className={styles.empty} role="alert">Não foi possível carregar os códigos.</p>
      ) : rows.length === 0 ? (
        <p className={styles.empty}>Nenhum código encontrado.</p>
      ) : (
        <ul className={styles.list}>
          {rows.map((c) => (
            <li key={c.id} className={styles.row} data-testid="access-code-row">
              <div className={styles.rowTop}>
                <code className={styles.masked}>{c.masked}</code>
                <span className={styles.pill} data-status={c.status}><span className={styles.dot} aria-hidden />{statusLabels[c.status]}</span>
              </div>
              {c.label && <div className={styles.label}>{c.label}</div>}
              <dl className={styles.meta}>
                <div><dt>Criado em</dt><dd>{fmt(c.createdAt)}</dd></div>
                <div><dt>Expira em</dt><dd>{fmt(c.expiresAt)}</dd></div>
                <div><dt>Criado por</dt><dd>{c.createdBy.displayName}</dd></div>
                {c.redeemedAt && <div><dt>Usado em</dt><dd>{fmt(c.redeemedAt)}</dd></div>}
                {c.redeemedBy && <div><dt>Usado por</dt><dd>{c.redeemedBy.displayName}</dd></div>}
                {c.revokedAt && <div><dt>Revogado em</dt><dd>{fmt(c.revokedAt)}</dd></div>}
              </dl>
              {c.status === "active" && (
                <Button size="sm" variant="outline" onClick={() => setRevokeTarget(c)}>Revogar</Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className={styles.dialogScope}>
          <DialogHeader>
            <DialogTitle>Gerar código de acesso</DialogTitle>
            <DialogDescription>O código completo será exibido somente agora. Depois só o final ficará visível. Pode ser pedida a confirmação do autenticador.</DialogDescription>
          </DialogHeader>
          <div className={styles.form}>
            <label className={styles.field}>
              <span>Descrição (opcional)</span>
              <Input value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} placeholder="Ex.: Cliente piloto — Abrigo Esperança" />
            </label>
            <fieldset className={styles.presets}>
              <legend>Validade</legend>
              {presets.map((p) => (
                <Button key={p.minutes} type="button" size="sm" variant={preset === p.minutes ? "primary" : "outline"} aria-pressed={preset === p.minutes} onClick={() => setPreset(p.minutes)}>{p.label}</Button>
              ))}
              <Button type="button" size="sm" variant={preset === "custom" ? "primary" : "outline"} aria-pressed={preset === "custom"} onClick={() => setPreset("custom")}>Data e hora</Button>
            </fieldset>
            {preset === "custom" && (
              <label className={styles.field}>
                <span>Expira em (horário local)</span>
                <input className={styles.native} type="datetime-local" value={customAt} onChange={(e) => setCustomAt(e.target.value)} />
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancelar</Button>
            <Button onClick={submitCreate} disabled={createMutation.isPending}>{createMutation.isPending ? "Gerando..." : "Gerar código"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={created !== null} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent className={styles.dialogScope}>
          <DialogHeader>
            <DialogTitle>Código gerado</DialogTitle>
            <DialogDescription>Copie agora: este código não será exibido de novo. Se for perdido, revogue-o e gere outro.</DialogDescription>
          </DialogHeader>
          {created && (
            <div className={styles.reveal}>
              <code className={styles.full} data-testid="access-code-full">{created.code}</code>
              <p className={styles.hint}>Válido até {fmt(created.expiresAt)}.</p>
              <Button variant="outline" onClick={() => copy(created.code)}><Copy size={16} aria-hidden /> Copiar código</Button>
            </div>
          )}
          <DialogFooter><Button onClick={() => setCreated(null)}>Já copiei</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revokeTarget !== null} onOpenChange={(o) => !o && setRevokeTarget(null)}>
        <DialogContent className={styles.dialogScope}>
          <DialogHeader>
            <DialogTitle>Revogar código?</DialogTitle>
            <DialogDescription>O código {revokeTarget?.masked} deixará de funcionar imediatamente. Esta ação não pode ser desfeita.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)}>Cancelar</Button>
            <Button variant="destructive" disabled={revokeMutation.isPending} onClick={() => revokeTarget && revokeMutation.mutate(revokeTarget.id)}>Revogar código</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <StepUpDialog
        open={stepUp !== null}
        onOpenChange={(o) => !o && setStepUp(null)}
        onConfirmed={() => {
          const p = stepUp;
          setStepUp(null);
          if (!p) return;
          if (p.kind === "create") createMutation.mutate({ label: p.label, minutes: p.minutes, at: p.at });
          else revokeMutation.mutate(p.id);
        }}
      />
    </section>
  );
};
