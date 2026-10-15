import React from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { getOrganizations } from "../endpoints/organizations_GET.schema";
import { getInventoryItems } from "../endpoints/inventory-items_GET.schema";
import { getNeeds } from "../endpoints/needs_GET.schema";
import { getProofReconciliation } from "../endpoints/destination-proofs-reconciliation_GET.schema";
import { DestinationHistory, type HistoryFilters } from "../components/DestinationHistory";
import { Input } from "../components/Input";
import { Button } from "../components/Button";
import inputStyles from "../components/Input.module.css";
import { DESTINATION_LABELS, DESTINATION_TYPES, type DestinationType } from "../helpers/destinationRules";
import { DESTINATION_DATE_BASES, DESTINATION_STATES, validateDateRange } from "../helpers/destinationFilters";
import styles from "./organizacoes.$organizationId.destinacoes.module.css";

const STATE_LABELS: Record<string, string> = { ativa: "Ativa (sem reversão)", parcialmente_revertida: "Parcialmente revertida", revertida: "Revertida", com_correcao: "Com correção documental" };

/**
 * Fase 99I — aba "Destinação": histórico das destinações com filtros (período por data de REGISTRO ou EFETIVA, finalidade, situação, item). Os filtros vivem na URL (sobrevivem a recarregar e a
 * navegar). O servidor é a autoridade: valida o intervalo, aplica os filtros e calcula os totais por unidade. Exportação não faz parte desta fase.
 */
