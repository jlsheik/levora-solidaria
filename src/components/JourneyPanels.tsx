import React, { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getJourneys, type JourneyEntryView, type JourneyListItemView, type JourneyStepView, type OfferJourneyListItemView, type OfferStepView } from "../endpoints/journeys_GET.schema";
import { getOfferJourney } from "../endpoints/offer-journey_GET.schema";
import { getJourney } from "../endpoints/journey_GET.schema";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Skeleton } from "./Skeleton";
import { ALLOCATION_LABEL, CLOSED_REASON_LABEL, CRITERION_LABEL, DECISION_LABEL, DESTINATION_STATE_LABEL, LOGISTICS_LABEL, NEED_STATUS_HELP, NEED_STATUS_LABEL, PRIORITY_LABEL, RECEIPT_ENTRY_LABEL, STEP_STATE_LABEL, TIMELINE_KIND_LABEL, fmtDateTime, fmtQty, pct, scoreBand, stepAction, stepBadge, KIND_LABEL, MATCHING_STATE_HELP, MATCHING_STATE_LABEL, MATCH_RUN_OUTCOME_LABEL, ORIGIN_BADGE, STATUS_GROUPS, TIPO_OPTIONS, VINCULO_OPTIONS, offerParam, offerStepAction } from "./journeyView";
import styles from "./Journey.module.css";

const Meter = ({ label, value, total, unit, alt, hint }: { label: string; value: number; total: number; unit: string; alt?: boolean; hint: string }) => {
  const percent = total > 0 ? Math.min(100, Math.floor((value / total) * 1000) / 10) : 0;
  return (
    <div>
      <div className={styles.meterLabel}><span>{label}</span><span>{fmtQty(value, unit)} de {fmtQty(total, unit)} ({percent}%)</span></div>
      <div className={styles.meter} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-valuetext={`${percent}%: ${hint}`}><div className={`${styles.meterFill} ${alt ? styles.meterFillAlt : ""}`} style={{ width: pct(percent) }} /></div>
    </div>
  );
};

export interface JourneyFiltersState { q: string; tipo: string; vinculo: string; status: string }
export const EMPTY_FILTERS: JourneyFiltersState = { q: "", tipo: "", vinculo: "", status: "" };
const hasFilters = (f: JourneyFiltersState) => !!(f.q || f.tipo || f.vinculo || f.status);

function NeedCard({ j, href }: { j: JourneyListItemView; href: string }) {
  return (
    <li className={styles.card}>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{j.title}</h3>
        <span className={styles.badges}><Badge variant="outline">{KIND_LABEL.necessidade}</Badge><Badge variant="outline">{PRIORITY_LABEL[j.priority] ?? j.priority}</Badge><Badge variant={j.status === "aberta" ? "secondary" : "outline"}>{NEED_STATUS_LABEL[j.status] ?? j.status}</Badge></span>
      </div>
      <div className={styles.meters}>
        <Meter label="Recebido da rede (suprimento)" value={j.supply.fulfilled} total={j.quantityNeeded} unit={j.unit} alt hint="recebimentos da rede registrados no ledger" />
        <Meter label="Atendimento final (destinado)" value={j.attendance.attended} total={j.quantityNeeded} unit={j.unit} hint="quantidade aplicada pelas destinações" />
      </div>
      <ol className={styles.mini} aria-label="Etapas da jornada">
        {j.steps.map((s) => <li key={s.key} className={`${styles.miniStep} ${s.state === "concluida" ? styles.miniDone : ""}`}>{s.label.split(" (")[0]}: {STEP_STATE_LABEL[s.state]}</li>)}
      </ol>
      {j.next && <p className={styles.next}><strong>Próximo passo:</strong> {j.next}</p>}
      <div className={styles.linkRow}><Link className={styles.link} to={href} aria-label={`Abrir a jornada da necessidade ${j.title}`}>Abrir a jornada</Link></div>
    </li>
  );
}

