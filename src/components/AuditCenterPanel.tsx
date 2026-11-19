import React, { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";
import { getAuditCenter, type AuditEntryView } from "../endpoints/audit-center_GET.schema";
import { getAuditCenterSummary } from "../endpoints/audit-center-summary_GET.schema";
import { getAuditCenterEntry } from "../endpoints/audit-center-entry_GET.schema";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Skeleton } from "./Skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./Dialog";
import { ACTOR_TYPE_LABEL, AREA_OPTIONS, OUTCOME_HELP, OUTCOME_OPTIONS, RECORD_VERSION_LABEL, outcomeBadge, outcomeLabel, actionLabel, dayEndExclusiveIso, dayStartIso, entityLink, formatCount, traceLink } from "./auditCenterView";
import styles from "./AuditCenter.module.css";

export interface AuditFilterState { from: string; to: string; area: string; action: string; actorType: string; resultado: string; correlationId: string; entityType: string; entityId: string }
export const EMPTY_FILTERS: AuditFilterState = { from: "", to: "", area: "", action: "", actorType: "", resultado: "", correlationId: "", entityType: "", entityId: "" };

const fmt = (iso: string) => new Date(iso).toLocaleString("pt-BR");

/**
 * Central de Auditoria (M38) — registros. Tudo que filtra, ordena e pagina acontece NO SERVIDOR (cursor por id): o navegador nunca recebe o histórico inteiro. O total exibido é o filtrado
 * (limitado a 10.000, dito em palavras); o histórico completo aparece separado nos indicadores. Valores de hash são internos e não são mostrados.
 */
