import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { postAgentsEnable, ENGINE_AGENT_VALUES } from "../endpoints/agents-enable_POST.schema";
import { Bot, Info } from "lucide-react";
import { getAgents, type AgentOverview } from "../endpoints/agents_GET.schema";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Input } from "./Input";
import { Skeleton } from "./Skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import { TOOL_CLASS_LABEL, TOOL_LABEL, agentStateLabel, agentsHeadline, eventTypeLabel, fmtDateTime, type Tone } from "./agentOpsView";
import styles from "./AgentOps.module.css";

const badge = (tone: Tone) => (tone === "ok" ? "success" : tone === "attention" ? "destructive" : tone === "info" ? "secondary" : "outline") as "success" | "destructive" | "secondary" | "outline";

type Filter = "todos" | "atencao" | "ligados" | "desligados";
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "todos", label: "Todos" },
  { value: "atencao", label: "Precisam de atenção" },
  { value: "ligados", label: "Ligados" },
  { value: "desligados", label: "Desligados / não registrados" },
];

/** Visão geral dos agentes da organização: números reais do servidor, lista com busca e filtros e detalhe de cada agente (o que ele PODE fazer). Somente leitura. */
export function AgentOverviewPanel({ organizationId, onOpenTab, canManage = false }: { organizationId: number; onOpenTab?: (tab: "excecoes" | "alertas") => void; canManage?: boolean }) {
  const queryClient = useQueryClient();
  const [toggle, setToggle] = useState<{ agent: AgentOverview; enable: boolean } | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const enableMutation = useMutation({
    mutationFn: () => postAgentsEnable({ organizationId, agent: toggle!.agent.name as (typeof ENGINE_AGENT_VALUES)[number], enabled: toggle!.enable }),
    onSuccess: () => { toast.success(toggle!.enable ? "Agente ligado para esta organização." : "Agente desligado para esta organização."); setToggle(null); setToggleError(null); for (const k of ["agents", "agent-events"]) queryClient.invalidateQueries({ queryKey: [k, organizationId] }); },
    onError: (e) => { setToggleError(e instanceof Error ? e.message : "Não foi possível alterar o agente"); },
  });
  const query = useQuery({ queryKey: ["agents", organizationId], queryFn: () => getAgents({ organizationId }), retry: false, refetchInterval: 60_000 });
  const [filter, setFilter] = useState<Filter>("todos");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<AgentOverview | null>(null);
  const data = query.data;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.agents ?? []).filter((a) => {
      if (q && !`${a.label} ${a.name} ${a.purpose}`.toLowerCase().includes(q)) return false;
      if (filter === "atencao") return a.openAlerts > 0 || a.pendingExceptions > 0;
      if (filter === "ligados") return a.enabled === true;
      if (filter === "desligados") return a.enabled !== true;
      return true;
    });
  }, [data, filter, search]);

  if (query.isError) {
    return (
      <section className={styles.section} aria-labelledby="agentes-visao-titulo">
        <h2 id="agentes-visao-titulo" className={styles.sectionTitle}><Bot size={18} aria-hidden="true" /> Agentes</h2>
        <div className={styles.error}>
          <p className={styles.errorText} role="alert">Não foi possível carregar os agentes. {query.error instanceof Error ? query.error.message : ""}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>Tentar de novo</Button>
        </div>
      </section>
    );
  }
  if (!data) return <section className={styles.section} aria-label="Agentes" aria-busy="true"><Skeleton className={styles.skeleton} /></section>;

  const head = agentsHeadline(data.summary, data.automation);
  const blockReason = data.automation.global?.paused ? `Plataforma ${data.automation.global.emergency ? "em emergência" : "pausada"}${data.automation.global.reason ? `: “${data.automation.global.reason}”` : ""}` : data.automation.organization?.paused ? `Organização ${data.automation.organization.emergency ? "em emergência" : "pausada"}${data.automation.organization.reason ? `: “${data.automation.organization.reason}”` : ""}` : null;
  const stats: Array<{ key: string; label: string; value: number | string; hint: string }> = [
    { key: "total", label: "Agentes definidos", value: data.summary.total, hint: "Existem no código; poderes fixos" },
    { key: "registered", label: "Registrados", value: data.summary.registered, hint: "Já têm identidade no banco" },
    { key: "enabled", label: "Ligados", value: data.summary.enabled, hint: `${data.summary.disabled} desligado(s)` },
    { key: "attention", label: "Com alerta aberto", value: data.summary.withOpenAlerts, hint: "Avisos aguardando uma pessoa" },
    { key: "exceptions", label: "Com exceção pendente", value: data.summary.withPendingExceptions, hint: "Parados por uma regra de proteção" },
    ...(data.totals ? [{ key: "alertsTotal", label: "Alertas abertos", value: data.totals.openAlerts, hint: "Total da organização (aba Alertas)" }] : []),
  ];

  return (
    <section className={styles.section} aria-labelledby="agentes-visao-titulo" aria-busy={query.isFetching}>
      <h2 id="agentes-visao-titulo" className={styles.sectionTitle}><Bot size={18} aria-hidden="true" /> Agentes</h2>
      <div className={`${styles.banner} ${head.tone === "attention" ? styles.bannerAttention : ""}`} role="status" aria-live="polite">
        <Badge variant={badge(head.tone)}>{head.tone === "attention" ? "Atenção" : head.tone === "ok" ? "Em ordem" : "Informação"}</Badge>
        <p className={styles.bannerText}>{head.text}{blockReason ? ` — ${blockReason}.` : ""}</p>
      </div>
      <p className={styles.help} style={{ marginTop: "0.75rem" }}>
        Agentes são programas de apoio com identidade própria. <strong>Nenhum deles executa ação real</strong>: eles só avaliam eventos em simulação, pela camada de ferramentas, que registra tudo na auditoria e para diante de uma regra de
        proteção. Um agente só avalia eventos depois que uma pessoa o liga para esta organização.{data.eventConsumers.length > 0 ? ` Consumidores de eventos ativos: ${data.eventConsumers.map((c) => c.consumer).join(", ")}.` : ""}
      </p>

      <dl className={styles.statGrid}>
        {stats.map((s) => (
          <div key={s.key} className={styles.stat}>
            <dt className={styles.statLabel}>{s.label}</dt>
            <dd className={styles.statValue}>{s.value}</dd>
            <dd className={styles.statHint}>{s.hint}</dd>
          </div>
        ))}
      </dl>

      <div className={styles.toolbar} style={{ margin: "1rem 0" }}>
        <div className={styles.search}>
          <label className={styles.srOnly} htmlFor="agentes-busca">Buscar agente</label>
          <Input id="agentes-busca" type="search" placeholder="Buscar por nome ou finalidade" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className={styles.chips} role="group" aria-label="Filtrar agentes">
          {FILTERS.map((f) => (
            <button key={f.value} type="button" className={`${styles.chip} ${filter === f.value ? styles.chipActive : ""}`} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>{f.label}</button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className={styles.empty} role="status">{data.agents.length === 0 ? "Nenhum agente definido." : "Nenhum agente corresponde à busca ou ao filtro escolhido."}</p>
      ) : (
        <ul className={styles.list} aria-label="Lista de agentes">
          {visible.map((a) => {
            const state = agentStateLabel(a);
            const attention = a.openAlerts > 0 || a.pendingExceptions > 0;
            return (
              <li key={a.name} className={`${styles.row} ${attention ? styles.rowAttention : ""}`}>
                <div className={styles.rowMain}>
                  <h3 className={styles.rowTitle}>{a.label} <Badge variant={badge(state.tone)}>{state.label}</Badge> {attention && <Badge variant="destructive">Precisa de atenção</Badge>}</h3>
                  <p className={styles.rowText}>{a.purpose}</p>
                  <span className={styles.rowMeta}>
                    {a.eventTypes && a.eventTypes.length > 0 ? `Avalia: ${a.eventTypes.map(eventTypeLabel).join(", ")} · ` : "Ainda sem eventos ligados ao motor · "}Versão {a.version} · {a.scope === "global" ? "alcance global" : a.scope === "organizacao" ? "restrito a esta organização" : "ainda sem identidade no banco"} · {a.openAlerts} alerta(s) aberto(s) · {a.pendingExceptions} exceção(ões) pendente(s) · última ação: {a.lastActionAt ? fmtDateTime(a.lastActionAt) : "nenhuma registrada"}
                  </span>
                </div>
                <div className={styles.rowActions}>
                  {a.pendingExceptions > 0 && onOpenTab && <Button type="button" size="sm" variant="outline" onClick={() => onOpenTab("excecoes")}>Ver exceções</Button>}
                  {a.openAlerts > 0 && onOpenTab && <Button type="button" size="sm" variant="outline" onClick={() => onOpenTab("alertas")}>Ver alertas</Button>}
                  {canManage && a.eventTypes && a.eventTypes.length > 0 && (
                    <Button type="button" size="sm" variant={a.enabled === true ? "outline" : "primary"} onClick={() => { setToggle({ agent: a, enable: a.enabled !== true }); setToggleError(null); }} aria-label={`${a.enabled === true ? "Desligar" : "Ligar"} o agente ${a.label}`}>{a.enabled === true ? "Desligar…" : "Ligar…"}</Button>
                  )}
                  <Button type="button" size="sm" variant="outline" onClick={() => setDetail(a)} aria-label={`Detalhes do agente ${a.label}`}>Detalhes</Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={!!toggle} onOpenChange={(open) => { if (!open && !enableMutation.isPending) { setToggle(null); setToggleError(null); } }}>
        <DialogContent>
          {toggle && (
            <>
              <DialogHeader>
                <DialogTitle>{toggle.enable ? `Ligar ${toggle.agent.label}?` : `Desligar ${toggle.agent.label}?`}</DialogTitle>
                <DialogDescription>
                  {toggle.enable
                    ? "Isto liga o agente SOMENTE para esta organização e SOMENTE em simulação: ele passa a avaliar os eventos novos (não os anteriores a este momento), sujeito às regras de proteção, limites e pausa. Nada é executado fora do sistema. A decisão fica registrada na auditoria."
                    : "O agente deixa de avaliar eventos novos. Eventos já recebidos ficam como estão e retomam se você ligar de novo. A decisão fica registrada na auditoria."}
                </DialogDescription>
              </DialogHeader>
              {toggleError && <p className={styles.errorText} role="alert">{toggleError}</p>}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => { setToggle(null); setToggleError(null); }} disabled={enableMutation.isPending}>Cancelar</Button>
                <Button type="button" variant={toggle.enable ? "primary" : "destructive"} onClick={() => enableMutation.mutate()} disabled={enableMutation.isPending}>{enableMutation.isPending ? "Salvando..." : toggle.enable ? "Ligar (simulação)" : "Desligar"}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!detail} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <DialogContent>
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle>{detail.label}</DialogTitle>
                <DialogDescription>{detail.purpose}</DialogDescription>
              </DialogHeader>
              <dl className={styles.kv}>
                <dt>Identificador</dt><dd>{detail.name}</dd>
                <dt>Versão do código</dt><dd>{detail.version}</dd>
                <dt>Estado</dt><dd>{agentStateLabel(detail).label}{detail.enabled === null ? " (nunca usado: sem identidade registrada)" : ""}</dd>
                <dt>Alcance</dt><dd>{detail.scope === "global" ? "Global (age em qualquer organização, sempre explícita no pedido)" : detail.scope === "organizacao" ? "Somente esta organização" : "—"}</dd>
                <dt>Alertas abertos</dt><dd>{detail.openAlerts}</dd>
                <dt>Exceções pendentes</dt><dd>{detail.pendingExceptions}</dd>
                <dt>Última ação auditada</dt><dd>{fmtDateTime(detail.lastActionAt)}</dd>
              </dl>
              <h3 className={styles.sectionTitle} style={{ fontSize: "0.9375rem", marginTop: "1rem" }}>O que este agente pode fazer</h3>
              <ul className={styles.list}>
                {detail.tools.map((t) => (
                  <li key={t.name} className={styles.row} style={{ padding: "0.75rem" }}>
                    <div className={styles.rowMain}>
                      <p className={styles.rowTitle}>{TOOL_LABEL[t.name] ?? t.name} <Badge variant="outline">{TOOL_CLASS_LABEL[t.klass]?.label ?? t.klass}</Badge></p>
                      <span className={styles.rowMeta}>{TOOL_CLASS_LABEL[t.klass]?.help}</span>
                    </div>
                  </li>
                ))}
              </ul>
              <p className={styles.help} style={{ marginTop: "0.75rem" }}><Info size={14} aria-hidden="true" style={{ verticalAlign: "-2px" }} /> Nenhuma ferramenta altera estoque, permissão, aprovação ou dinheiro. Mudar o que um agente pode fazer é uma mudança de código revisada — não existe edição por tela. O interruptor de ligar/desligar só muda por decisão humana.</p>
              <DialogFooter><Button type="button" variant="outline" onClick={() => setDetail(null)}>Fechar</Button></DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
