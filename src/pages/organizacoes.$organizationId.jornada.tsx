import React, { useCallback } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { getOrganizations } from "../endpoints/organizations_GET.schema";
import { ActiveTab } from "../components/ActiveTab";
import { Skeleton } from "../components/Skeleton";
import { JourneyDetailView, JourneyList, OfferJourneyDetailView, type JourneyFiltersState } from "../components/JourneyPanels";
import { offerParam, parseOfferParam } from "../components/journeyView";
import styles from "./organizacoes.$organizationId.automacao.module.css";

/**
 * Jornada (M40): uma visão contínua, por necessidade, do que os módulos já persistem — correspondência, atribuição, recebimento, destinação, atendimento e prestação de contas —
 * com ligação contextual para cada módulo e para a Central de Auditoria. Leitura para qualquer membro com `necessidades.leia`; o servidor decide quais seções cada papel enxerga.
 * O estado (necessidade aberta) vive na URL: o botão voltar do navegador devolve à lista.
 */
export default function OrganizationJourneyPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = Number(params.organizationId);
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const needParam = search.get("necessidade");
  const needId = needParam && /^[0-9]{1,12}$/.test(needParam) ? Number(needParam) : null;
  const offer = parseOfferParam(search.get("oferta"));
  // M41 — filtros da lista vivem na URL (busca, tipo, vínculo, situação): o botão voltar e o link do detalhe os preservam.
  const filters: JourneyFiltersState = { q: (search.get("q") ?? "").slice(0, 80), tipo: search.get("tipo") ?? "", vinculo: search.get("vinculo") ?? "", status: search.get("situacao") ?? "" };
  const filterQuery = (f: JourneyFiltersState) => { const p = new URLSearchParams(); if (f.q) p.set("q", f.q); if (f.tipo) p.set("tipo", f.tipo); if (f.vinculo) p.set("vinculo", f.vinculo); if (f.status) p.set("situacao", f.status); return p; };
  const onFiltersChange = useCallback((f: JourneyFiltersState) => setSearch(filterQuery(f), { replace: true }), [setSearch]);
  const backHref = `/organizacoes/${organizationId}/jornada${filterQuery(filters).toString() ? `?${filterQuery(filters).toString()}` : ""}`;

  const orgsQuery = useQuery({ queryKey: ["organizations"], queryFn: () => getOrganizations() });
  const org = orgsQuery.data?.organizations.find((o) => o.id === organizationId);
  const canSeeAutomation = !!org && (org.myRole === "proprietario" || org.myRole === "administrador");

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.backLink}><ArrowLeft size={16} aria-hidden="true" /> Voltar ao painel</Link>

      <nav className={styles.tabNav} aria-label="Áreas da organização">
        <Link to={`/organizacoes/${organizationId}`} className={styles.tabNavItem}>Visão geral</Link>
        <ActiveTab className={styles.tabNavItemActive} aria-current="page">Jornada</ActiveTab>
        <Link to={`/organizacoes/${organizationId}/inventario`} className={styles.tabNavItem}>Inventário</Link>
        <Link to={`/organizacoes/${organizationId}/destinacoes`} className={styles.tabNavItem}>Destinação</Link>
        <Link to={`/organizacoes/${organizationId}/necessidades`} className={styles.tabNavItem}>Necessidades</Link>
        <Link to={`/organizacoes/${organizationId}/oportunidades`} className={styles.tabNavItem}>Oportunidades</Link>
        <Link to={`/organizacoes/${organizationId}/atribuicoes`} className={styles.tabNavItem}>Atribuições</Link>
        <Link to={`/organizacoes/${organizationId}/prestacao-contas`} className={styles.tabNavItem}>Prestação de contas</Link>
        {canSeeAutomation && <Link to={`/organizacoes/${organizationId}/automacao`} className={styles.tabNavItem}>Automação</Link>}
        {canSeeAutomation && <Link to={`/organizacoes/${organizationId}/auditoria`} className={styles.tabNavItem}>Auditoria</Link>}
      </nav>

      <h1 className={styles.title}>Jornada das necessidades e ofertas</h1>
      <p className={styles.subtitle}>
        Acompanhe, do cadastro da necessidade (ou da oferta) ao atendimento final, o que a rede e a organização já registraram: correspondência, atribuição, recebimento, destinação e comprovantes.
        {org ? ` Organização: ${org.name}.` : ""}
      </p>

      {orgsQuery.isLoading ? (
        <Skeleton className={styles.skeleton} />
      ) : !org ? (
        <p className={styles.denied} role="alert">Você não tem acesso a esta organização.</p>
      ) : needId !== null ? (
        <JourneyDetailView organizationId={organizationId} needId={needId} onBack={() => navigate(backHref)} />
      ) : offer ? (
        <OfferJourneyDetailView organizationId={organizationId} kind={offer.kind} id={offer.id} onBack={() => navigate(backHref)} />
      ) : (
        <JourneyList organizationId={organizationId} filters={filters} onFiltersChange={onFiltersChange}
          buildDetailHref={(e) => { const p = filterQuery(filters); if (e.kind === "necessidade") p.set("necessidade", String(e.needId)); else p.set("oferta", offerParam(e.kind, e.id)); return `/organizacoes/${organizationId}/jornada?${p.toString()}`; }} />
      )}
    </div>
  );
}
