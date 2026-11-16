import React, { useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getOrganizations } from "../endpoints/organizations_GET.schema";
import { getImpactReport, type OutputType, type ReceiptEvent, type ReceiptGroup, type NeedReportRow, type ReportEventType } from "../endpoints/impact-report_GET.schema";
import { getInventoryItems } from "../endpoints/inventory-items_GET.schema";
import { getNeeds } from "../endpoints/needs_GET.schema";
import { localISODate, reportRange } from "../helpers/reportDates";
import { Input } from "../components/Input";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { Skeleton } from "../components/Skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/Select";
import { ArrowLeft, FileText, Printer, ShieldAlert, CornerDownRight, TriangleAlert, CheckCircle2 } from "lucide-react";
import { DESTINATION_LABELS, DESTINATION_TYPES, type DestinationType } from "../helpers/destinationRules";
import { ActiveTab } from "../components/ActiveTab";
import styles from "./organizacoes.$organizationId.prestacao-contas.module.css";

const nf = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 });
const fmt = (n: number) => nf.format(n);
const plus = (n: number) => (n === 0 ? "0" : `+${fmt(n)}`);
const minus = (n: number) => (n === 0 ? "0" : `−${fmt(n)}`);
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt(Math.abs(n))}`;
const dateTime = (iso: string) => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

const EVENT_TYPE_LABELS: Record<ReportEventType, string> = {
  recebimento: "Recebimentos da rede Levora",
  entrada_manual: "Entradas manuais de estoque",
  correcao: "Correções",
  estorno: "Estornos",
};
const INDICATOR_LABELS: Record<string, string> = {
  atendimento: "Atendimento (contabilizável)",
  operacao: "Uso operacional da instituição",
  terceiros: "Doações a terceiros",
  devolucao_ao_doador: "Devoluções ao doador",
  perdas: "Perdas",
  descartes: "Descartes",
};

function DestinationSection({ data }: { data: OutputType }) {
  const d = data.destination;
  const inconsistent = data.reconciliation.filter((r) => !r.balanced || !r.exitsBalanced);
  return (
    <section aria-labelledby="dest-report-title" data-testid="destination-report">
      <h3 id="dest-report-title" className={styles.sectionTitle}>Destinação das saídas</h3>
      <p className={styles.sectionHint}>
        Destinação <strong>declarada</strong> pela organização — não é confirmação de entrega ao beneficiário. Físico e atendimento contabilizável ficam em colunas separadas e
        unidades diferentes nunca são somadas. Filtro por {d.basis === "efetiva" ? "data efetiva da entrega" : "data de registro"}; revertido é o acumulado até hoje.
      </p>
      {d.byPurpose.length === 0 ? (
        <p className={styles.emptyText}>Nenhuma destinação registrada neste período.</p>
      ) : (
        <>
          <div className={`${styles.tableScroll} ${styles.desktopOnly}`}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Finalidade</th>
                  <th>Item</th>
                  <th>Registros</th>
                  <th>Físico</th>
                  <th>Revertido</th>
                  <th>Físico líquido</th>
                  <th>Atendimento</th>
                  <th>Excedente</th>
                  <th>Unid. incompatível</th>
                  <th>Pessoas / famílias declaradas</th>
                </tr>
              </thead>
              <tbody>
                {d.byPurpose.map((r) => (
                  <tr key={`${r.destinationType}-${r.itemId}-${r.unit}`}>
                    <td>{DESTINATION_LABELS[r.destinationType].label}</td>
                    <td>{r.itemName} ({r.unit})</td>
                    <td>{r.records}</td>
                    <td>{fmt(r.physical)}</td>
                    <td>{minus(r.reverted)}</td>
                    <td><strong>{fmt(r.physicalNet)}</strong></td>
                    <td>{fmt(r.appliedNet)}</td>
                    <td>{fmt(r.surplusNet)}</td>
                    <td>{fmt(r.incompatibleNet)}</td>
                    <td>{r.declaredPeople.pessoas} pessoas · {r.declaredPeople.familias} famílias</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className={`${styles.cardList} ${styles.mobileOnly}`}>
            {d.byPurpose.map((r) => (
              <li key={`m-${r.destinationType}-${r.itemId}-${r.unit}`} className={styles.miniCard}>
                <strong>{DESTINATION_LABELS[r.destinationType].label}</strong>
                <div className={styles.kv}><span>Item</span><span>{r.itemName} ({r.unit})</span></div>
                <div className={styles.kv}><span>Registros</span><span>{r.records}</span></div>
                <div className={styles.kv}><span>Físico líquido</span><strong>{fmt(r.physicalNet)}</strong></div>
                <div className={styles.kv}><span>Atendimento</span><strong>{fmt(r.appliedNet)}</strong></div>
                <div className={styles.kv}><span>Físico / revertido</span><span>{fmt(r.physical)} / {minus(r.reverted)}</span></div>
                <div className={styles.kv}><span>Excedente</span><span>{fmt(r.surplusNet)}</span></div>
                <div className={styles.kv}><span>Unid. incompatível</span><span>{fmt(r.incompatibleNet)}</span></div>
                <div className={styles.kv}><span>Declarados</span><span>{r.declaredPeople.pessoas} pessoas · {r.declaredPeople.familias} famílias</span></div>
              </li>
            ))}
          </ul>
          <p className={styles.sectionHint}>
            Pessoas e famílias são a soma das quantidades <strong>declaradas</strong> nos registros (não são pessoas distintas). {d.correctedRecords} registro(s) corrigido(s) e {d.revertedRecords} revertido(s) total ou parcialmente;
            no período foram criados {d.eventsInPeriod.corrections} correção(ões) documental(is), {d.eventsInPeriod.estornoDocumental} estorno(s) documental(is), {d.eventsInPeriod.devolucaoFisica} devolução(ões) física(s) e {d.eventsInPeriod.correcaoQuantidade} correção(ões) de quantidade.
          </p>
        </>
      )}

      <h4 className={styles.sectionTitle}>Indicadores separados</h4>
      {d.indicators.length === 0 ? (
        <p className={styles.emptyText}>Sem indicadores neste período.</p>
      ) : (
        <ul className={styles.cardList}>
          {d.indicators.map((i) => (
            <li key={`${i.group}-${i.unit}`} className={styles.miniCard}>
              <div className={styles.kv}><span>{INDICATOR_LABELS[i.group]}</span><strong>{fmt(i.physicalNet)} {i.unit}</strong></div>
            </li>
          ))}
        </ul>
      )}

      <h4 className={styles.sectionTitle}>Saídas sem destinação estruturada</h4>
      <p className={styles.sectionHint}>Saídas anteriores ao registro de destinação. Nenhuma foi reclassificada: continuam como foram registradas.</p>
      {d.withoutStructuredDestination.automaticHistorical.length === 0 && d.withoutStructuredDestination.notClassified.length === 0 ? (
        <p className={styles.emptyText}>Nenhuma saída sem destinação estruturada neste período.</p>
      ) : (
        <ul className={styles.cardList}>
          {d.withoutStructuredDestination.automaticHistorical.map((r) => (
            <li key={`a-${r.itemId}`} className={styles.miniCard}><div className={styles.kv}><span>Baixa automática histórica (resolução da necessidade) — {r.itemName}</span><strong>{fmt(r.quantity)} {r.unit} · {r.count} saída(s)</strong></div></li>
          ))}
          {d.withoutStructuredDestination.notClassified.map((r) => (
            <li key={`n-${r.itemId}`} className={styles.miniCard}><div className={styles.kv}><span>Sem destinação estruturada — {r.itemName}</span><strong>{fmt(r.quantity)} {r.unit} · {r.count} saída(s)</strong></div></li>
          ))}
        </ul>
      )}

      <h4 className={styles.sectionTitle}>Conciliação por item</h4>
      <p className={styles.sectionHint}>Saldo no início + entradas + ajustes − saídas = saldo no fim; e saídas = com destinação + sem destinação estruturada.</p>
      {inconsistent.length > 0 && (
        <div className={styles.statusWarning} role="alert"><TriangleAlert size={12} aria-hidden /> {inconsistent.length} item(ns) não conciliam: {inconsistent.map((r) => r.itemName).join(", ")}.</div>
      )}
      {data.reconciliation.length === 0 ? (
        <p className={styles.emptyText}>Nenhum item para conciliar neste período.</p>
      ) : (
        <ul className={styles.cardList}>
          {data.reconciliation.map((r) => (
            <li key={`c-${r.itemId}`} className={styles.miniCard} data-testid="reconciliation-row" data-balanced={r.balanced && r.exitsBalanced}>
              <div className={styles.kv}>
                <span>{r.itemName} ({r.unit})</span>
                <span>
                  {r.balanced && r.exitsBalanced ? <CheckCircle2 size={12} aria-label="Conciliado" /> : <TriangleAlert size={12} aria-label="Não concilia" />}{" "}
                  {/* M04/F10: sinais explícitos e espaçados (`signed(0)` devolvia "0" sem sinal e o ajuste grudava na entrada: "0 + 5 0 − 2"); frase completa. Valores e cálculo não mudam. */}
                  {fmt(r.balanceAtStart)} + {fmt(r.entradas)} {r.ajustes < 0 ? "−" : "+"} {fmt(Math.abs(r.ajustes))} − {fmt(r.saidas)} = {fmt(r.balanceAtEnd)} · saídas: {fmt(r.saidasComDestinacao)} com destinação + {fmt(r.saidasSemDestinacao)} sem destinação estruturada
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const STATUS_LABELS: Record<string, string> = { aberta: "Aberta", em_andamento: "Em andamento", atendida: "Atendida", cancelada: "Cancelada" };

function EventLines({ ev, unit }: { ev: ReceiptEvent; unit: string }) {
  const dim = ev.inPeriod ? "" : ` ${styles.outside}`;
  return (
    <li className={`${styles.eventItem}${dim}`}>
      <div className={styles.eventHead}>
        <CornerDownRight size={14} aria-hidden />
        {ev.kind === "correcao" && (
          <>
            <strong>{ev.subtype === "unidade" ? "Correção de unidade" : `Correção ${signed(ev.delta)} ${ev.unit}`}</strong>
            <Badge variant="secondary">Não é nova doação</Badge>
          </>
        )}
        {ev.kind === "reativacao" && (
          <>
            <strong>Desfazer estorno ({fmt(ev.quantityTo ?? 0)} {ev.unit})</strong>
            <Badge variant="secondary">Não é nova doação</Badge>
          </>
        )}
        {ev.kind === "estorno" && (
          <>
            <strong>Estorno {signed(ev.delta)} {ev.unit}</strong>
            <Badge variant="outline">{ev.physical ? "Contábil" : "Só contábil"}</Badge>
          </>
        )}
        {!ev.inPeriod && <Badge variant="outline">Antes do período</Badge>}
      </div>
      <div className={styles.eventMeta}>
        {dateTime(ev.createdAt)}
        {ev.authorName ? ` · ${ev.authorName}` : ""}
        {ev.approvedByName ? ` · aprovado por ${ev.approvedByName}` : ""}
      </div>
      {ev.kind === "correcao" && ev.quantityFrom !== null && ev.quantityTo !== null && (
        <div className={styles.eventDetail}>
          {ev.subtype === "unidade" ? `${ev.unitFrom} → ${ev.unit} (sem conversão; ${fmt(ev.quantityTo)})` : `${fmt(ev.quantityFrom)} → ${fmt(ev.quantityTo)} ${ev.unit}`} · efeito no atendimento {signed(ev.countedEffect)}
        </div>
      )}
      {ev.kind === "estorno" && <div className={styles.eventDetail}>Efeito no atendimento {signed(ev.countedEffect)}</div>}
      {ev.physical ? (
        <div className={styles.physicalLine}>
          <CornerDownRight size={12} aria-hidden />
          {ev.physical.withdrawal ? "Retirada física do estorno" : "Ajuste físico"} {signed(ev.physical.delta)} {unit}
          <Badge variant="outline">Estoque</Badge>
        </div>
      ) : ev.kind === "estorno" ? (
        <div className={styles.physicalLine}>Estorno só contábil — estoque físico não alterado</div>
      ) : (
        <div className={styles.physicalLine}>Sem movimento de estoque</div>
      )}
      {ev.reason && <div className={styles.eventReason}>Motivo: {ev.reason}</div>}
    </li>
  );
}

function ReceiptGroupView({ g }: { g: ReceiptGroup }) {
  const unit = g.item?.unit ?? g.original?.unit ?? "";
  return (
    <li className={styles.group}>
      <div className={styles.groupHead}>
        <strong>{g.opportunityTitle ?? `Recebimento da atribuição #${g.allocationId}`}</strong>
        <span className={styles.groupMeta}>
          {g.item ? `${g.item.name}` : ""}
          {g.needTitle ? ` · necessidade “${g.needTitle}”` : ""}
        </span>
      </div>
      {g.original && (
        <div className={styles.originalLine}>
          <Badge variant="success">Recebimento original</Badge> <strong>{fmt(g.original.quantity)} {g.original.unit}</strong>
          <span className={styles.eventMeta}> · {dateTime(g.original.createdAt)}{g.original.authorName ? ` · ${g.original.authorName}` : ""}{g.original.inPeriod ? "" : " · antes do período"}</span>
          {g.original.physicalDelta !== null && <div className={styles.physicalLine}>Entrada física {signed(g.original.physicalDelta)} {unit}</div>}
        </div>
      )}
      <ol className={styles.eventList}>
        {g.events.map((ev, i) => (
          <EventLines key={`${g.allocationId}-${i}`} ev={ev} unit={unit} />
        ))}
      </ol>
      <div className={styles.netLine}>Líquido do atendimento desta atribuição: <strong>{fmt(g.netCounted)} {g.original?.unit ?? unit}</strong></div>
    </li>
  );
}

