import React from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { getOrganizations } from "../endpoints/organizations_GET.schema";
import { ActiveTab } from "../components/ActiveTab";
import { Skeleton } from "../components/Skeleton";
import { AgentOverviewPanel } from "../components/AgentOverviewPanel";
import { AgentEventsPanel } from "../components/AgentEventsPanel";
import { RetentionPanel } from "../components/RetentionPanel";
import { AgentExceptionsPanel } from "../components/AgentExceptionsPanel";
import { AgentAlertsPanel } from "../components/AgentAlertsPanel";
import { AutomationControlsPanel } from "../components/AutomationControlsPanel";
import { PolicyLimitsPanel } from "../components/PolicyLimitsPanel";
import styles from "./organizacoes.$organizationId.automacao.module.css";

const SECTIONS = [
  { value: "visao", label: "Visão geral" },
  { value: "excecoes", label: "Exceções" },
  { value: "alertas", label: "Alertas" },
  { value: "controles", label: "Controles e limites" },
] as const;
type Section = (typeof SECTIONS)[number]["value"];

/**
 * M33 — operação da plataforma de agentes de UMA organização: visão geral dos agentes, fila de exceções, alertas de integridade, pausa/emergência e limites de autonomia. Restrito a proprietário e
 * administrador (permissões `automacao.leia`/`automacao.gerencie`). A tela nunca é a autoridade: o servidor recusa quem não tem a permissão e valida cada ação.
 */
export default function OrganizationAutomationPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = Number(params.organizationId);
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const initialRun = search.get("run");
  const section: Section = SECTIONS.find((s) => s.value === search.get("aba"))?.value ?? "visao";
  const setSection = (value: Section) =>
    setSearch((prev) => { const next = new URLSearchParams(prev); if (value === "visao") next.delete("aba"); else next.set("aba", value); return next; }, { replace: true });

  const orgsQuery = useQuery({ queryKey: ["organizations"], queryFn: () => getOrganizations() });
  const org = orgsQuery.data?.organizations.find((o) => o.id === organizationId);
  const canManage = !!org && (org.myRole === "proprietario" || org.myRole === "administrador");

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.backLink}><ArrowLeft size={16} aria-hidden="true" /> Voltar ao painel</Link>

      <nav className={styles.tabNav} aria-label="Áreas da organização">
        <Link to={`/organizacoes/${organizationId}`} className={styles.tabNavItem}>Visão geral</Link>
        <Link to={`/organizacoes/${organizationId}/inventario`} className={styles.tabNavItem}>Inventário</Link>
        <Link to={`/organizacoes/${organizationId}/destinacoes`} className={styles.tabNavItem}>Destinação</Link>
        <Link to={`/organizacoes/${organizationId}/necessidades`} className={styles.tabNavItem}>Necessidades</Link>
        <Link to={`/organizacoes/${organizationId}/oportunidades`} className={styles.tabNavItem}>Oportunidades</Link>
        <Link to={`/organizacoes/${organizationId}/prestacao-contas`} className={styles.tabNavItem}>Prestação de contas</Link>
        {canManage && <ActiveTab className={styles.tabNavItemActive} aria-current="page">Automação</ActiveTab>}
        {canManage && <Link to={`/organizacoes/${organizationId}/auditoria`} className={styles.tabNavItem}>Auditoria</Link>}
      </nav>

      <h1 className={styles.title}>Automação e agentes</h1>
      <p className={styles.subtitle}>
        Acompanhe os agentes da organização, decida as exceções que as regras de proteção interromperam, trate os alertas de integridade e controle quando a automação pode agir. Esta área é restrita a proprietários e administradores.
      </p>

      {orgsQuery.isLoading ? (
        <Skeleton className={styles.skeleton} />
      ) : !org || !canManage ? (
        <p className={styles.denied} role="alert">Esta área é restrita a proprietários e administradores da organização. Se você deveria ter acesso, peça a um proprietário para ajustar o seu papel.</p>
      ) : (
        <>
          <nav className={styles.sections} aria-label="Seções de automação">
            {SECTIONS.map((s) => (
              <button key={s.value} type="button" className={`${styles.sectionTab} ${section === s.value ? styles.sectionTabActive : ""}`} aria-current={section === s.value ? "page" : undefined} onClick={() => setSection(s.value)}>{s.label}</button>
            ))}
          </nav>
          <div className={styles.stack}>
            {section === "visao" && (
              <>
                <AgentOverviewPanel organizationId={organizationId} onOpenTab={(tab) => setSection(tab)} canManage={canManage} />
                <AgentEventsPanel organizationId={organizationId} canManage={canManage} onOpenExceptions={() => setSection("excecoes")} initialRunId={initialRun && /^[0-9]{1,18}$/.test(initialRun) ? initialRun : null} opportunityHref={(id) => `/organizacoes/${organizationId}/oportunidades?destaque=${id}`} onOpenOpportunity={(id) => navigate(`/organizacoes/${organizationId}/oportunidades?destaque=${id}`)} onOpenTrace={(runId) => navigate(`/organizacoes/${organizationId}/auditoria?aba=rastreabilidade&execucao=${runId}`)} />
              </>
            )}
            {section === "excecoes" && <AgentExceptionsPanel organizationId={organizationId} canDecide={canManage} />}
            {section === "alertas" && <AgentAlertsPanel organizationId={organizationId} canManage={canManage} />}
            {section === "controles" && (
              <>
                <AutomationControlsPanel scope="organizacao" organizationId={organizationId} canManage={canManage} />
                <PolicyLimitsPanel organizationId={organizationId} canManage={canManage} />
                <RetentionPanel organizationId={organizationId} />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
