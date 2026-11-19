import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { getAuditTrace, type HistoricalDecisionView } from "../endpoints/audit-trace_GET.schema";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Skeleton } from "./Skeleton";
import { TRACE_STEP_LABEL, actionLabel, outcomeBadge, outcomeLabel } from "./auditCenterView";
import styles from "./AuditCenter.module.css";

export type TraceStart = { kind: "oportunidade" | "execucao" | "excecao" | "correlacao"; id: string };

const fmt = (iso: string) => new Date(iso).toLocaleString("pt-BR");
const KIND_LABEL: Record<TraceStart["kind"], string> = { oportunidade: "Oportunidade nº", execucao: "Execução do agente nº", excecao: "Exceção nº", correlacao: "Correlação (UUID)" };

/**
 * Rastreabilidade (M38): Oportunidade → Evento → Avaliação → Decisão → Exceção/revisão humana → Reavaliação → Auditoria. Só vínculos que o sistema persiste; onde faltam, o passo diz
 * "sem registro de auditoria associado". A decisão histórica é mostrada COMO FOI, ao lado dos dados atuais — nada é recalculado nem anulado por esta tela.
 */
export function AuditTracePanel({ organizationId, start, onStartChange, onOpenEntry, onNavigate }: { organizationId: number; start: TraceStart | null; onStartChange: (s: TraceStart | null) => void; onOpenEntry: (id: string) => void; onNavigate: (href: string) => void }) {
  const [kind, setKind] = useState<TraceStart["kind"]>(start?.kind ?? "oportunidade");
  const [value, setValue] = useState(start?.id ?? "");
  React.useEffect(() => { if (start) { setKind(start.kind); setValue(start.id); } }, [start]);

  const valid = kind === "correlacao" ? /^[0-9a-fA-F-]{36}$/.test(value) : /^[0-9]{1,18}$/.test(value);
  const q = useQuery({
    queryKey: ["audit-trace", organizationId, start],
    queryFn: () => getAuditTrace({ organizationId, ...(start!.kind === "oportunidade" ? { opportunityId: Number(start!.id) } : start!.kind === "execucao" ? { runId: start!.id } : start!.kind === "excecao" ? { exceptionId: start!.id } : { correlationId: start!.id }) }),
    enabled: !!start,
    retry: false,
  });
  const t = q.data;

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="at-inicio">
        <h2 id="at-inicio" className={styles.sectionTitle}><GitBranch size={18} aria-hidden="true" /> Rastreabilidade</h2>
        <p className={styles.help}>Siga uma operação do início ao registro de auditoria: oportunidade, evento, avaliação do Risk Engine, decisão, exceção e revisão humana, reavaliação e auditoria. Informe por onde começar.</p>
        <form className={styles.startForm} onSubmit={(e) => { e.preventDefault(); if (valid) onStartChange({ kind, id: value }); }} aria-label="Ponto de partida da rastreabilidade">
          <label className={styles.field}><span className={styles.fieldLabel}>Começar por</span>
            <select className={styles.control} value={kind} onChange={(e) => { setKind(e.target.value as TraceStart["kind"]); setValue(""); }}>
              {(Object.keys(KIND_LABEL) as TraceStart["kind"][]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </label>
          <label className={styles.field}><span className={styles.fieldLabel}>{KIND_LABEL[kind]}</span><input className={styles.control} value={value} onChange={(e) => setValue(e.target.value.trim())} inputMode={kind === "correlacao" ? "text" : "numeric"} autoComplete="off" aria-invalid={value !== "" && !valid} maxLength={36} /></label>
          <Button type="submit" size="sm" disabled={!valid}>Rastrear</Button>
        </form>
        {value !== "" && !valid && <p className={styles.help} role="alert" style={{ color: "var(--destructive)", marginTop: "0.5rem" }}>{kind === "correlacao" ? "Informe um identificador no formato UUID." : "Informe apenas números."}</p>}
      </section>

      {!start ? <p className={styles.empty}>Escolha um ponto de partida acima, ou abra a rastreabilidade a partir de uma oportunidade, da justificativa de um agente ou de um registro da trilha.</p>
        : q.isLoading ? <div aria-busy="true"><Skeleton className={styles.skeleton} /><Skeleton className={styles.skeleton} /></div>
        : q.isError ? <div className={styles.error} role="alert"><span>{(q.error as Error).message}</span><Button variant="outline" size="sm" onClick={() => q.refetch()}>Tentar de novo</Button></div>
        : t ? (
          <>
            {t.opportunity && (
              <section className={styles.section} aria-labelledby="at-opp">
                <h2 id="at-opp" className={styles.sectionTitle}>Oportunidade</h2>
                <dl className={styles.kv}>
                  <dt>Título</dt><dd>{t.opportunity.title} (#{t.opportunity.id})</dd>
                  <dt>Situação atual</dt><dd>{t.opportunity.status}</dd>
                  <dt>Categoria atual</dt><dd>{t.opportunity.currentCategory ?? "sem categoria"} · versão {t.opportunity.version}</dd>
                </dl>
                <button type="button" className={styles.link} onClick={() => onNavigate(`/organizacoes/${organizationId}/oportunidades?destaque=${t.opportunity!.id}`)}>Abrir a oportunidade</button>
              </section>
            )}

            {t.decisions.length > 0 && (
              <section className={styles.section} aria-labelledby="at-dec">
                <h2 id="at-dec" className={styles.sectionTitle}>Decisões históricas × dados atuais</h2>
                <p className={styles.help}>Cada decisão abaixo foi tomada com os dados daquele momento e continua exatamente como foi registrada. Quando a categoria muda depois, a decisão <strong>não é recalculada nem anulada</strong>: a diferença apenas é mostrada.</p>
                {t.decisions.map((d) => <DecisionCard key={d.runId} d={d} organizationId={organizationId} onOpenEntry={onOpenEntry} onNavigate={onNavigate} />)}
              </section>
            )}

            <section className={styles.section} aria-labelledby="at-linha">
              <h2 id="at-linha" className={styles.sectionTitle}>Linha do tempo</h2>
              <p className={styles.help}>{t.journey.correlationId ? <>Correlação persistida da jornada: <span className={styles.code}>{t.journey.correlationId}</span>. Ela foi gerada no servidor na origem da operação e copiada para o evento, a execução do agente, a exceção e os registros de auditoria.</> : <>Esta jornada <strong>não tem correlação persistida</strong> (é anterior à M39): os vínculos mostrados são só por entidade, e nenhuma correlação foi fabricada.</>} A ordem abaixo é a do horário registrado: ela <strong>não prova</strong> que um passo causou o seguinte — só valem os vínculos indicados em cada passo.</p>
              {t.steps.length === 0 ? <p className={styles.empty}>Não há passos persistidos para este ponto de partida.</p> : (
                <ol className={styles.timeline}>
                  {t.steps.map((s, i) => (
                    <li key={`${s.key}-${s.at}-${i}`} className={styles.step}>
                      <div className={styles.rowBadges}><Badge variant="secondary">{TRACE_STEP_LABEL[s.key] ?? s.key}</Badge><span className={styles.stepMeta}>{fmt(s.at)}{s.actor ? ` · ${s.actor}` : ""}</span></div>
                      <div className={styles.stepTitle}>{s.title}</div>
                      {s.detail && <div className={styles.stepMeta}>{s.detail}</div>}
                      <div className={styles.linkRow}>
                        {s.auditEntryId ? (
                          <>
                            <button type="button" className={styles.link} onClick={() => onOpenEntry(s.auditEntryId!)}>Ver o registro de auditoria #{s.auditEntryId}</button>
                            <Badge variant="outline">{s.linkKind === "direta" ? "Registro diretamente associado" : "Registro relacionado por correlação persistida"}</Badge>
                          </>
                        ) : <span className={styles.stepMeta}>Sem vínculo verificável com um registro de auditoria.</span>}
                        {s.correlationId && <span className={styles.code}>correlação {s.correlationId.slice(0, 8)}…</span>}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className={styles.section} aria-labelledby="at-aud">
              <h2 id="at-aud" className={styles.sectionTitle}>Registros de auditoria envolvidos</h2>
              {t.auditEntries.length === 0 ? <p className={styles.empty}>Nenhum registro de auditoria está vinculado a estes recursos.</p> : (
                <ul className={styles.list}>
                  {t.auditEntries.map((e) => (
                    <li key={e.id} className={styles.row}>
                      <div className={styles.rowMain}>
                        <span className={styles.rowTitle}>{actionLabel(e.action)}</span>
                        <span className={styles.rowMeta}>{fmt(e.createdAt)} · {e.actorName ?? "—"} · registro #{e.id}</span>
                        <span className={styles.rowBadges}>
                          <Badge variant={outcomeBadge(e.outcome)}>{outcomeLabel(e.outcome)}</Badge>
                          <Badge variant="outline">{e.link === "direta" ? "Associado diretamente (mesma entidade)" : "Relacionado por correlação persistida"}</Badge>
                        </span>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => onOpenEntry(e.id)} aria-label={`Ver o registro ${e.id}`}>Detalhes</Button>
                    </li>
                  ))}
                </ul>
              )}
              <ul className={styles.limits}>{t.limits.map((l) => <li key={l}>{l}</li>)}</ul>
            </section>
          </>
        ) : null}
    </div>
  );
}

function DecisionCard({ d, organizationId, onOpenEntry, onNavigate }: { d: HistoricalDecisionView; organizationId: number; onOpenEntry: (id: string) => void; onNavigate: (href: string) => void }) {
  const changed = d.categoryDiffers === true;
  const violated = (d.policy?.rules ?? []).filter((r) => r.result === "violada");
  return (
    <article className={styles.decisionCard} aria-label={`Decisão da execução ${d.runId}`}>
      <div className={styles.rowBadges}><Badge variant="secondary">Simulação</Badge><strong>{d.agentName}</strong><span className={styles.rowMeta}>execução #{d.runId} · avaliada em {fmt(d.evaluatedAt)}</span></div>
      <p style={{ margin: "0.5rem 0" }}><strong>Decisão registrada:</strong> {d.decision ?? "sem decisão estruturada (execução anterior à explicação)"} <span className={styles.rowMeta}>(situação: {d.status})</span></p>
      {d.reason && <p className={styles.rowMeta}>{d.reason}</p>}
      <div className={styles.compare}>
        <div className={styles.compareCell}><p className={styles.compareLabel}>Categoria considerada na avaliação</p><p className={styles.compareValue}>{d.categoryConsidered ?? "nenhuma"}</p><p className={styles.rowMeta}>Origem: {d.categoryOrigin ?? "não registrada"} · versão do registro: {d.versionConsidered ?? "não registrada nesta avaliação"}</p></div>
        <div className={`${styles.compareCell} ${changed ? styles.compareCellChanged : ""}`}><p className={styles.compareLabel}>Categoria atual da oportunidade</p><p className={styles.compareValue}>{d.categoryDiffers === null ? "indisponível para o seu papel" : d.currentCategory ?? "sem categoria"}</p><p className={styles.rowMeta}>{d.currentVersion !== null ? `versão atual ${d.currentVersion}` : ""}</p></div>
      </div>
      {changed && <p className={`${styles.notice} ${styles.noticeAttention}`} role="status"><strong>A categoria mudou depois desta avaliação.</strong> A decisão acima é a histórica e <strong>não foi recalculada</strong>. Reavaliar uma decisão já concluída depende de regra de negócio ainda não definida pelo proprietário.</p>}
      {!changed && d.categoryDiffers === false && <p className={styles.notice}>A categoria atual é a mesma considerada nesta avaliação.</p>}
      {d.laterChanges.length > 0 && (
        <>
          <h3 className={styles.subTitle}>Alterações posteriores à avaliação</h3>
          <ul className={styles.list}>
            {d.laterChanges.map((c) => (
              <li key={c.id} className={styles.row}>
                <div className={styles.rowMain}><span className={styles.rowTitle}>{c.previousValue ?? "sem categoria"} → {c.newValue ?? "sem categoria"}</span><span className={styles.rowMeta}>{fmt(c.at)} · {c.byName ?? "uma pessoa"} · versão {c.versionAfter}</span></div>
                {c.auditEntryId ? <Button variant="outline" size="sm" onClick={() => onOpenEntry(c.auditEntryId!)}>Ver auditoria #{c.auditEntryId}</Button> : <span className={styles.rowMeta}>sem vínculo verificável com a auditoria</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {d.policy && (
        <>
          <h3 className={styles.subTitle}>Política considerada</h3>
          {violated.length === 0 ? <p className={styles.rowMeta}>Nenhuma regra violada nesta avaliação.</p> : <ul className={styles.limits}>{violated.map((r) => <li key={r.code}><strong>{r.title}</strong> — {r.reason}</li>)}</ul>}
          {Object.keys(d.policy.limits).length > 0 && <p className={styles.rowMeta}>Limites vigentes na avaliação: {Object.entries(d.policy.limits).map(([k, v]) => `${k} = ${Array.isArray(v) ? v.join(", ") : String(v)}`).join(" · ")}</p>}
        </>
      )}
      <div className={styles.linkRow}><button type="button" className={styles.link} onClick={() => onNavigate(`/organizacoes/${organizationId}/automacao?run=${d.runId}`)}>Abrir a justificativa completa do Risk Engine</button></div>
    </article>
  );
}