function OfferCard({ j, href }: { j: OfferJourneyListItemView; href: string }) {
  return (
    <li className={styles.card}>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{j.title}</h3>
        <span className={styles.badges}><Badge variant="outline">{KIND_LABEL[j.kind]}</Badge><Badge variant="secondary">{j.statusLabel}</Badge>{j.originLabel && <Badge variant="outline">{j.originLabel}</Badge>}</span>
      </div>
      <p className={styles.rowMeta} style={{ margin: 0 }}>{j.sourceLabel} · {j.quantity !== null ? fmtQty(j.quantity, j.unit) : "quantidade não informada"} · registrada em {fmtDateTime(j.createdAt)}</p>
      <p className={styles.notice} style={{ margin: 0 }}><strong>Sem necessidade vinculada.</strong> Não há atendimento de necessidade nem destinação ligada a esta oferta.</p>
      <ol className={styles.mini} aria-label="Etapas da jornada">
        {j.steps.map((s) => <li key={s.key} className={`${styles.miniStep} ${s.state === "concluida" ? styles.miniDone : ""}`}>{s.label.split(" (")[0]}: {STEP_STATE_LABEL[s.state]}</li>)}
      </ol>
      {j.next && <p className={styles.next}><strong>Próximo passo:</strong> {j.next}</p>}
      <div className={styles.linkRow}><Link className={styles.link} to={href} aria-label={`Abrir a jornada da oferta ${j.title}`}>Abrir a jornada da oferta</Link></div>
    </li>
  );
}

/**
 * Lista de jornadas: necessidades E ofertas sem necessidade vinculada (oferta local e atribuição da rede). Busca, filtros e paginação são do SERVIDOR; os filtros vivem na URL (o botão voltar os preserva).
 * Etapas em palavras, medidores separados (suprimento ≠ atendimento) e a próxima ação que decorre de um estado persistido.
 */