function filtersSummary(data: OutputType, itemName: string | null, needTitle: string | null): string {
  const parts: string[] = [];
  if (data.filters.itemId) parts.push(`item: ${itemName ?? `#${data.filters.itemId}`}`);
  if (data.filters.needId) parts.push(`necessidade: ${needTitle ?? `#${data.filters.needId}`}`);
  if (data.filters.eventType) parts.push(`tipo: ${EVENT_TYPE_LABELS[data.filters.eventType]}`);
  return parts.length > 0 ? parts.join(" · ") : "sem filtros adicionais";
}

export default function ImpactReportPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = Number(params.organizationId);

  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const [startDate, setStartDate] = useState(localISODate(firstOfMonth));
  const [endDate, setEndDate] = useState(localISODate(today));
  const [itemId, setItemId] = useState<string>("all");
  const [needId, setNeedId] = useState<string>("all");
  const [eventType, setEventType] = useState<string>("all");
  const [destBasis, setDestBasis] = useState<"registro" | "efetiva">("registro");
  const [destType, setDestType] = useState<string>("all");

  const orgsQuery = useQuery({ queryKey: ["organizations"], queryFn: () => getOrganizations() });
  const org = orgsQuery.data?.organizations.find((o) => o.id === organizationId);
  const canView = org && (org.myRole === "proprietario" || org.myRole === "administrador");

  const itemsQuery = useQuery({ queryKey: ["inventory-items", organizationId], queryFn: () => getInventoryItems({ organizationId }), enabled: Number.isFinite(organizationId) && !!canView });
  const needsQuery = useQuery({ queryKey: ["needs", organizationId], queryFn: () => getNeeds({ organizationId }), enabled: Number.isFinite(organizationId) && !!canView });

  const rangeOk = startDate !== "" && endDate !== "" && startDate <= endDate;

  const reportQuery = useQuery({
    queryKey: ["impact-report", organizationId, startDate, endDate, itemId, needId, eventType, destBasis, destType],
    queryFn: () =>
      getImpactReport({
        organizationId,
        ...reportRange(startDate, endDate),
        itemId: itemId === "all" ? undefined : Number(itemId),
        needId: needId === "all" ? undefined : Number(needId),
        eventType: eventType === "all" ? undefined : (eventType as ReportEventType),
        destinationDateBasis: destBasis,
        destinationType: destType === "all" ? undefined : (destType as DestinationType),
      }),
    enabled: Number.isFinite(organizationId) && !!canView && rangeOk,
  });

  const data = reportQuery.data;
  const itemName = useMemo(() => itemsQuery.data?.items.find((i) => String(i.id) === itemId)?.name ?? null, [itemsQuery.data, itemId]);
  const needTitle = useMemo(() => needsQuery.data?.needs.find((n) => String(n.id) === needId)?.title ?? null, [needsQuery.data, needId]);

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.backLink}>
        <ArrowLeft size={16} /> Voltar ao painel
      </Link>

      <nav className={styles.tabNav}>
        <Link to={`/organizacoes/${organizationId}`} className={styles.tabNavItem}>Visão geral</Link>
        <Link to={`/organizacoes/${organizationId}/jornada`} className={styles.tabNavItem}>Jornada</Link>
        <Link to={`/organizacoes/${organizationId}/inventario`} className={styles.tabNavItem}>Inventário</Link>
        <Link to={`/organizacoes/${organizationId}/destinacoes`} className={styles.tabNavItem}>Destinação</Link>
        <Link to={`/organizacoes/${organizationId}/necessidades`} className={styles.tabNavItem}>Necessidades</Link>
        <Link to={`/organizacoes/${organizationId}/oportunidades`} className={styles.tabNavItem}>Oportunidades</Link>
        <Link to={`/organizacoes/${organizationId}/atribuicoes`} className={styles.tabNavItem}>Rede Levora</Link>
        <ActiveTab className={styles.tabNavItemActive}>Prestação de contas</ActiveTab>
        <Link to={`/organizacoes/${organizationId}/matching`} className={styles.tabNavItem}>Configurações de Matching</Link>
        {(org?.myRole === "proprietario" || org?.myRole === "administrador") && (
          <Link to={`/organizacoes/${organizationId}/unidades`} className={styles.tabNavItem}>
            Unidades
          </Link>
        )}
        {(org?.myRole === "proprietario" || org?.myRole === "administrador" || org?.myRole === "operador") && (
          <Link to={`/organizacoes/${organizationId}/regularizacao`} className={styles.tabNavItem}>
            Pendências de unidade
          </Link>
        )}
      </nav>

      <div className={styles.titleRow}>
        <div>
          <h1 className={styles.title}><FileText size={20} /> Prestação de contas</h1>
          <p className={styles.subtitle}>
            Calculado ao vivo a partir do estoque, do histórico de atendimento das necessidades e da trilha de auditoria —
            nada é guardado à parte. O recebimento original nunca é substituído: correções e estornos aparecem como linhas próprias.
          </p>
        </div>
        {data && (
          <Button variant="outline" size="sm" onClick={() => window.print()} className={styles.noPrint}>
            <Printer size={14} /> Imprimir / salvar PDF
          </Button>
        )}
      </div>

      {org && !canView ? (
        <div className={styles.notAllowed}>
          <ShieldAlert size={28} />
          <p>Prestação de contas é visível só para proprietário e administrador desta organização.</p>
        </div>
      ) : (
        <>
          <div className={`${styles.filters} ${styles.noPrint}`}>
            <div className={styles.filterField}>
              <label className={styles.filterLabel}>De</label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} aria-label="Data inicial" />
            </div>
            <div className={styles.filterField}>
              <label className={styles.filterLabel}>Até (inclusive)</label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} aria-label="Data final" />
            </div>
            <div className={styles.filterField}>
              <label className={styles.filterLabel}>Item</label>
              <Select value={itemId} onValueChange={setItemId}>
                <SelectTrigger aria-label="Filtrar por item"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os itens</SelectItem>
                  {(itemsQuery.data?.items ?? []).map((i) => <SelectItem key={i.id} value={String(i.id)}>{i.name} ({i.unit})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className={styles.filterField}>
              <label className={styles.filterLabel}>Necessidade</label>
              <Select value={needId} onValueChange={setNeedId}>
                <SelectTrigger aria-label="Filtrar por necessidade"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas as necessidades</SelectItem>
                  {(needsQuery.data?.needs ?? []).map((n) => <SelectItem key={n.id} value={String(n.id)}>{n.title}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className={styles.filterField}>
              <label className={styles.filterLabel}>Tipo de evento</label>
              <Select value={eventType} onValueChange={setEventType}>
                <SelectTrigger aria-label="Filtrar por tipo de evento"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os tipos</SelectItem>
                  {(Object.keys(EVENT_TYPE_LABELS) as ReportEventType[]).map((t) => <SelectItem key={t} value={t}>{EVENT_TYPE_LABELS[t]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className={styles.filterField}>
              <label className={styles.filterLabel}>Destinação: data usada</label>
              <Select value={destBasis} onValueChange={(v) => setDestBasis(v as "registro" | "efetiva")}>
                <SelectTrigger aria-label="Data usada no bloco de destinação"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="registro">Data de registro</SelectItem>
                  <SelectItem value="efetiva">Data efetiva da entrega</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={styles.filterField}>
              <label className={styles.filterLabel}>Finalidade</label>
              <Select value={destType} onValueChange={setDestType}>
                <SelectTrigger aria-label="Filtrar por finalidade da destinação"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas as finalidades</SelectItem>
                  {DESTINATION_TYPES.map((t) => <SelectItem key={t} value={t}>{DESTINATION_LABELS[t].label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className={`${styles.scopeNote} ${styles.noPrint}`}>
            <strong>Escopo dos filtros.</strong> Período: eventos pela data em que ocorreram; saldos “no fim do período” e “hoje” aparecem separados.
            Item e necessidade valem para doações, histórico, necessidades e contagens; a movimentação por item só respeita o filtro de item;
            tipo de evento filtra as listas (os cartões mostram todos os tipos). Auditoria: contagem da organização inteira no período.
          </p>

          {!rangeOk ? (
            <p className={styles.emptyText}>A data inicial precisa ser anterior ou igual à final.</p>
          ) : reportQuery.isFetching && !data ? (
            <Skeleton className={styles.reportSkeleton} />
          ) : reportQuery.isError ? (
            <p className={styles.emptyText}>Não foi possível carregar a prestação de contas.</p>
          ) : data ? (
            <div className={styles.report}>
              <h2 className={styles.reportTitle}>{data.organizationName}</h2>
              <p className={styles.reportPeriod}>
                Período: {new Date(startDate + "T00:00:00").toLocaleDateString("pt-BR")} a {new Date(endDate + "T00:00:00").toLocaleDateString("pt-BR")} (inclusive)
              </p>
              <p className={styles.printOnly}>
                Filtros: {filtersSummary(data, itemName, needTitle)} · Gerado em {dateTime(data.generatedAt)}
              </p>

              <div className={styles.summaryGrid}>
                <div className={styles.summaryCard}>
                  <span className={styles.summaryValue}>{data.summary.needsCreated}</span>
                  <span className={styles.summaryLabel}>Necessidades cadastradas no período</span>
                </div>
                <div className={styles.summaryCard}>
                  <span className={styles.summaryValue}>{data.summary.needsMarkedAtendida}</span>
                  <span className={styles.summaryLabel}>Marcadas como atendidas no período</span>
                </div>
                <div className={styles.summaryCard}>
                  <span className={styles.summaryValue}>{data.summary.donations.total}</span>
                  <span className={styles.summaryLabel}>Doações recebidas</span>
                  <span className={styles.summarySub}>{data.summary.donations.network} da rede Levora · {data.summary.donations.manual} entradas manuais</span>
                </div>
                <div className={styles.summaryCard}>
                  <span className={styles.summaryValue}>{data.summary.corrections}</span>
                  <span className={styles.summaryLabel}>Correções de recebimento</span>
                  <span className={styles.summarySub}>não contam como doação</span>
                </div>
                <div className={styles.summaryCard}>
                  <span className={styles.summaryValue}>{data.summary.reversals.total}</span>
                  <span className={styles.summaryLabel}>Estornos</span>
                  <span className={styles.summarySub}>{data.summary.reversals.accountingOnly} só contábeis · {data.summary.reversals.withWithdrawal} com retirada física</span>
                </div>
                <div className={styles.summaryCard}>
                  <span className={styles.summaryValue}>{data.summary.auditEventCount}</span>
                  <span className={styles.summaryLabel}>Eventos na trilha de auditoria</span>
                </div>
              </div>

              <h3 className={styles.sectionTitle}>Movimentação de estoque por item</h3>
              {data.itemMovements.length === 0 ? (
                <p className={styles.emptyText}>Nenhuma movimentação e nenhum saldo de estoque neste período.</p>
              ) : (
                <>
                  <div className={`${styles.tableScroll} ${styles.desktopOnly}`}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>Item</th>
                          <th>Entradas</th>
                          <th>Saídas</th>
                          <th>Ajustes</th>
                          <th>Líquido no período</th>
                          <th>Saldo no início</th>
                          <th>Saldo no fim</th>
                          <th>Saldo hoje</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.itemMovements.map((m) => (
                          <tr key={m.itemId}>
                            <td>{m.itemName} ({m.unit})</td>
                            <td>{plus(m.entradas)}</td>
                            <td>{minus(m.saidas)}</td>
                            <td>
                              {signed(m.ajustes)}
                              {m.ajustesRede !== 0 && <div className={styles.cellSub}>da rede: {signed(m.ajustesRede)}</div>}
                            </td>
                            <td>{signed(m.netChange)}</td>
                            <td>{fmt(m.balanceAtStart)}</td>
                            <td>{fmt(m.balanceAtEnd)}</td>
                            <td>{fmt(m.currentStock)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <ul className={`${styles.cardList} ${styles.mobileOnly}`}>
                    {data.itemMovements.map((m) => (
                      <li key={m.itemId} className={styles.miniCard}>
                        <strong>{m.itemName} ({m.unit})</strong>
                        <div className={styles.kv}><span>Saldo no fim</span><strong>{fmt(m.balanceAtEnd)}</strong></div>
                        <div className={styles.kv}><span>Saldo hoje</span><strong>{fmt(m.currentStock)}</strong></div>
                        <div className={styles.kv}><span>Entradas</span><span>{plus(m.entradas)}</span></div>
                        <div className={styles.kv}><span>Saídas</span><span>{minus(m.saidas)}</span></div>
                        <div className={styles.kv}><span>Ajustes</span><span>{signed(m.ajustes)}{m.ajustesRede !== 0 ? ` (rede ${signed(m.ajustesRede)})` : ""}</span></div>
                        <div className={styles.kv}><span>Líquido no período</span><span>{signed(m.netChange)}</span></div>
                        <div className={styles.kv}><span>Saldo no início</span><span>{fmt(m.balanceAtStart)}</span></div>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <DestinationSection data={data} />

              <h3 className={styles.sectionTitle}>Atendimento das necessidades</h3>
              <p className={styles.sectionHint}>Acumulado até o fim do período, movimentação do período e visão de hoje. O status é a decisão registrada, não um cálculo.</p>
              {data.needs.rows.length === 0 ? (
                <p className={styles.emptyText}>Nenhuma necessidade com atendimento ou saldo neste período.</p>
              ) : (
                <>
                  <div className={`${styles.tableScroll} ${styles.desktopOnly}`}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>Necessidade</th>
                          <th>Necessário</th>
                          <th>Recebido</th>
                          <th>Correções</th>
                          <th>Estornos</th>
                          <th>Líquido no fim</th>
                          <th>Faltante</th>
                          <th>Excedente</th>
                          <th>No período</th>
                          <th>Hoje</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.needs.rows.map((n) => (
                          <tr key={n.id}>
                            <td>
                              {n.title} ({n.unit})
                              {n.itemName && <div className={styles.cellSub}>{n.itemName}</div>}
                            </td>
                            <td>{fmt(n.needed)}</td>
                            <td>{fmt(n.components.recebido)}</td>
                            <td>{signed(n.components.correcoes)}</td>
                            <td>{signed(n.components.estornos)}</td>
                            <td><strong>{fmt(n.atEnd.fulfilled)}</strong></td>
                            <td>{fmt(n.atEnd.requiredRemaining)}</td>
                            <td>{fmt(n.atEnd.surplus)}</td>
                            <td>{signed(n.periodNet)}</td>
                            <td>
                              {fmt(n.today.fulfilled)}
                              <div className={styles.cellSub}>falta {fmt(n.today.requiredRemaining)}</div>
                              <div className={styles.cellSub}>{n.historicalAttended ? "atendimento histórico sem destinação estruturada" : `atendido (destinações): ${fmt(n.attendance.attended)} de ${fmt(n.attendance.requested)}`}</div>
                            </td>
                            <td className={styles.statusCell}>
                              <Badge variant={n.status === "atendida" ? "success" : n.status === "cancelada" ? "destructive" : "outline"}>{STATUS_LABELS[n.status] ?? n.status}</Badge>
                              {n.statusWarning && (
                                <div className={styles.statusWarning}><TriangleAlert size={12} aria-hidden /> Marcada como atendida, mas há saldo faltante após ajustes.</div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <ul className={`${styles.cardList} ${styles.mobileOnly}`}>
                    {data.needs.rows.map((n) => (
                      <li key={n.id} className={styles.miniCard}>
                        <div className={styles.cardTop}>
                          <strong>{n.title} ({n.unit})</strong>
                          <Badge variant={n.status === "atendida" ? "success" : n.status === "cancelada" ? "destructive" : "outline"}>{STATUS_LABELS[n.status] ?? n.status}</Badge>
                        </div>
                        {n.statusWarning && (
                          <div className={styles.statusWarning}><TriangleAlert size={12} aria-hidden /> Marcada como atendida, mas há saldo faltante após ajustes.</div>
                        )}
                        <div className={styles.kv}><span>Faltante</span><strong>{fmt(n.atEnd.requiredRemaining)}</strong></div>
                        <div className={styles.kv}><span>Excedente</span><strong>{fmt(n.atEnd.surplus)}</strong></div>
                        <div className={styles.kv}><span>Líquido no fim</span><strong>{fmt(n.atEnd.fulfilled)}</strong></div>
                        <div className={styles.kv}><span>Recebido</span><span>{fmt(n.components.recebido)}</span></div>
                        <div className={styles.kv}><span>Correções</span><span>{signed(n.components.correcoes)}</span></div>
                        <div className={styles.kv}><span>Estornos</span><span>{signed(n.components.estornos)}</span></div>
                        <div className={styles.kv}><span>Necessário</span><span>{fmt(n.needed)}</span></div>
                        <div className={styles.kv}><span>No período</span><span>{signed(n.periodNet)}</span></div>
                        <div className={styles.kv}><span>Hoje</span><span>{fmt(n.today.fulfilled)} (falta {fmt(n.today.requiredRemaining)})</span></div>
                        <div className={styles.kv}><span>Atendido (destinações)</span><span>{n.historicalAttended ? "histórico, sem destinação estruturada" : `${fmt(n.attendance.attended)} de ${fmt(n.attendance.requested)}`}</span></div>
                      </li>
                    ))}
                  </ul>
                  {data.needs.truncated && <p className={styles.truncNotice} role="status">Exibindo as primeiras {data.needs.limit} necessidades; refine por item ou necessidade.</p>}
                </>
              )}

              <h3 className={styles.sectionTitle}>Doações recebidas no período</h3>
              <p className={styles.sectionHint}>Cada entrada de estoque conta uma vez. Correções e estornos não são doações — estão no histórico abaixo.</p>
              {data.donations.rows.length === 0 ? (
                <p className={styles.emptyText}>Nenhum recebimento neste período.</p>
              ) : (
                <>
                  <ul className={styles.receivedList}>
                    {data.donations.rows.map((d) => (
                      <li key={d.id} className={styles.receivedRow}>
                        <div className={styles.cardTop}>
                          <strong>+{fmt(d.quantity)} {d.unit} de {d.itemName}</strong>
                          <Badge variant={d.origin === "rede" ? "success" : "outline"}>{d.origin === "rede" ? "Rede Levora" : "Entrada manual"}</Badge>
                        </div>
                        <div className={styles.eventMeta}>
                          {dateTime(d.createdAt)}
                          {d.opportunityTitle ? ` · ${d.opportunityTitle}` : d.reason ? ` · ${d.reason}` : ""}
                          {d.needTitle ? ` · necessidade “${d.needTitle}”` : ""}
                        </div>
                      </li>
                    ))}
                  </ul>
                  {data.donations.truncated && (
                    <p className={styles.truncNotice} role="status">Exibindo os {data.donations.limit} eventos mais recentes do período ({data.donations.total} no total; os totais acima contam todos).</p>
                  )}
                </>
              )}

              <h3 className={styles.sectionTitle}>Histórico dos recebimentos: correções e estornos</h3>
              <p className={styles.sectionHint}>O recebimento original continua visível; o líquido aparece ao lado, nunca no lugar.</p>
              {data.receipts.groups.length === 0 ? (
                <p className={styles.emptyText}>Nenhuma correção ou estorno neste período.</p>
              ) : (
                <>
                  <ul className={styles.groupList}>
                    {data.receipts.groups.map((g) => <ReceiptGroupView key={g.allocationId} g={g} />)}
                  </ul>
                  {data.receipts.truncated && (
                    <p className={styles.truncNotice} role="status">Exibindo os {data.receipts.limit} eventos mais recentes do período ({data.receipts.totalEvents} no total; os totais acima contam todos).</p>
                  )}
                </>
              )}

              <p className={styles.disclaimer}>
                Este relatório mostra quantidades e unidades, não valores monetários — o cadastro de itens não tem preço associado.
                O líquido do atendimento (recebido + correções + estornos) é um número contábil; o saldo de estoque é físico: um estorno só
                contábil muda o primeiro e não o segundo, de propósito. “Marcadas como atendidas no período” usa a data da última alteração
                da necessidade como aproximação.
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
