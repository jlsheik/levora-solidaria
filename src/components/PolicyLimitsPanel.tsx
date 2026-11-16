import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { getPolicyLimits, type PolicyLimitView } from "../endpoints/policy-limits_GET.schema";
import { postPolicyLimits } from "../endpoints/policy-limits_POST.schema";
import { Button } from "./Button";
import { Input } from "./Input";
import { Textarea } from "./Textarea";
import { Skeleton } from "./Skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import { LIMIT_COPY, fmtDateTime, fmtLimit, sameLimit, validateLimitDraft, type LimitValue } from "./agentOpsView";
import styles from "./AgentOps.module.css";

/**
 * Limites de autonomia: padrão em código, ajuste global (plataforma), restrição da organização e o valor EFETIVO (o mais restritivo, aplicado pelas regras). A organização só pode tornar o limite
 * mais restritivo; o formulário valida isso antes de enviar e o servidor valida de novo (e audita). O limite global não é editável aqui.
 */
export function PolicyLimitsPanel({ organizationId, canManage }: { organizationId: number; canManage: boolean }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["policy-limits", organizationId], queryFn: () => getPolicyLimits({ organizationId }), retry: false });
  const [editing, setEditing] = useState<PolicyLimitView | null>(null);
  const [draft, setDraft] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (value: LimitValue) => postPolicyLimits({ organizationId, key: editing!.key, value }),
    onSuccess: () => { toast.success("Limite salvo para esta organização."); close(); queryClient.invalidateQueries({ queryKey: ["policy-limits", organizationId] }); },
    onError: (e) => { setFailure(e instanceof Error ? e.message : "Não foi possível salvar o limite"); queryClient.invalidateQueries({ queryKey: ["policy-limits", organizationId] }); },
  });
  function close() { setEditing(null); setDraft(""); setFailure(null); mutation.reset(); }
  function open(l: PolicyLimitView) { setEditing(l); setFailure(null); const base = (l.organizationValue ?? l.effectiveValue); setDraft(Array.isArray(base) ? base.join(", ") : String(base)); }

  const validation = editing ? validateLimitDraft(editing.kind, draft, editing.globalValue) : null;
  const unchanged = editing && validation?.value !== null && validation?.value !== undefined && sameLimit(validation.value, editing.organizationValue ?? editing.effectiveValue);

  return (
    <section className={styles.section} aria-labelledby="limites-titulo" aria-busy={query.isFetching}>
      <h2 id="limites-titulo" className={styles.sectionTitle}><SlidersHorizontal size={18} aria-hidden="true" /> Limites de autonomia</h2>
      <p className={styles.help}>Acima destes limites, a ação de um agente <strong>não executa</strong>: vira uma exceção para uma pessoa decidir. Os valores padrão são conservadores. A organização pode <strong>apenas restringir</strong> (nunca afrouxar); vale sempre o mais restritivo entre o global e o da organização.</p>
      {query.isError ? (
        <div className={styles.error}>
          <p className={styles.errorText} role="alert">Não foi possível carregar os limites. {query.error instanceof Error ? query.error.message : ""}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>Tentar de novo</Button>
        </div>
      ) : !query.data ? (
        <Skeleton className={styles.skeleton} />
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.srOnly}>Limites de autonomia dos agentes</caption>
              <thead><tr><th scope="col">Limite</th><th scope="col">Padrão</th><th scope="col">Global</th><th scope="col">Desta organização</th><th scope="col">Em vigor</th>{canManage && <th scope="col"><span className={styles.srOnly}>Ação</span></th>}</tr></thead>
              <tbody>
                {query.data.limits.map((l) => {
                  const c = LIMIT_COPY[l.key] ?? { label: l.key, help: "", unit: null, effect: "" };
                  return (
                    <tr key={l.key}>
                      <th scope="row" style={{ textAlign: "left", fontWeight: 500 }}>{c.label}<br /><span className={styles.rowMeta}>{c.help} Ao ultrapassar: {c.effect}.</span></th>
                      <td>{fmtLimit(l.defaultValue, c.unit)}</td>
                      <td>{fmtLimit(l.globalValue, c.unit)}</td>
                      <td>{l.organizationValue === null ? "—" : fmtLimit(l.organizationValue, c.unit)}</td>
                      <td><strong>{fmtLimit(l.effectiveValue, c.unit)}</strong></td>
                      {canManage && <td><Button type="button" size="sm" variant="outline" onClick={() => open(l)} aria-label={`Editar o limite: ${c.label}`}>Editar</Button></td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className={styles.limitCards} aria-label="Limites de autonomia">
            {query.data.limits.map((l) => {
              const c = LIMIT_COPY[l.key] ?? { label: l.key, help: "", unit: null, effect: "" };
              return (
                <li key={l.key} className={styles.row}>
                  <div className={styles.rowMain}>
                    <h3 className={styles.rowTitle}>{c.label}</h3>
                    <span className={styles.rowMeta}>{c.help} Ao ultrapassar: {c.effect}.</span>
                    <dl className={styles.kv}><dt>Padrão</dt><dd>{fmtLimit(l.defaultValue, c.unit)}</dd><dt>Global</dt><dd>{fmtLimit(l.globalValue, c.unit)}</dd><dt>Desta organização</dt><dd>{l.organizationValue === null ? "—" : fmtLimit(l.organizationValue, c.unit)}</dd><dt>Em vigor</dt><dd><strong>{fmtLimit(l.effectiveValue, c.unit)}</strong></dd></dl>
                  </div>
                  {canManage && <div className={styles.rowActions}><Button type="button" size="sm" variant="outline" onClick={() => open(l)} aria-label={`Editar o limite: ${c.label}`}>Editar</Button></div>}
                </li>
              );
            })}
          </ul>
          {!canManage ? <p className={styles.help} style={{ marginTop: "0.75rem" }}>Somente leitura para o seu papel. Alterar limites exige a permissão de gerenciar automação (proprietário ou administrador).</p> : <p className={styles.help} style={{ marginTop: "0.75rem" }}>Permissão necessária para alterar: gerenciar automação (proprietário ou administrador). Cada alteração é registrada na auditoria.</p>}
          <h3 className={styles.rowTitle} style={{ marginTop: "1rem" }}>Histórico de alterações</h3>
          {!query.data.history || query.data.history.length === 0 ? (
            <p className={styles.empty} role="status">Nenhuma alteração de limite registrada. Os valores em vigor são os padrões em código. (A auditoria registra quem e quando, nunca o valor.)</p>
          ) : (
            <ul className={styles.history} aria-label="Histórico de alterações de limites">
              {query.data.history.map((h, i) => (<li key={i}>{fmtDateTime(h.at)} — <strong>{LIMIT_COPY[h.key]?.label ?? h.key}</strong> alterado · {h.scope === "global" ? "alteração global da plataforma" : `por ${h.byName ?? "um administrador"}`}</li>))}
            </ul>
          )}
        </>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => { if (!o && !mutation.isPending) close(); }}>
        <DialogContent>
          {editing && validation && (
            <form onSubmit={(ev) => { ev.preventDefault(); if (validation.value !== null && !unchanged) mutation.mutate(validation.value); }} className={styles.form}>
              <DialogHeader>
                <DialogTitle>{LIMIT_COPY[editing.key]?.label ?? editing.key}</DialogTitle>
                <DialogDescription>Valor global em vigor: <strong>{fmtLimit(editing.globalValue, LIMIT_COPY[editing.key]?.unit ?? null)}</strong>. {editing.kind === "number" ? "Você só pode informar um valor igual ou MENOR." : "Você só pode manter as categorias globais e ACRESCENTAR outras."}</DialogDescription>
              </DialogHeader>
              <p className={styles.help} style={{ margin: 0 }}>Impacto esperado: acima deste limite, a avaliação de um evento deixa de seguir automática e vira uma exceção ({LIMIT_COPY[editing.key]?.effect ?? "revisão"}). Tornar o limite mais restritivo faz mais eventos irem para revisão; eventos já avaliados não mudam.</p>
              <label className={styles.label} htmlFor="limite-valor">{editing.kind === "number" ? `Novo valor${LIMIT_COPY[editing.key]?.unit ? ` (${LIMIT_COPY[editing.key]!.unit})` : ""}` : "Categorias (separadas por vírgula)"}</label>
              {editing.kind === "number" ? <Input id="limite-valor" inputMode="decimal" value={draft} onChange={(ev) => setDraft(ev.target.value)} disabled={mutation.isPending} aria-invalid={!!validation.error || undefined} aria-describedby={validation.error ? "limite-erro" : undefined} /> : <Textarea id="limite-valor" value={draft} onChange={(ev) => setDraft(ev.target.value)} disabled={mutation.isPending} aria-invalid={!!validation.error || undefined} aria-describedby={validation.error ? "limite-erro" : undefined} />}
              {validation.error && <p id="limite-erro" className={styles.fieldError} role="alert">{validation.error}</p>}
              {failure && <p className={styles.errorText} role="alert">{failure}</p>}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close} disabled={mutation.isPending}>Cancelar</Button>
                <Button type="submit" disabled={mutation.isPending || validation.value === null || !!unchanged}>{mutation.isPending ? "Salvando..." : "Salvar limite"}</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