export function JourneyList({ organizationId, filters, onFiltersChange, buildDetailHref }: { organizationId: number; filters: JourneyFiltersState; onFiltersChange: (f: JourneyFiltersState) => void; buildDetailHref: (e: JourneyEntryView) => string }) {
  const [draft, setDraft] = useState(filters.q);
  const lastSent = useRef(filters.q);
  useEffect(() => { if (filters.q !== lastSent.current) { lastSent.current = filters.q; setDraft(filters.q); } }, [filters.q]);
  useEffect(() => {
    if (draft.trim() === filters.q) return undefined;
    const t = setTimeout(() => { lastSent.current = draft.trim(); const n = { ...latest.current, q: draft.trim() }; latest.current = n; onFiltersChange(n); }, 350);
    return () => clearTimeout(t);
  }, [draft, filters, onFiltersChange]);

  const q = useInfiniteQuery({
    queryKey: ["journeys", organizationId, filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => getJourneys({ organizationId, limit: 12, q: filters.q || undefined, tipo: (filters.tipo || undefined) as never, vinculo: (filters.vinculo || undefined) as never, status: (filters.status || undefined) as never, cursor: pageParam }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items: JourneyEntryView[] = q.data?.pages.flatMap((p) => p.items) ?? [];
  const fetchMore = () => { void q.fetchNextPage(); };
  const nextFailed = q.isFetchNextPageError;
  // Sempre parte do estado MAIS RECENTE dos filtros: duas mudanças em sequência rápida (antes de a URL atualizar) não se sobrescrevem.
  const latest = useRef(filters); latest.current = filters;
  const apply = (next: JourneyFiltersState) => { latest.current = next; onFiltersChange(next); };
  const set = (patch: Partial<JourneyFiltersState>) => apply({ ...latest.current, ...patch });

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="jl-filtro">
        <h2 id="jl-filtro" className={styles.sectionTitle}>Jornadas</h2>
        <p className={styles.help}>Cada cartão segue uma necessidade da organização (correspondência da rede, atribuição, recebimento, destinação e atendimento) ou uma oferta que ainda não tem necessidade vinculada. Tudo vem de registros do sistema; nada aqui comprova entrega física.</p>
        <form className={styles.toolbar} role="search" aria-label="Buscar e filtrar jornadas" onSubmit={(e) => { e.preventDefault(); lastSent.current = draft.trim(); apply({ ...latest.current, q: draft.trim() }); }}>
          <label className={styles.field} style={{ flex: "1 1 16rem" }}><span className={styles.fieldLabel}>Buscar</span>
            <input className={styles.control} type="search" value={draft} maxLength={80} placeholder="Título, doador, #número…" title="Busca por título, doador, categoria, #número ou correlação" onChange={(e) => setDraft(e.target.value)} />
          </label>
          <label className={styles.field}><span className={styles.fieldLabel}>Tipo</span>
            <select className={styles.control} value={filters.tipo} onChange={(e) => set({ tipo: e.target.value })}>{TIPO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          </label>
          <label className={styles.field}><span className={styles.fieldLabel}>Necessidade vinculada</span>
            <select className={styles.control} value={filters.vinculo} onChange={(e) => set({ vinculo: e.target.value })}>{VINCULO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          </label>
          <label className={styles.field}><span className={styles.fieldLabel}>Situação</span>
            <select className={styles.control} value={filters.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">Todas</option>
              {STATUS_GROUPS.map((g) => <optgroup key={g.label} label={g.label}>{g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>)}
            </select>
          </label>
          <Button type="submit" variant="secondary" size="sm">Buscar</Button>
          {hasFilters(filters) && <Button type="button" variant="outline" size="sm" onClick={() => { setDraft(""); lastSent.current = ""; apply(EMPTY_FILTERS); }}>Limpar filtros</Button>}
        </form>
        <p className={styles.help} style={{ margin: "0.5rem 0 0 0" }} role="status" aria-live="polite">{q.isSuccess ? `${items.length} ${items.length === 1 ? "jornada exibida" : "jornadas exibidas"}${q.hasNextPage ? " (há mais)" : ""}${hasFilters(filters) ? " com os filtros atuais" : ""}.` : "\u00a0"}</p>
      </section>

      {q.isLoading ? <div aria-busy="true" className={styles.cards}><Skeleton className={styles.skeleton} /><Skeleton className={styles.skeleton} /></div>
        : q.isError ? <div className={styles.error} role="alert"><span>{(q.error as Error).message || "Não foi possível carregar as jornadas."} Nada foi alterado.</span><Button variant="outline" size="sm" onClick={() => q.refetch()}>Tentar de novo</Button></div>
        : items.length === 0 ? (hasFilters(filters)
          ? <div className={styles.empty} role="status"><p style={{ margin: 0 }}>Nenhuma jornada encontrada com estes filtros.</p><p style={{ margin: "0.5rem 0 0 0" }}><Button variant="outline" size="sm" onClick={() => { setDraft(""); lastSent.current = ""; apply(EMPTY_FILTERS); }}>Limpar filtros</Button></p></div>
          : <p className={styles.empty}>Esta organização ainda não tem necessidades nem ofertas sem necessidade. Cadastre uma necessidade em Necessidades ou uma oferta em Oportunidades para começar a jornada.</p>)
        : (
          <>
            <ul className={styles.cards}>
              {items.map((j) => j.kind === "necessidade" ? <NeedCard key={`n-${j.needId}`} j={j} href={buildDetailHref(j)} /> : <OfferCard key={`${j.kind}-${j.id}`} j={j} href={buildDetailHref(j)} />)}
            </ul>
            <div style={{ display: "flex", justifyContent: "center" }}>
              {q.hasNextPage ? <Button variant="outline" onClick={fetchMore} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage ? "Carregando…" : "Carregar mais jornadas"}</Button> : <span className={styles.help}>Fim da lista.</span>}
            </div>
            {nextFailed && <div className={styles.error} role="alert"><span>Não foi possível carregar mais jornadas. As já exibidas continuam corretas.</span><Button variant="outline" size="sm" onClick={fetchMore}>Tentar de novo</Button></div>}
          </>
        )}
    </div>
  );
}

type TimelineItem = { at: string; kind: string; title: string; detail: string | null; actor: string | null };
function TimelineSection({ timeline }: { timeline: TimelineItem[] }) {
  return (
    <section className={styles.section} aria-labelledby="jd-tl">
      <h3 id="jd-tl" className={styles.sectionTitle}>Linha do tempo</h3>
      <p className={styles.help}>Cada item é uma linha persistida. A ordem é a do horário de gravação; ela não prova causa entre itens — só os vínculos (necessidade, atribuição, destinação) provam relação.</p>
      <ol className={styles.timeline}>
        {timeline.map((t, i) => (
          <li key={`${t.kind}-${t.at}-${i}`} className={styles.tl}>
            <div className={styles.badges}><Badge variant="secondary">{TIMELINE_KIND_LABEL[t.kind] ?? t.kind}</Badge><span className={styles.tlMeta}>{fmtDateTime(t.at)}{t.actor ? ` · ${t.actor}` : ""}</span></div>
            <div className={styles.tlTitle}>{t.title}</div>
            {t.detail && <div className={styles.tlMeta}>{t.detail}</div>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function AuditSection({ audit }: { audit: { correlationId: string | null; entries: number | null; path: string | null; note: string } }) {
  return (
    <section className={styles.section} aria-labelledby="jd-aud">
      <h3 id="jd-aud" className={styles.sectionTitle}>Auditoria desta jornada</h3>
      <p className={styles.help}>{audit.note}</p>
      {audit.correlationId && <p className={styles.rowMeta}>Correlação: <span className={styles.code}>{audit.correlationId}</span> · {audit.entries} registro(s) de auditoria</p>}
      {!audit.correlationId && audit.entries !== null && <p className={styles.rowMeta}>{audit.entries} registro(s) de auditoria para este recurso</p>}
      {audit.path && <div className={styles.linkRow}><Link className={styles.link} to={audit.path}>Abrir os registros na Central de Auditoria</Link></div>}
    </section>
  );
}

/** Estado do matching para a necessidade + histórico das execuções que a consideraram (inclusive as sem correspondência). Só o que o motor registrou; a oferta não é identificada. */
function MatchingSection({ m }: { m: { state: string; runs: Array<{ id: string; originLabel: string; finishedAt: string | null; repeatCount: number; lastRepeatedAt: string | null; outcome: string }>; note: string } }) {
  const tone = m.state === "executado_com_correspondencia" ? "success" : m.state === "executado_sem_correspondencia" || m.state === "atribuicao_manual" ? "secondary" : "outline";
  return (
    <section className={styles.section} aria-labelledby="jd-match">
      <h3 id="jd-match" className={styles.sectionTitle}>Matching desta necessidade</h3>
      <div style={{ margin: "0 0 0.5rem 0" }}><Badge variant={tone as "success" | "secondary" | "outline"}>{MATCHING_STATE_LABEL[m.state] ?? m.state}</Badge></div>
      <p className={styles.help}>{MATCHING_STATE_HELP[m.state] ?? ""}</p>
      {m.runs.length === 0 ? <p className={styles.rowMeta} style={{ margin: 0 }}>Nenhuma execução do matching registrada para esta necessidade.</p> : (
        <ol className={styles.list} aria-label="Execuções do matching que consideraram esta necessidade">
          {m.runs.map((r) => (
            <li key={r.id} className={styles.row}>
              <span className={styles.rowTitle}>{MATCH_RUN_OUTCOME_LABEL[r.outcome] ?? r.outcome}</span>
              <span className={styles.rowMeta}>{r.finishedAt ? fmtDateTime(r.finishedAt) : "em andamento"} · {r.originLabel}{r.repeatCount > 0 ? ` · reconfirmado ${r.repeatCount} vez(es) pela varredura${r.lastRepeatedAt ? `, a última em ${fmtDateTime(r.lastRepeatedAt)}` : ""}` : ""}</span>
            </li>
          ))}
        </ol>
      )}
      <p className={styles.help} style={{ margin: "0.5rem 0 0 0" }}>{m.note}</p>
    </section>
  );
}

function StepRow({ s, organizationId, needId }: { s: JourneyStepView; organizationId: number; needId: number }) {
  const action = s.state === "restrita" ? null : stepAction(s.key, organizationId, needId);
  return (
    <li className={styles.step}>
      <div><p className={styles.stepTitle}>{s.label}</p><p className={styles.stepDetail}>{s.detail}</p></div>
      <Badge variant={stepBadge(s.state)}>{STEP_STATE_LABEL[s.state]}</Badge>
      {action && s.state !== "nao_se_aplica" && s.key !== "necessidade" && <div className={styles.stepActions}><Link className={styles.link} to={action.href}>{action.label}</Link></div>}
    </li>
  );
}

/** Detalhe da jornada de uma necessidade: etapas, pendências, correspondências explicadas, atribuições, recebimentos, destinações, ofertas locais, linha do tempo e auditoria. */
export function JourneyDetailView({ organizationId, needId, onBack }: { organizationId: number; needId: number; onBack: () => void }) {
  const q = useQuery({ queryKey: ["journey", organizationId, needId], queryFn: () => getJourney({ organizationId, needId }), retry: false });
  const d = q.data;
  return (
    <div className={styles.panel}>
      <div><button type="button" className={styles.link} onClick={onBack}>← Todas as jornadas</button></div>
      {q.isLoading ? <div aria-busy="true"><Skeleton className={styles.skeleton} /><Skeleton className={styles.skeleton} /></div>
        : q.isError ? <div className={styles.error} role="alert"><span>{(q.error as Error).message}</span><Button variant="outline" size="sm" onClick={() => q.refetch()}>Tentar de novo</Button></div>
        : d ? (
          <>
            <section className={styles.section} aria-labelledby="jd-titulo">
              <div className={styles.head}>
                <h2 id="jd-titulo" className={styles.headTitle}>{d.title}</h2>
                <span className={styles.badges}><Badge variant="outline">Prioridade {PRIORITY_LABEL[d.priority] ?? d.priority}</Badge><Badge variant={d.status === "aberta" ? "secondary" : "outline"}>{NEED_STATUS_LABEL[d.status] ?? d.status}</Badge>{d.itemName && <Badge variant="outline">Item: {d.itemName}</Badge>}</span>
                <p className={styles.help} style={{ margin: 0 }}>{NEED_STATUS_HELP[d.status]}{d.closure ? ` Encerrada em ${fmtDateTime(d.closure.closedAt)}${d.closure.reasonCode ? ` (${d.closure.reasonCode.replace(/_/g, " ")})` : ""}.` : ""}</p>
                {d.description && <p className={styles.rowMeta}>{d.description}</p>}
              </div>
              <div className={styles.kpis} style={{ marginTop: "0.75rem" }}>
                <div className={styles.kpi}><p className={styles.kpiLabel}>Solicitado</p><p className={styles.kpiValue}>{fmtQty(d.quantityNeeded, d.unit)}</p></div>
                <div className={styles.kpi}><p className={styles.kpiLabel}>Recebido da rede (suprimento)</p><p className={styles.kpiValue}>{fmtQty(d.supply.fulfilled, d.unit)}</p><p className={styles.kpiHint}>faltam {fmtQty(d.supply.requiredRemaining, d.unit)}{d.supply.surplus > 0 ? ` · excedente ${fmtQty(d.supply.surplus, d.unit)}` : ""}</p></div>
                <div className={styles.kpi}><p className={styles.kpiLabel}>Atendimento final (destinado)</p><p className={styles.kpiValue}>{fmtQty(d.attendance.attended, d.unit)}</p><p className={styles.kpiHint}>{d.attendance.percent}% · saíram do estoque {fmtQty(d.attendance.physicalDestined, d.unit)}</p></div>
              </div>
              {d.next && <p className={styles.notice} style={{ marginTop: "0.75rem" }}><strong>Próximo passo:</strong> {d.next}</p>}
            </section>

            <section className={styles.section} aria-labelledby="jd-etapas">
              <h3 id="jd-etapas" className={styles.sectionTitle}>Etapas</h3>
              <ol className={styles.steps}>{d.steps.map((s) => <StepRow key={s.key} s={s} organizationId={organizationId} needId={d.needId} />)}</ol>
            </section>

            <section className={styles.section} aria-labelledby="jd-pend">
              <h3 id="jd-pend" className={styles.sectionTitle}>Pendências</h3>
              {d.pendings.length === 0 ? <p className={styles.help} style={{ margin: 0 }}>Nenhuma pendência identificada nos registros a que o seu papel tem acesso.</p> : <ul className={styles.pendings}>{d.pendings.map((p) => <li key={p}>{p}</li>)}</ul>}
            </section>

            {d.matching && <MatchingSection m={d.matching} />}

            {d.evaluations && (
              <section className={styles.section} aria-labelledby="jd-corr">
                <h3 id="jd-corr" className={styles.sectionTitle}>Correspondências da rede</h3>
                <p className={styles.help}>Pontuação e critérios exatamente como o motor os gravou. Critério sem pontuação foi considerado “não aplicável”; nenhum valor é inventado no lugar.</p>
                {d.evaluations.length === 0 ? <p className={styles.empty}>{d.allocations && d.allocations.length > 0 && d.allocations.every((x) => x.origin === "manual") ? "Nenhuma avaliação de matching foi executada para esta necessidade: as atribuições abaixo foram feitas manualmente por pessoas autorizadas." : d.matching && d.matching.runs.length > 0 ? "Nenhuma oferta chegou a ser pontuada para esta necessidade: veja as execuções do matching acima." : "Nenhuma oferta da rede foi avaliada para esta necessidade."}</p> : (
                  <ul className={styles.list}>
                    {d.evaluations.map((e) => (
                      <li key={e.id} className={styles.row}>
                        <span className={styles.rowTitle}>{e.opportunity ? `Oferta “${e.opportunity.title}”` : "Oferta da rede não atribuída a esta organização (identificação reservada à plataforma)"} — pontuação {e.finalScore} ({scoreBand(e.finalScore)})</span>
                        <span className={styles.rowMeta}>{DECISION_LABEL[e.decision] ?? e.decision} · algoritmo {e.algorithmVersion} · {fmtDateTime(e.createdAt)}{e.allocationId ? ` · atribuição #${e.allocationId}` : ""}</span>
                        <ul className={styles.criteria} aria-label="Critérios da correspondência">
                          {e.criteria.map((c) => <li key={c.key}><strong>{CRITERION_LABEL[c.key] ?? c.key}:</strong> {c.score === null ? "não aplicável" : `${c.score} (peso ${c.weight})`}{c.detail ? ` — ${c.detail}` : ""}</li>)}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {d.allocations && (
              <section className={styles.section} aria-labelledby="jd-atr">
                <h3 id="jd-atr" className={styles.sectionTitle}>Atribuições e logística</h3>
                {d.allocations.length === 0 ? <p className={styles.empty}>Nenhuma atribuição para esta necessidade.</p> : (
                  <ul className={styles.list}>
                    {d.allocations.map((a) => (
                      <li key={a.id} className={styles.row}>
                        <span className={styles.rowTitle}>Atribuição #{a.id} — {fmtQty(a.quantityAllocated, a.opportunity.unit)} da oferta “{a.opportunity.title}”</span>
                        <span className={styles.badges}><Badge variant={a.status === "recebida" ? "success" : a.status === "recusada" || a.status === "cancelada" ? "outline" : "secondary"}>{ALLOCATION_LABEL[a.status] ?? a.status}</Badge><Badge variant="outline">{ORIGIN_BADGE[a.origin] ?? a.origin}{a.origin === "matching" && a.evaluationId ? ` #${a.evaluationId}` : ""}</Badge></span>
                        <span className={styles.rowMeta}>{a.decidedByName ? `Decidida por ${a.decidedByName}` : a.status === "proposta" ? "Ainda sem decisão" : a.origin === "matching" ? "Atribuída automaticamente pelo motor (alta confiança)" : "Sem decisão humana registrada"}{a.responseDueAt ? ` · prazo ${fmtDateTime(a.responseDueAt)}` : ""}{a.closedReason ? ` · encerrada: ${CLOSED_REASON_LABEL[a.closedReason] ?? a.closedReason}` : ""}</span>
                        {a.logistics.length > 0 && <span className={styles.rowMeta}>Logística: {a.logistics.map((l) => `${LOGISTICS_LABEL[l.eventType] ?? l.eventType} (${fmtDateTime(l.occurredAt)})`).join(" → ")}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            <section className={styles.section} aria-labelledby="jd-rec">
              <h3 id="jd-rec" className={styles.sectionTitle}>Recebimentos (suprimento da rede)</h3>
              {d.receipts.length === 0 ? <p className={styles.empty}>Nenhum recebimento registrado para esta necessidade.</p> : (
                <ul className={styles.list}>{d.receipts.map((r) => <li key={r.id} className={styles.row}><span className={styles.rowTitle}>{RECEIPT_ENTRY_LABEL[r.entryType] ?? r.entryType}: {fmtQty(r.quantity, r.unit)} (atribuição #{r.allocationId})</span><span className={styles.rowMeta}>{fmtDateTime(r.createdAt)}{r.createdByName ? ` · ${r.createdByName}` : ""}{r.isCountable ? "" : " · não contabilizável (unidade incompatível)"}</span></li>)}</ul>
              )}
            </section>

            <section className={styles.section} aria-labelledby="jd-dest">
              <h3 id="jd-dest" className={styles.sectionTitle}>Destinações (atendimento final)</h3>
              {d.destinations === null ? <p className={styles.help} style={{ margin: 0 }}>As destinações são restritas ao seu papel.</p> : d.destinations.length === 0 ? <p className={styles.empty}>Nenhuma destinação registrada para esta necessidade.</p> : (
                <ul className={styles.list}>{d.destinations.map((x) => <li key={x.id} className={styles.row}><span className={styles.rowTitle}>{fmtQty(x.quantity, x.unit)} de {x.itemName} — {x.destinationType.replace(/_/g, " ")}</span><span className={styles.badges}><Badge variant="secondary">{DESTINATION_STATE_LABEL[x.state] ?? x.state}</Badge><Badge variant={x.proof ? "success" : "outline"}>{x.proof ? "Comprovante anexado" : "Sem comprovante"}</Badge></span><span className={styles.rowMeta}>{fmtDateTime(x.createdAt)} · {x.createdByDisplayName}{x.reversedQuantity > 0 ? ` · revertido ${fmtQty(x.reversedQuantity, x.unit)}` : ""}</span></li>)}</ul>
              )}
              <div className={styles.linkRow} style={{ marginTop: "0.5rem" }}><Link className={styles.link} to={`/organizacoes/${organizationId}/destinacoes`}>Histórico completo, correções e estornos em Destinação</Link></div>
            </section>

            {d.localOffers && d.localOffers.length > 0 && (
              <section className={styles.section} aria-labelledby="jd-loc">
                <h3 id="jd-loc" className={styles.sectionTitle}>Ofertas locais vinculadas</h3>
                <ul className={styles.list}>{d.localOffers.map((o) => <li key={o.id} className={styles.row}><span className={styles.rowTitle}>{o.title}</span><span className={styles.rowMeta}>Situação: {o.status}{o.quantityOffered !== null ? ` · ${fmtQty(o.quantityOffered, o.unit)}` : " · quantidade não informada"} — uma oferta registrada não é uma doação entregue.</span></li>)}</ul>
                <div className={styles.linkRow} style={{ marginTop: "0.5rem" }}><Link className={styles.link} to={`/organizacoes/${organizationId}/oportunidades`}>Abrir Oportunidades</Link></div>
              </section>
            )}

            <TimelineSection timeline={d.timeline} />

            {d.audit && <AuditSection audit={d.audit} />}

            <section className={styles.section} aria-labelledby="jd-notas">
              <h3 id="jd-notas" className={styles.sectionTitle}>Como ler esta jornada</h3>
              <ul className={styles.pendings}>{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>
              {!d.access.report && <p className={styles.help}>A prestação de contas é restrita ao seu papel.</p>}
            </section>
          </>
        ) : null}
    </div>
  );
}

function OfferStepRow({ s, kind, organizationId }: { s: OfferStepView; kind: "oferta_local" | "atribuicao_rede"; organizationId: number }) {
  const action = s.state === "restrita" ? null : offerStepAction(s.key, kind, organizationId);
  return (
    <li className={styles.step}>
      <div><p className={styles.stepTitle}>{s.label}</p><p className={styles.stepDetail}>{s.detail}</p></div>
      <Badge variant={stepBadge(s.state)}>{STEP_STATE_LABEL[s.state]}</Badge>
      {action && s.state !== "nao_se_aplica" && <div className={styles.stepActions}><Link className={styles.link} to={action.href}>{action.label}</Link></div>}
    </li>
  );
}

/** Detalhe da jornada de uma oferta SEM necessidade vinculada (oferta local ou atribuição da rede). Nenhuma etapa é preenchida para "completar" a jornada; o motivo de não existir o vínculo é dito. */
export function OfferJourneyDetailView({ organizationId, kind, id, onBack }: { organizationId: number; kind: "oferta_local" | "atribuicao_rede"; id: number; onBack: () => void }) {
  const q = useQuery({ queryKey: ["offer-journey", organizationId, kind, id], queryFn: () => getOfferJourney({ organizationId, kind, id }), retry: false });
  const d = q.data;
  return (
    <div className={styles.panel}>
      <div><button type="button" className={styles.link} onClick={onBack}>← Todas as jornadas</button></div>
      {q.isLoading ? <div aria-busy="true"><Skeleton className={styles.skeleton} /><Skeleton className={styles.skeleton} /></div>
        : q.isError ? <div className={styles.error} role="alert"><span>{(q.error as Error).message}</span><Button variant="outline" size="sm" onClick={() => q.refetch()}>Tentar de novo</Button></div>
        : d ? (
          <>
            <section className={styles.section} aria-labelledby="jd-titulo">
              <div className={styles.head}>
                <h2 id="jd-titulo" className={styles.headTitle}>{d.title}</h2>
                <span className={styles.badges}><Badge variant="outline">{KIND_LABEL[d.kind]}</Badge><Badge variant="secondary">{d.statusLabel}</Badge>{d.originLabel && <Badge variant="outline">{d.originLabel}</Badge>}{d.category && <Badge variant="outline">Categoria: {d.category}</Badge>}</span>
                <p className={styles.help} style={{ margin: 0 }}>{d.sourceLabel}{d.donorName ? ` · doador: ${d.donorName}` : ""}{d.createdByName ? ` · registrada por ${d.createdByName}` : ""}{d.decidedByName ? ` · decidida por ${d.decidedByName}` : ""}</p>
                {d.description && <p className={styles.rowMeta}>{d.description}</p>}
              </div>
              <div className={styles.kpis} style={{ marginTop: "0.75rem" }}>
                <div className={styles.kpi}><p className={styles.kpiLabel}>{d.kind === "oferta_local" ? "Quantidade oferecida" : "Quantidade atribuída"}</p><p className={styles.kpiValue}>{d.quantity !== null ? fmtQty(d.quantity, d.unit) : "não informada"}</p></div>
                <div className={styles.kpi}><p className={styles.kpiLabel}>Necessidade vinculada</p><p className={styles.kpiValue}>Nenhuma</p><p className={styles.kpiHint}>sem vínculo, não há atendimento de necessidade a medir</p></div>
              </div>
              {d.next && <p className={styles.notice} style={{ marginTop: "0.75rem" }}><strong>Próximo passo:</strong> {d.next}</p>}
            </section>

            <section className={styles.section} aria-labelledby="jd-vinculo">
              <h3 id="jd-vinculo" className={styles.sectionTitle}>Vínculo com uma necessidade</h3>
              <p className={`${styles.notice} ${styles.noticeAttention}`} style={{ margin: 0 }}><strong>Vincular depois não está disponível.</strong> {d.linking.reason}</p>
              <div className={styles.linkRow} style={{ marginTop: "0.5rem" }}>{d.linking.alternatives.map((a) => <Link key={a.href} className={styles.link} to={a.href}>{a.label}</Link>)}</div>
            </section>

            <section className={styles.section} aria-labelledby="jd-etapas">
              <h3 id="jd-etapas" className={styles.sectionTitle}>Etapas</h3>
              <ol className={styles.steps}>{d.steps.map((s) => <OfferStepRow key={s.key} s={s} kind={d.kind} organizationId={organizationId} />)}</ol>
            </section>

            <section className={styles.section} aria-labelledby="jd-pend">
              <h3 id="jd-pend" className={styles.sectionTitle}>Pendências</h3>
              {d.pendings.length === 0 ? <p className={styles.help} style={{ margin: 0 }}>Nenhuma pendência identificada nos registros a que o seu papel tem acesso.</p> : <ul className={styles.pendings}>{d.pendings.map((p) => <li key={p}>{p}</li>)}</ul>}
            </section>

            {d.kind === "atribuicao_rede" && (
              <section className={styles.section} aria-labelledby="jd-corr">
                <h3 id="jd-corr" className={styles.sectionTitle}>Origem da atribuição</h3>
                {d.evaluation ? (
                  <p className={styles.rowMeta} style={{ margin: 0 }}>Avaliação de matching #{d.evaluation.id} — pontuação {d.evaluation.finalScore} ({scoreBand(d.evaluation.finalScore)}) · {DECISION_LABEL[d.evaluation.decision] ?? d.evaluation.decision} · algoritmo {d.evaluation.algorithmVersion} · {fmtDateTime(d.evaluation.createdAt)}</p>
                ) : d.originLabel === ORIGIN_BADGE.manual ? <p className={styles.rowMeta} style={{ margin: 0 }}>Atribuição manual por pessoa autorizada. Nenhuma avaliação de matching foi executada e nenhuma pontuação foi inventada.</p>
                  : <p className={styles.rowMeta} style={{ margin: 0 }}>Marcada como automática, mas o histórico não tem a avaliação: não é possível verificar o matching.</p>}
                {d.logistics.length > 0 && <p className={styles.rowMeta}>Logística: {d.logistics.map((l) => `${LOGISTICS_LABEL[l.eventType] ?? l.eventType} (${fmtDateTime(l.occurredAt)})`).join(" → ")}</p>}
              </section>
            )}

            {d.receipts.length > 0 && (
              <section className={styles.section} aria-labelledby="jd-rec">
                <h3 id="jd-rec" className={styles.sectionTitle}>Recebimentos (suprimento da rede)</h3>
                <ul className={styles.list}>{d.receipts.map((r) => <li key={r.id} className={styles.row}><span className={styles.rowTitle}>{RECEIPT_ENTRY_LABEL[r.entryType] ?? r.entryType}: {fmtQty(r.quantity, r.unit)}</span><span className={styles.rowMeta}>{fmtDateTime(r.createdAt)}{r.createdByName ? ` · ${r.createdByName}` : ""}</span></li>)}</ul>
              </section>
            )}

            <TimelineSection timeline={d.timeline} />
            {d.audit && <AuditSection audit={d.audit} />}

            <section className={styles.section} aria-labelledby="jd-notas">
              <h3 id="jd-notas" className={styles.sectionTitle}>Como ler esta jornada</h3>
              <ul className={styles.pendings}>{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>
              {!d.access.report && <p className={styles.help}>A prestação de contas é restrita ao seu papel.</p>}
            </section>
          </>
        ) : null}
    </div>
  );
}