export default function DestinationsPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = Number(params.organizationId);
  const [sp, setSp] = useSearchParams();
  const get = (k: string) => sp.get(k) ?? "";
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(sp);
    if (v === "") next.delete(k);
    else next.set(k, v);
    setSp(next, { replace: true });
  };

  const orgsQuery = useQuery({ queryKey: ["organizations"], queryFn: () => getOrganizations() });
  const org = orgsQuery.data?.organizations.find((o) => o.id === organizationId);
  const canView = !!org && ["proprietario", "administrador", "operador"].includes(org.myRole);
  const itemsQuery = useQuery({ queryKey: ["inventory-items", organizationId], queryFn: () => getInventoryItems({ organizationId }), enabled: Number.isFinite(organizationId) && canView });

  const needsQuery = useQuery({ queryKey: ["needs", organizationId], queryFn: () => getNeeds({ organizationId }), enabled: Number.isFinite(organizationId) && canView });

  const canManage = !!org && ["proprietario", "administrador"].includes(org.myRole);
  const reconQuery = useQuery({ queryKey: ["destination-proofs-reconciliation", organizationId], queryFn: () => getProofReconciliation(organizationId), enabled: Number.isFinite(organizationId) && canManage });

  const from = get("from");
  const to = get("to");
  const rangeError = validateDateRange(from || null, to || null);
  const basis = (DESTINATION_DATE_BASES as readonly string[]).includes(get("basis")) ? (get("basis") as "registro" | "efetiva") : "registro";
  const filters: HistoryFilters = {
    basis,
    from: from || undefined,
    to: to || undefined,
    destinationType: (DESTINATION_TYPES as readonly string[]).includes(get("type")) ? (get("type") as DestinationType) : undefined,
    state: (DESTINATION_STATES as readonly string[]).includes(get("state")) ? (get("state") as HistoryFilters["state"]) : undefined,
    itemId: get("item") && Number(get("item")) > 0 ? Number(get("item")) : undefined,
    needId: get("need") && Number(get("need")) > 0 ? Number(get("need")) : undefined,
  };
  const hasFilters = ["from", "to", "type", "state", "item", "need", "basis"].some((k) => get(k) !== "");

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.backLink}>
        <ArrowLeft size={16} /> Voltar ao painel
      </Link>
      <nav className={styles.tabNav}>
        <Link to={`/organizacoes/${organizationId}`} className={styles.tabNavItem}>Visão geral</Link>
        <Link to={`/organizacoes/${organizationId}/inventario`} className={styles.tabNavItem}>Inventário</Link>
        <span className={styles.tabNavItemActive}>Destinação</span>
        <Link to={`/organizacoes/${organizationId}/necessidades`} className={styles.tabNavItem}>Necessidades</Link>
        <Link to={`/organizacoes/${organizationId}/prestacao-contas`} className={styles.tabNavItem}>Prestação de contas</Link>
      </nav>
      <div>
        <h1 className={styles.title}>Destinação</h1>
        <p className={styles.subtitle}>
          Histórico das saídas com finalidade registrada. Nada é apagado: correções e reversões são novos registros ligados à destinação original. Registros anteriores ao controle de destinação
          não aparecem aqui — veja “Saídas sem destinação estruturada” na prestação de contas.
        </p>
      </div>

      {org && !canView ? (
        <div className={styles.notAllowed}>
          <ShieldAlert size={28} />
          <p>O histórico de destinações é visível para proprietário, administrador e operador.</p>
        </div>
      ) : (
        <>
          <form className={styles.filters} onSubmit={(e) => e.preventDefault()} aria-label="Filtros do histórico de destinações">
            <div className={styles.field}>
              <label className={styles.label} htmlFor="f-basis">Data usada no período</label>
              <select id="f-basis" className={`${inputStyles.input} ${styles.select}`} value={basis} onChange={(e) => set("basis", e.target.value === "registro" ? "" : e.target.value)}>
                <option value="registro">Data de registro</option>
                <option value="efetiva">Data efetiva da entrega</option>
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="f-from">De (inclusive)</label>
              <Input id="f-from" type="date" value={from} onChange={(e) => set("from", e.target.value)} aria-invalid={!!rangeError} />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="f-to">Até (inclusive)</label>
              <Input id="f-to" type="date" value={to} onChange={(e) => set("to", e.target.value)} aria-invalid={!!rangeError} />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="f-type">Finalidade</label>
              <select id="f-type" className={`${inputStyles.input} ${styles.select}`} value={get("type")} onChange={(e) => set("type", e.target.value)}>
                <option value="">Todas as finalidades</option>
                {DESTINATION_TYPES.map((t) => <option key={t} value={t}>{DESTINATION_LABELS[t].label}</option>)}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="f-state">Situação</label>
              <select id="f-state" className={`${inputStyles.input} ${styles.select}`} value={get("state")} onChange={(e) => set("state", e.target.value)}>
                <option value="">Todas as situações</option>
                {DESTINATION_STATES.map((s) => <option key={s} value={s}>{STATE_LABELS[s]}</option>)}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="f-item">Item</label>
              <select id="f-item" className={`${inputStyles.input} ${styles.select}`} value={get("item")} onChange={(e) => set("item", e.target.value)}>
                <option value="">Todos os itens</option>
                {(itemsQuery.data?.items ?? []).map((i) => <option key={i.id} value={String(i.id)}>{i.name} ({i.unit})</option>)}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="f-need">Necessidade</label>
              <select id="f-need" className={`${inputStyles.input} ${styles.select}`} value={get("need")} onChange={(e) => set("need", e.target.value)}>
                <option value="">Todas as necessidades</option>
                {(needsQuery.data?.needs ?? []).map((n) => <option key={n.id} value={String(n.id)}>{n.title}</option>)}
              </select>
            </div>
            <div className={styles.field}>
              <Button type="button" variant="outline" disabled={!hasFilters} onClick={() => setSp(new URLSearchParams(), { replace: true })}>Limpar filtros</Button>
            </div>
          </form>
          <p className={styles.note}>
            Período no calendário de Brasília, com os dois limites incluídos. “Data de registro” é quando o sistema gravou; “data efetiva” é a da entrega, já com as correções documentais.
            Os totais cobrem todo o conjunto filtrado (não só a página), separados por unidade; “revertido” é o acumulado até hoje.
          </p>
          {rangeError ? (
            <p className={styles.error} role="alert">{rangeError}. Ajuste as datas para consultar.</p>
          ) : (
            <DestinationHistory organizationId={organizationId} filters={filters} initialLimit={20} showTotals />
          )}
          {canManage && reconQuery.data && (reconQuery.data.pendentes.length > 0 || reconQuery.data.removidos.length > 0 || reconQuery.data.retidosPorAnalise.length > 0) && (
            <section className={styles.recon} data-testid="proof-reconciliation" aria-label="Comprovantes sem vínculo vigente">
              <p className={styles.note}>
                <strong>Comprovantes enviados e não vinculados:</strong> {reconQuery.data.pendentes.length} · <strong>com referência removida:</strong> {reconQuery.data.removidos.length} · <strong>retidos pela análise de segurança:</strong> {reconQuery.data.retidosPorAnalise.length}. Somente leitura: nada é apagado
                automaticamente (não há política de retenção aprovada). Um arquivo pendente pode ser vinculado por quem o enviou ou por proprietário/administrador.
              </p>
              <ul className={styles.reconList}>
                {reconQuery.data.pendentes.map((f) => <li key={`p-${f.id}`}>Pendente: {f.name} · enviado por {f.uploadedByDisplayName} há {f.ageHours} h</li>)}
                {reconQuery.data.retidosPorAnalise.map((f) => <li key={`a-${f.id}`}>Retido pela análise ({f.scanStatus === "infectado" ? "bloqueado por segurança" : f.scanStatus === "indisponivel" ? "análise indisponível" : f.scanStatus === "legado_nao_analisado" ? "anterior à análise" : "aguardando análise"}): {f.name} · enviado por {f.uploadedByDisplayName}</li>)}
                {reconQuery.data.removidos.map((f) => <li key={`r-${f.id}`}>Referência removida: {f.name} · enviado por {f.uploadedByDisplayName}</li>)}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
