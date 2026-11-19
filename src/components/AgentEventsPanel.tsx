import React, { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { toast } from "sonner";
import { getAgentEvents, STATUS_VALUES, type RunView } from "../endpoints/agent-events_GET.schema";
import { postAgentEngineRun } from "../endpoints/agent-engine-run_POST.schema";
import { postAgentEventReevaluate } from "../endpoints/agent-event-reevaluate_POST.schema";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Skeleton } from "./Skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import { MISSING_IMPACT, REEVALUATION_BLOCK_TEXT, REEVALUATION_OUTCOME_LABEL, ACTOR_LABEL, COMPLETENESS_LABEL, FACT_LABEL, RULE_RESULT_LABEL, RUN_STATUS_ORDER, decisionLabel, engineHeadline, eventTypeLabel, factValue, fmtDateTime, missingLabel, reasonText, ruleLabel, runStatusLabel, type Tone } from "./agentOpsView";
import styles from "./AgentOps.module.css";

const badge = (tone: Tone) => (tone === "ok" ? "success" : tone === "attention" ? "destructive" : tone === "info" ? "secondary" : "outline") as "success" | "destructive" | "secondary" | "outline";
type Filter = "todos" | (typeof STATUS_VALUES)[number];
const FILTER_STATUSES: Filter[] = ["todos", ...RUN_STATUS_ORDER.filter((s) => (STATUS_VALUES as readonly string[]).includes(s))] as Filter[];

/**
 * Processamento de eventos pelos agentes (M34). TUDO aqui é SIMULAÇÃO: nenhuma linha representa uma ação real. Os números vêm do servidor (nada de zero inventado: antes do primeiro evento
 * a tela diz que nada foi recebido). "Processar agora" roda uma passada do motor só para esta organização, depois de uma confirmação que repete o que ela faz e o que NÃO faz.
 */