export function AuditCenterPanel({ organizationId, filters, onFiltersChange, onOpenTrace, canSeeAutomation, onEntryChange }: { organizationId: number; filters: AuditFilterState; onFiltersChange: (next: AuditFilterState) => void; onOpenTrace: (href: string) => void; canSeeAutomation: boolean; /** Abre o diálogo do registro (o estado vive na URL: voltar do navegador fecha o diálogo e preserva filtros). */ onEntryChange: (id: string | null) => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AuditFilterState>(filters);
  const setDetailId = onEntryChange;
  React.useEffect(() => setDraft(filters), [filters]);

  const invalidPeriod = !!draft.from && !!draft.to && draft.from > draft.to;
  const query = useMemo(() => ({
    organizationId,
    from: filters.from ? dayStartIso(filters.from) : undefined,
    to: filters.to ? dayEndExclusiveIso(filters.to) : undefined,
    area: (filters.area || undefined) as never,
    action: filters.action || undefined,
    actorType: (filters.actorType || undefined) as never,
    resultado: (filters.resultado || undefined) as never,
    correlationId: filters.correlationId || undefined,
    entityType: filters.entityType || undefined,
    entityId: filters.entityId || undefined,
  }), [organizationId, filters]);

  const list = useInfiniteQuery({
    queryKey: ["audit-center", organizationId, query],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => getAuditCenter({ ...query, limit: 30, beforeId: pageParam }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const entries: AuditEntryView[] = list.data?.pages.flatMap((p) => p.entries) ?? [];
  const topId = list.data?.pages[0]?.entries[0]?.id;
  const total = list.data?.pages[0]?.total;

  // Novos registros chegam com id MAIOR: contados sem recarregar a lista (a página já lida não muda de lugar).
  const newer = useQuery({
    queryKey: ["audit-center-newer", organizationId, query, topId],
    queryFn: () => getAuditCenter({ ...query, limit: 1, sinceId: topId }),
    enabled: !!topId,
    refetchInterval: 20000,
  });
  const newerCount = newer.data?.newerCount ?? 0;

  const summary = useQuery({
    queryKey: ["audit-center-summary", organizationId, query.from, query.to],
    queryFn: () => getAuditCenterSummary({ organizationId, from: query.from ? new Date(query.from) : undefined, to: query.to ? new Date(query.to) : undefined }),
  });

  const apply = (e: React.FormEvent) => { e.preventDefault(); if (!invalidPeriod) onFiltersChange(draft); };
  const reset = () => { setDraft(EMPTY_FILTERS); onFiltersChange(EMPTY_FILTERS); };
  const activeChips: string[] = [];
  if (filters.from) activeChips.push(`desde ${filters.from}`);
  if (filters.to) activeChips.push(`até ${filters.to}`);
  if (filters.area) activeChips.push(`área: ${AREA_OPTIONS.find((a) => a.value === filters.area)?.label ?? filters.area}`);
  if (filters.action) activeChips.push(`ação: ${filters.action}`);
  if (filters.actorType) activeChips.push(`autor: ${ACTOR_TYPE_LABEL[filters.actorType as keyof typeof ACTOR_TYPE_LABEL] ?? filters.actorType}`);
  if (filters.resultado) activeChips.push(`resultado: ${OUTCOME_OPTIONS.find((o) => o.value === filters.resultado)?.label ?? filters.resultado}`);
  if (filters.correlationId) activeChips.push(`correlação ${filters.correlationId.slice(0, 8)}…`);
  if (filters.entityType) activeChips.push(`recurso: ${filters.entityType}${filters.entityId ? ` #${filters.entityId}` : ""}`);

  const nextPageFailed = list.isFetchNextPageError;
  const fetchMore = () => { void list.fetchNextPage(); };
  const S = summary.data;
  const periodText = S ? (S.period.from || S.period.to ? "no período escolhido" : "em todo o histórico") : "";

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="ac-resumo">
        <h2 id="ac-resumo" className={styles.sectionTitle}>Resumo {periodText}</h2>
        <p className={styles.help}>Os números do período seguem o filtro de datas abaixo. “Histórico total” inclui todas as datas. Contagens acima de 10.000 aparecem como “10.000 ou mais”. Um traço significa que o seu papel não consulta esse dado — não é zero.</p>
        {summary.isLoading ? <Skeleton className={styles.skeleton} /> : summary.isError ? (
          <div className={styles.error} role="alert"><span>Não foi possível carregar o resumo.</span><Button variant="outline" size="sm" onClick={() => summary.refetch()}>Tentar de novo</Button></div>
        ) : S ? (
          <dl className={styles.statGrid}>
            <div className={styles.stat}><dt className={styles.statLabel}>Operações registradas</dt><dd className={styles.statValue}>{formatCount(S.operations)}</dd><dd className={styles.statHint}>{S.period.from || S.period.to ? "No período" : "Todo o histórico"}</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Concluídas</dt><dd className={styles.statValue}>{formatCount(S.byOutcome.concluida)}</dd><dd className={styles.statHint}>Resultado registrado</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Recusadas</dt><dd className={styles.statValue}>{formatCount(S.byOutcome.recusada)}</dd><dd className={styles.statHint}>Barradas por regra</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Falharam</dt><dd className={styles.statValue}>{formatCount(S.byOutcome.falhou)}</dd><dd className={styles.statHint}>Registradas fora da transação revertida</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Pendentes</dt><dd className={styles.statValue}>{formatCount(S.byOutcome.pendente)}</dd><dd className={styles.statHint}>Aguardam decisão ou dado</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Resultado não registrado</dt><dd className={styles.statValue}>{formatCount(S.byOutcome.naoRegistrado)}</dd><dd className={styles.statHint}>Histórico e operações não instrumentadas — não é sucesso</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Histórico total</dt><dd className={styles.statValue}>{formatCount(S.history)}</dd><dd className={styles.statHint}>Todas as datas</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Execuções dos agentes</dt><dd className={styles.statValue}>{S.automation ? S.automation.agentDecisions.total : <span className={styles.unknown} aria-label="indisponível para o seu papel">—</span>}</dd><dd className={styles.statHint}>{S.automation ? "Simulações no período" : "Sem permissão de automação"}</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Exceções criadas</dt><dd className={styles.statValue}>{S.automation ? S.automation.exceptionsCreated : <span className={styles.unknown} aria-label="indisponível para o seu papel">—</span>}</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Exceções resolvidas</dt><dd className={styles.statValue}>{S.automation ? S.automation.exceptionsResolved : <span className={styles.unknown} aria-label="indisponível para o seu papel">—</span>}</dd><dd className={styles.statHint}>Última decisão no período</dd></div>
            <div className={styles.stat}><dt className={styles.statLabel}>Reavaliações</dt><dd className={styles.statValue}>{S.automation ? S.automation.reevaluations.total : <span className={styles.unknown} aria-label="indisponível para o seu papel">—</span>}</dd><dd className={styles.statHint}>{S.automation ? `${S.automation.reevaluations.byOutcome.concluida ?? 0} concluída(s)` : "Sem permissão de automação"}</dd></div>
          </dl>
        ) : null}
      </section>

      <section className={styles.section} aria-labelledby="ac-filtros">
        <h2 id="ac-filtros" className={styles.sectionTitle}><Search size={18} aria-hidden="true" /> Filtros</h2>
        <form onSubmit={apply} className={styles.filters} aria-label="Filtros da trilha de auditoria">
          <label className={styles.field}><span className={styles.fieldLabel}>De (data)</span><input className={styles.control} type="date" value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></label>
          <label className={styles.field}><span className={styles.fieldLabel}>Até (data, inclusive)</span><input className={styles.control} type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></label>
          <label className={styles.field}><span className={styles.fieldLabel}>Área da operação</span>
            <select className={styles.control} value={draft.area} onChange={(e) => setDraft({ ...draft, area: e.target.value })}>
              <option value="">Todas</option>
              {AREA_OPTIONS.filter((a) => canSeeAutomation || (a.value !== "agentes" && a.value !== "automacao")).map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </label>
          <label className={styles.field}><span className={styles.fieldLabel}>Ação exata</span><input className={styles.control} type="text" inputMode="text" autoComplete="off" placeholder="ex.: oportunidade.categoria_alterada" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value.trim().toLowerCase() })} pattern="[a-z0-9_.]*" maxLength={80} /></label>
          <label className={styles.field}><span className={styles.fieldLabel}>Quem agiu</span>
            <select className={styles.control} value={draft.actorType} onChange={(e) => setDraft({ ...draft, actorType: e.target.value })}>
              <option value="">Pessoas, agentes e sistema</option>
              <option value="user">Pessoas</option>
              <option value="agent">Agentes</option>
              <option value="system">Sistema</option>
            </select>
          </label>
          <label className={styles.field}><span className={styles.fieldLabel}>Identificador de correlação</span><input className={styles.control} type="text" autoComplete="off" placeholder="UUID de uma correlação" value={draft.correlationId} onChange={(e) => setDraft({ ...draft, correlationId: e.target.value.trim() })} pattern="[0-9a-fA-F-]{36}|" maxLength={36} /></label>
          <label className={styles.field}><span className={styles.fieldLabel}>Resultado</span>
            <select className={styles.control} value={draft.resultado} onChange={(e) => setDraft({ ...draft, resultado: e.target.value })}>
              <option value="">Todos</option>
              {OUTCOME_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <div className={styles.filterActions}>
            <Button type="submit" size="sm" disabled={invalidPeriod}>Aplicar filtros</Button>
            <Button type="button" variant="outline" size="sm" onClick={reset}>Limpar</Button>
          </div>
        </form>
        {invalidPeriod && <p className={styles.help} role="alert" style={{ color: "var(--destructive)", marginTop: "0.5rem" }}>A data inicial deve ser anterior ou igual à final.</p>}
        <p className={styles.help} style={{ marginTop: "0.75rem" }}>{OUTCOME_HELP}</p>
        {activeChips.length > 0 && <div className={styles.activeFilters} aria-label="Filtros ativos">{activeChips.map((c) => <span key={c} className={styles.filterChip}>{c}</span>)}</div>}
      </section>

      <section className={styles.section} aria-labelledby="ac-lista">
        <h2 id="ac-lista" className={styles.sectionTitle}>Registros</h2>
        {newerCount > 0 && (
          <div className={styles.banner} role="status">
            <span><strong>{newerCount} {newerCount === 1 ? "registro novo" : "registros novos"}</strong> desde que esta lista foi carregada. A página que você está lendo não muda de lugar.</span>
            <Button size="sm" variant="outline" onClick={() => queryClient.resetQueries({ queryKey: ["audit-center", organizationId] })}><RefreshCw size={14} aria-hidden="true" /> Mostrar os novos</Button>
          </div>
        )}
        {total && <p className={styles.total} aria-live="polite">{formatCount(total)} {total.count === 1 && !total.capped ? "registro corresponde" : "registros correspondem"} aos filtros{activeChips.length === 0 ? " (nenhum filtro ativo)" : ""}. Ordem: mais recentes primeiro.</p>}
        {list.isLoading ? (
          <div className={styles.list} aria-busy="true"><Skeleton className={styles.skeleton} /><Skeleton className={styles.skeleton} /><Skeleton className={styles.skeleton} /></div>
        ) : list.isError ? (
          <div className={styles.error} role="alert"><span>{(list.error as Error).message || "Não foi possível carregar os registros."} Nada foi alterado.</span><Button variant="outline" size="sm" onClick={() => list.refetch()}>Tentar de novo</Button></div>
        ) : entries.length === 0 ? (
          <p className={styles.empty}>{activeChips.length ? "Nenhum registro corresponde a estes filtros. Ajuste ou limpe os filtros para ver mais." : "Ainda não há registros de auditoria nesta organização. Cada ação relevante ficará registrada aqui, de forma permanente."}</p>
        ) : (
          <>
            <ul className={styles.list}>
              {entries.map((e) => (
                <li key={e.id} className={`${styles.row} ${e.outcome === "falhou" || e.outcome === "recusada" ? styles.rowAttention : ""}`}>
                  <div className={styles.rowMain}>
                    <span className={styles.rowTitle}>{actionLabel(e.action)}</span>
                    <span className={styles.rowMeta}>{fmt(e.createdAt)} · {e.actorName ?? ACTOR_TYPE_LABEL[e.actorType]}{e.actorType !== "user" ? ` (${ACTOR_TYPE_LABEL[e.actorType].toLowerCase()})` : ""} · {e.entityType}{e.entityId ? ` #${e.entityId}` : ""}</span>
                    <span className={styles.rowBadges}>
                      <Badge variant={outcomeBadge(e.outcome)}>{outcomeLabel(e.outcome)}</Badge>
                      {e.correlationId && <span className={styles.code}>correlação {e.correlationId.slice(0, 8)}…</span>}
                      <span className={styles.code}>registro #{e.id}</span>
                    </span>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setDetailId(e.id)} aria-label={`Ver detalhes do registro ${e.id}: ${actionLabel(e.action)}`}>Detalhes</Button>
                </li>
              ))}
            </ul>
            <div className={styles.more}>
              {list.hasNextPage ? <Button variant="outline" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>{list.isFetchingNextPage ? "Carregando…" : "Carregar mais antigos"}</Button> : <span className={styles.help}>Fim dos registros para estes filtros.</span>}
            </div>
            {nextPageFailed && <div className={styles.error} role="alert"><span>Não foi possível carregar a próxima página. Os registros já exibidos continuam corretos.</span><Button variant="outline" size="sm" onClick={fetchMore}>Tentar de novo</Button></div>}
          </>
        )}
      </section>
    </div>
  );
}

export function AuditEntryDialog({ organizationId, entryId, onClose, onFilterCorrelation, onOpenTrace, onNavigate, restoreFocus }: { organizationId: number; entryId: string | null; /** Devolve o foco ao botão que abriu o diálogo (acessibilidade de teclado). */ restoreFocus?: () => HTMLElement | null; onClose: () => void; onFilterCorrelation: (c: string) => void; onOpenTrace: (href: string) => void; onNavigate: (href: string) => void }) {
  const q = useQuery({ queryKey: ["audit-center-entry", organizationId, entryId], queryFn: () => getAuditCenterEntry({ organizationId, id: entryId! }), enabled: !!entryId });
  const e = q.data?.entry;
  const res = e ? entityLink(organizationId, e.entityType, e.entityId) : null;
  const trace = e ? traceLink(organizationId, e.entityType, e.entityId) : null;
  return (
    <Dialog open={!!entryId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent onCloseAutoFocus={(ev) => { const el = restoreFocus?.(); if (el) { ev.preventDefault(); el.focus(); } }}>
        <DialogHeader>
          <DialogTitle>{e ? actionLabel(e.action) : "Registro de auditoria"}</DialogTitle>
          <DialogDescription>Registro #{entryId}. Somente leitura: a trilha não pode ser editada.</DialogDescription>
        </DialogHeader>
        {q.isLoading ? <Skeleton className={styles.skeleton} /> : q.isError ? (
          <div className={styles.error} role="alert"><span>{(q.error as Error).message}</span><Button variant="outline" size="sm" onClick={() => q.refetch()}>Tentar de novo</Button></div>
        ) : e ? (
          <div>
            <dl className={styles.kv}>
              <dt>Quando</dt><dd>{fmt(e.createdAt)}</dd>
              <dt>Quem agiu</dt><dd>{e.actorName ?? "—"} ({ACTOR_TYPE_LABEL[e.actorType].toLowerCase()})</dd>
              <dt>Ação (código)</dt><dd className={styles.code}>{e.action}</dd>
              <dt>Recurso</dt><dd>{e.entityType}{e.entityId ? ` #${e.entityId}` : ""}</dd>
              <dt>Resultado</dt><dd>{outcomeLabel(e.outcome)}{e.outcome === null ? " — este registro não traz o resultado; ele não é presumido nem deduzido do nome da ação" : ""}</dd>
              <dt>Correlação persistida</dt><dd className={styles.code}>{e.correlationId ?? "sem correlação (registro anterior à M39 ou operação isolada)"}</dd>
              <dt>Identificador da operação</dt><dd className={styles.code}>{e.operationId ?? "não registrado"}</dd>
              <dt>Formato do registro</dt><dd>{RECORD_VERSION_LABEL[e.recordVersion] ?? `versão ${e.recordVersion}`}</dd>
              <dt>Na cadeia de hash</dt><dd>{e.chained ? "Sim (o valor do hash é interno e não é exibido)" : "Não — anterior ao encadeamento, não verificável"}</dd>
            </dl>
            <div className={styles.linkRow}>
              {res && <button type="button" className={styles.link} onClick={() => onNavigate(res.href)}>{res.label}</button>}
              {trace && <button type="button" className={styles.link} onClick={() => onOpenTrace(trace)}>Ver a rastreabilidade completa</button>}
              {e.correlationId && <button type="button" className={styles.link} onClick={() => onFilterCorrelation(e.correlationId!)}>Filtrar por esta correlação</button>}
            </div>
            <h3 className={styles.subTitle}>Dados gravados (minimizados)</h3>
            <pre className={styles.pre} tabIndex={0} aria-label="Metadados do registro">{JSON.stringify(e.metadata, null, 2)}</pre>
            {e.correlated.length > 0 && (<><h3 className={styles.subTitle}>Mesma correlação</h3><ul className={styles.list}>{e.correlated.map((c) => <li key={c.id} className={styles.rowMeta}>#{c.id} · {actionLabel(c.action)} · {fmt(c.createdAt)}</li>)}</ul></>)}
            {e.sameEntity.length > 0 && (<><h3 className={styles.subTitle}>Outros registros deste recurso</h3><ul className={styles.list}>{e.sameEntity.slice(0, 10).map((c) => <li key={c.id} className={styles.rowMeta}>#{c.id} · {actionLabel(c.action)} · {fmt(c.createdAt)}</li>)}</ul></>)}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