export function AgentEventsPanel({ organizationId, canManage, onOpenExceptions, initialRunId, opportunityHref, onOpenOpportunity, onOpenTrace }: { organizationId: number; canManage: boolean; onOpenExceptions?: () => void; initialRunId?: string | null; opportunityHref?: (opportunityId: number) => string; onOpenOpportunity?: (opportunityId: number) => void; /** M38: abre a rastreabilidade/auditoria desta execução. */ onOpenTrace?: (runId: string) => void }) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("todos");
  const [detailId, setDetailId] = useState<string | null>(initialRunId ?? null);
  const [confirmRun, setConfirmRun] = useState(false);
  const [confirmReeval, setConfirmReeval] = useState(false);
  const [reevalReason, setReevalReason] = useState("");
  const [reevalError, setReevalError] = useState<string | null>(null);

  const query = useInfiniteQuery({
    queryKey: ["agent-events", organizationId, filter],
    queryFn: ({ pageParam }) => getAgentEvents({ organizationId, status: filter === "todos" ? undefined : filter, limit: 20, beforeId: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBeforeId ?? undefined,
    retry: false,
    refetchInterval: 30_000,
  });
  const detail = useQuery({ queryKey: ["agent-event-detail", organizationId, detailId], queryFn: () => getAgentEvents({ organizationId, runId: detailId!, limit: 1 }), enabled: !!detailId, retry: false });

  const reeval = useMutation({
    mutationFn: () => postAgentEventReevaluate({ organizationId, runId: detailId!, reason: reevalReason.trim() || undefined }),
    onSuccess: (r) => {
      toast.success(r.newStatus === "simulacao_concluida" ? "Nova análise concluída (simulação)." : r.newStatus === "aguardando_aprovacao" ? "Nova análise concluída: agora aguarda a decisão de uma pessoa." : "Nova análise registrada.");
      setConfirmReeval(false); setReevalReason(""); setReevalError(null);
      for (const key of ["agent-events", "agent-event-detail", "agents", "exception-queue", "integrity-alerts"]) queryClient.invalidateQueries({ queryKey: [key, organizationId] });
    },
    onError: (e) => { setReevalError(e instanceof Error ? e.message : "Não foi possível solicitar a nova análise"); for (const key of ["agent-events", "agent-event-detail"]) queryClient.invalidateQueries({ queryKey: [key, organizationId] }); },
  });
  const run = useMutation({
    mutationFn: () => postAgentEngineRun({ organizationId }),
    onSuccess: (r) => {
      toast.success(r.registered === 0 && r.advanced === 0 ? "Nada novo para processar." : `Simulação processada: ${r.registered} evento(s) novo(s), ${r.advanced} avançado(s).`);
      setConfirmRun(false);
      for (const key of ["agent-events", "agents", "exception-queue", "integrity-alerts"]) queryClient.invalidateQueries({ queryKey: [key, organizationId] });
    },
    onError: (e) => { toast.error(e instanceof Error ? e.message : "Não foi possível processar os eventos"); },
  });

  const first = query.data?.pages[0];
  const runs: RunView[] = query.data?.pages.flatMap((p) => p.runs) ?? [];

  return (
    <section className={styles.section} aria-labelledby="eventos-titulo" aria-busy={query.isFetching}>
      <h2 id="eventos-titulo" className={styles.sectionTitle}><Activity size={18} aria-hidden="true" /> Processamento de eventos <Badge variant="outline">Simulação</Badge></h2>
      <p className={styles.help}>Os agentes avaliam eventos internos (por exemplo, uma oportunidade criada) conforme as regras de proteção e os limites. <strong>Tudo é simulado:</strong> nenhuma ação, mensagem ou pagamento acontece fora do sistema, e aprovar uma exceção também não executa nada. O processamento automático periódico só acontece se a plataforma o tiver habilitado no servidor; numa instalação nova ele vem desligado, e “Processar eventos agora” continua disponível.</p>

      {query.isError ? (
        <div className={styles.error}>
          <p className={styles.errorText} role="alert">Não foi possível carregar o processamento de eventos. {query.error instanceof Error ? query.error.message : ""}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>Tentar de novo</Button>
        </div>
      ) : !first ? (
        <Skeleton className={styles.skeleton} />
      ) : (
        <>
          {(() => { const h = engineHeadline(first.summary); return (
            <div className={`${styles.banner} ${h.tone === "attention" ? styles.bannerAttention : ""}`} role="status" aria-live="polite">
              <Badge variant={badge(h.tone)}>{h.tone === "attention" ? "Atenção" : h.tone === "ok" ? "Em ordem" : "Informação"}</Badge>
              <p className={styles.bannerText}>{h.text}</p>
            </div>
          ); })()}

          <dl className={styles.statGrid} style={{ marginTop: "0.75rem" }}>
            <div className={styles.stat}><dt className={styles.statLabel}>Recebidos pelo motor</dt><dd className={styles.statValue}>{first.summary.total}</dd><dd className={styles.statHint}>Execuções registradas</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Avaliados</dt><dd className={styles.statValue}>{first.summary.total - (first.summary.byStatus.ignorado ?? 0) - (first.summary.byStatus.recebido ?? 0)}</dd><dd className={styles.statHint}>Passaram pela validação</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Ignorados</dt><dd className={styles.statValue}>{first.summary.byStatus.ignorado ?? 0}</dd><dd className={styles.statHint}>Fora do contrato do agente</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Dados insuficientes</dt><dd className={styles.statValue}>{first.summary.byStatus.dados_insuficientes ?? 0}</dd><dd className={styles.statHint}>Análise incompleta; nada aprovado</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Em revisão</dt><dd className={styles.statValue}>{first.summary.byStatus.aguardando_aprovacao ?? 0}</dd><dd className={styles.statHint}>Veja na aba Exceções</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Bloqueados</dt><dd className={styles.statValue}>{first.summary.byStatus.bloqueado_politica ?? 0}</dd><dd className={styles.statHint}>Pausa, emergência ou agente desligado</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Simulação concluída</dt><dd className={styles.statValue}>{first.summary.byStatus.simulacao_concluida ?? 0}</dd><dd className={styles.statHint}>Nada executado fora do sistema</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Reavaliações permitidas</dt><dd className={styles.statValue}>{first.summary.reevaluationsAllowed ?? 0}</dd><dd className={styles.statHint}>Há dados novos verificáveis</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Reavaliações concluídas</dt><dd className={styles.statValue}>{first.summary.reevaluationsDone ?? 0}</dd><dd className={styles.statHint}>Registradas e vinculadas</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Aguardando o motor</dt><dd className={styles.statValue}>{first.summary.unprocessedEvents}</dd><dd className={styles.statHint}>Eventos ainda não recebidos</dd></div>
          </dl>

          <div className={styles.toolbar} style={{ margin: "1rem 0" }}>
            <div className={styles.chips} role="group" aria-label="Filtrar eventos por situação">
              {FILTER_STATUSES.map((f) => (
                <button key={f} type="button" className={`${styles.chip} ${filter === f ? styles.chipActive : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === "todos" ? "Todos" : runStatusLabel(f).label}</button>
              ))}
            </div>
            {canManage && <Button type="button" size="sm" onClick={() => setConfirmRun(true)} disabled={run.isPending}>Processar eventos agora…</Button>}
          </div>

          {runs.length === 0 ? (
            <p className={styles.empty} role="status">{filter === "todos" ? (first.summary.enabledEngineAgents === 0 ? "Nenhum evento foi processado: ligue um agente para esta organização na lista acima. Eventos anteriores ao momento em que o agente é ligado não são avaliados." : "Nenhum evento recebido ainda. Quando algo acontecer na organização (por exemplo, uma oportunidade criada), ele aparecerá aqui.") : "Nenhum evento nesta situação."}</p>
          ) : (
            <ul className={styles.list} aria-label="Eventos processados">
              {runs.map((r) => {
                const st = runStatusLabel(r.status);
                return (
                  <li key={r.id} className={`${styles.row} ${st.tone === "attention" ? styles.rowAttention : ""}`}>
                    <div className={styles.rowMain}>
                      <h3 className={styles.rowTitle}>{eventTypeLabel(r.eventType)} <Badge variant={badge(st.tone)}>{st.label}</Badge> <Badge variant="outline">Simulado</Badge>{r.reevaluated && <Badge variant="secondary">Reavaliada</Badge>}{r.completeness && r.completeness !== "completa" && <Badge variant={badge(COMPLETENESS_LABEL[r.completeness].tone)}>{COMPLETENESS_LABEL[r.completeness].label}</Badge>}</h3>
                      <p className={styles.rowText}>{r.reason ?? reasonText(r.reasonCode)}</p>
                      <span className={styles.rowMeta}>Agente {r.agentName} · execução #{r.id} · {r.entityType} {r.entityId ?? ""} · {r.ruleCode ? `regra ${r.ruleCode} · ` : ""}recebido em {fmtDateTime(r.createdAt)} · atualizado em {fmtDateTime(r.updatedAt)}{r.attempts > 0 ? ` · ${r.attempts} tentativa(s) com erro` : ""}</span>
                    </div>
                    <div className={styles.rowActions}>
                      {r.status === "dados_insuficientes" && canManage && <Button type="button" size="sm" variant="outline" onClick={() => { setReevalError(null); setDetailId(r.id); }} aria-label={`Nova análise da execução ${r.id}`}>Nova análise…</Button>}
                      {r.status === "aguardando_aprovacao" && onOpenExceptions && <Button type="button" size="sm" variant="outline" onClick={onOpenExceptions}>Ver exceção</Button>}
                      <Button type="button" size="sm" variant="outline" onClick={() => setDetailId(r.id)} aria-label={`Por que esta decisão? Execução ${r.id}`}>Por quê?</Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {query.hasNextPage && <div style={{ marginTop: "0.75rem" }}><Button type="button" size="sm" variant="outline" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? "Carregando..." : "Carregar mais"}</Button></div>}
        </>
      )}

      <Dialog open={confirmRun} onOpenChange={(o) => { if (!o && !run.isPending) setConfirmRun(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Processar eventos agora?</DialogTitle>
            <DialogDescription>Roda uma passada do motor SOMENTE para esta organização. Os agentes ligados avaliam os eventos novos e retomam os que estavam aguardando. É uma simulação: nada é executado fora do sistema, e a pausa, os limites e as regras de proteção continuam valendo.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmRun(false)} disabled={run.isPending}>Cancelar</Button>
            <Button type="button" onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? "Processando..." : "Processar (simulação)"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmReeval} onOpenChange={(o) => { if (!o && !reeval.isPending) { setConfirmReeval(false); setReevalError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Solicitar nova análise?</DialogTitle>
            <DialogDescription>A execução será avaliada de novo com os dados que hoje constam nos registros de origem (mostrados acima). Isto NÃO cria um evento novo, NÃO apaga a decisão anterior (ela fica no histórico) e é só simulação: nada é executado fora do sistema. Pausa, limites, política e agente ligado são conferidos de novo, e a nova decisão pode exigir aprovação.</DialogDescription>
          </DialogHeader>
          <label className={styles.label} htmlFor="reavaliacao-motivo">Motivo (opcional; fica no histórico; sem dados pessoais)</label>
          <input id="reavaliacao-motivo" className={styles.reasonInput} maxLength={300} value={reevalReason} onChange={(e) => setReevalReason(e.target.value)} disabled={reeval.isPending} />
          {reevalError && <p className={styles.errorText} role="alert">{reevalError}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => { setConfirmReeval(false); setReevalError(null); }} disabled={reeval.isPending}>Cancelar</Button>
            <Button type="button" onClick={() => reeval.mutate()} disabled={reeval.isPending}>{reeval.isPending ? "Reavaliando..." : "Solicitar nova análise (simulação)"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!detailId} onOpenChange={(o) => { if (!o) setDetailId(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Por que esta decisão? (execução {detailId})</DialogTitle><DialogDescription>Tudo é simulado: nada foi executado fora do sistema. Cada mudança de estado fica registrada e não pode ser apagada.</DialogDescription></DialogHeader>
          {detail.isError ? <p className={styles.errorText} role="alert">Não foi possível carregar a decisão. {detail.error instanceof Error ? detail.error.message : ""}</p> : !detail.data?.detail ? <Skeleton className={styles.skeleton} /> : (() => {
            const d = detail.data.detail; const x = d.explanation; const st = runStatusLabel(d.run.status);
            return (
              <div style={{ maxHeight: "65vh", overflowY: "auto", paddingRight: "0.25rem" }}>
                <dl className={styles.kv}>
                  <dt>Evento</dt><dd>{eventTypeLabel(d.run.eventType)} · {d.run.entityType} {d.run.entityId ?? ""} · recebido em {fmtDateTime(d.run.createdAt)}</dd>
                  <dt>Agente</dt><dd>{d.run.agentName}</dd>
                  <dt>Estado atual</dt><dd><Badge variant={badge(st.tone)}>{st.label}</Badge> <Badge variant="outline">Simulado</Badge></dd>
                  {x && (<><dt>Decisão</dt><dd><strong>{decisionLabel(x.decision)}</strong></dd><dt>Completude</dt><dd><Badge variant={badge(COMPLETENESS_LABEL[x.completeness].tone)}>{COMPLETENESS_LABEL[x.completeness].label}</Badge> {COMPLETENESS_LABEL[x.completeness].help}</dd><dt>Avaliado em</dt><dd>{fmtDateTime(x.evaluatedAt)} · avaliação nº {x.evaluationCount}</dd></>)}
                  <dt>Precisa de revisão?</dt><dd>{d.run.status === "aguardando_aprovacao" ? "Sim — veja a aba Exceções." : d.run.status === "dados_insuficientes" ? "Não há o que aprovar: complete os dados na origem." : "Não, no momento."}</dd>
                </dl>
                {onOpenTrace && <p style={{ margin: "0.5rem 0" }}><a className={styles.link} href={`/organizacoes/${organizationId}/auditoria?aba=rastreabilidade&execucao=${d.run.id}`} onClick={(e) => { e.preventDefault(); onOpenTrace(d.run.id); }}>Ver rastreabilidade e auditoria desta execução</a></p>}
                {!x ? <p className={styles.help}>Esta execução é anterior à explicação estruturada (M35); só o histórico abaixo está disponível.</p> : (
                  <>
                    <h3 className={styles.rowTitle} style={{ marginTop: "1rem" }}>Informações consideradas</h3>
                    <dl className={styles.kv} aria-label="Informações consideradas">{Object.entries(x.facts).map(([k, v]) => (<React.Fragment key={k}><dt>{FACT_LABEL[k] ?? k}</dt><dd>{factValue(k, v)}</dd></React.Fragment>))}</dl>
                    <h3 className={styles.rowTitle} style={{ marginTop: "1rem" }}>Informações ausentes</h3>
                    {x.missingRequired.length === 0 && x.missingOptional.length === 0 ? <p className={styles.help}>Nenhuma.</p> : (
                      <ul className={styles.history} aria-label="Informações ausentes">
                                        {x.missingRequired.map((m) => <li key={`r-${m}`}><strong>Obrigatória:</strong> {missingLabel(m)} — sem ela a análise é insuficiente.{MISSING_IMPACT[m] ? ` ${MISSING_IMPACT[m]}` : ""}</li>)}
                        {x.missingOptional.map((m) => <li key={`o-${m}`}>Opcional: {missingLabel(m)} — o sistema não registra essa informação neste fluxo; a regra correspondente não foi avaliada (ausência não é tratada como zero).</li>)}
                      </ul>
                    )}
                    <h3 className={styles.rowTitle} style={{ marginTop: "1rem" }}>Regras avaliadas</h3>
                    <ul className={styles.history} aria-label="Regras avaliadas">
                      {x.rules.map((r) => { const rr = RULE_RESULT_LABEL[r.result]; return (<li key={r.code}><Badge variant={badge(rr.tone)}>{rr.label}</Badge> <strong>{ruleLabel(r.code).title}</strong> ({r.code}) — {r.reason}{r.limit ? ` Limite em vigor: ${r.limit}.` : ""}{r.optional ? " (dado opcional)" : ""}</li>); })}
                    </ul>
                    {x.pendingRules.length > 0 && (<><h3 className={styles.rowTitle} style={{ marginTop: "1rem" }}>Regras previstas, ainda não implementadas</h3><ul className={styles.history} aria-label="Regras pendentes">{x.pendingRules.map((p) => <li key={p.code}><strong>{p.title}</strong> — {p.why}</li>)}</ul></>)}
                    {x.previous.length > 0 && (<><h3 className={styles.rowTitle} style={{ marginTop: "1rem" }}>Avaliações anteriores</h3><ul className={styles.history} aria-label="Avaliações anteriores">{x.previous.map((p, i) => <li key={i}>{fmtDateTime(p.at)} — {decisionLabel(p.decision)} (substituída pela reavaliação atual)</li>)}</ul></>)}
                  </>
                )}
                {d.related && (
                  <>
                    <h3 className={styles.rowTitle} style={{ marginTop: "1rem" }}>Oportunidade relacionada</h3>
                    <dl className={styles.kv} aria-label="Oportunidade relacionada">
                      <dt>Oportunidade</dt><dd>{d.related.title} (#{d.related.id}) · situação: {d.related.status}</dd>
                      <dt>Categoria considerada</dt><dd>{d.related.categoryConsidered ?? "nenhuma (não informada)"}{x?.facts?.origemCategoria ? ` — origem: ${String(x.facts.origemCategoria)}` : ""}</dd>
                      <dt>Categoria atual no registro</dt><dd>{d.related.currentCategory ?? "sem categoria"} · versão {d.related.version}{d.related.lastCategoryChange ? ` · alterada em ${fmtDateTime(d.related.lastCategoryChange.at)} por ${d.related.lastCategoryChange.byName ?? "uma pessoa"}` : ""}</dd>
                    </dl>
                    {d.related.categoryChangedSinceDecision && <p className={styles.help} role="status"><strong>A categoria do registro é diferente da considerada nesta avaliação.</strong> {d.run.status === "dados_insuficientes" ? "Há uma informação nova: veja “Nova análise” abaixo." : "Esta decisão continua baseada na categoria considerada acima, não na atual."}</p>}
                    {opportunityHref && <a className={styles.link} href={opportunityHref(d.related.id)} onClick={(e) => { if (onOpenOpportunity) { e.preventDefault(); onOpenOpportunity(d.related!.id); } }}>Abrir a oportunidade para consultar ou corrigir a categoria</a>}
                  </>
                )}
                {x?.supplement && (<><h3 className={styles.rowTitle} style={{ marginTop: "1rem" }}>Dados complementares desta reavaliação</h3><ul className={styles.history} aria-label="Origem dos dados complementares">{x.supplement.sources.map((so) => <li key={so.field}>{so.label}: <strong>{factValue(so.field, so.value)}</strong> — lido de {so.table} (registro {so.recordId}){so.recordedAt ? `, registrado em ${fmtDateTime(so.recordedAt)}` : ""}. Identificador de correlação: {x.supplement!.correlationId}.</li>)}</ul></>)}
                {d.reevaluation && (
                  <>
                    <h3 className={styles.rowTitle} style={{ marginTop: "1rem" }}>Nova análise</h3>
                    <p className={styles.help} role="status">{d.reevaluation.eligibility.state === "indisponivel" && d.reevaluation.eligibility.blockCode ? REEVALUATION_BLOCK_TEXT[d.reevaluation.eligibility.blockCode] ?? d.reevaluation.eligibility.message : d.reevaluation.eligibility.message}</p>
                    {d.reevaluation.eligibility.availableData.length > 0 && (<ul className={styles.history} aria-label="Dados novos disponíveis">{d.reevaluation.eligibility.availableData.map((so) => <li key={so.field}>Disponível agora: {so.label} = <strong>{factValue(so.field, so.value)}</strong> (de {so.table}, registro {so.recordId}).</li>)}</ul>)}
                    {d.reevaluation.eligibility.stillMissing.length > 0 && <p className={styles.help}>Ainda ausente nos registros: {d.reevaluation.eligibility.stillMissing.map(missingLabel).join(", ")}.</p>}
                    {canManage && d.reevaluation.eligibility.state === "elegivel" && <Button type="button" size="sm" onClick={() => { setReevalError(null); setConfirmReeval(true); }}>Solicitar nova análise…</Button>}
                    {d.reevaluation.history.length > 0 && (
                      <ul className={styles.history} aria-label="Histórico de reavaliações">
                        {d.reevaluation.history.map((h) => <li key={h.id}>{fmtDateTime(h.requestedAt)} — {REEVALUATION_OUTCOME_LABEL[h.outcome] ?? h.outcome} · pedida por {h.requestedByName ?? "uma pessoa"} · decisão anterior: {decisionLabel(h.previousDecision)}{h.newDecision ? ` → nova: ${decisionLabel(h.newDecision)}` : ""} · correlação {h.correlationId}</li>)}
                      </ul>
                    )}
                  </>
                )}
                <h3 className={styles.rowTitle} style={{ marginTop: "1rem" }}>Histórico de estados</h3>
                <ol className={styles.history} aria-label="Transições">
                  {d.history.map((h, i) => (
                    <li key={i}>{fmtDateTime(h.createdAt)} — {h.fromStatus ? `${runStatusLabel(h.fromStatus).label} → ` : ""}<strong>{runStatusLabel(h.toStatus).label}</strong> · {reasonText(h.reasonCode)} · {ACTOR_LABEL[h.actorType] ?? h.actorType}{h.actorName ? ` (${h.actorName})` : ""}</li>
                  ))}
                </ol>
              </div>
            );
          })()}
          <DialogFooter><Button type="button" variant="outline" onClick={() => setDetailId(null)}>Fechar</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
