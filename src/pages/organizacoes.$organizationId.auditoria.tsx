import React from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { getOrganizations } from "../endpoints/organizations_GET.schema";
import { ActiveTab } from "../components/ActiveTab";
import { Skeleton } from "../components/Skeleton";
import { AuditCenterPanel, AuditEntryDialog, EMPTY_FILTERS, type AuditFilterState } from "../components/AuditCenterPanel";
import { AuditTracePanel, type TraceStart } from "../components/AuditTracePanel";
import { AuditIntegrityPanel } from "../components/AuditIntegrityPanel";
import styles from "./organizacoes.$organizationId.automacao.module.css";

const SECTIONS = [
  { value: "registros", label: "Registros" },
  { value: "rastreabilidade", label: "Rastreabilidade" },
  { value: "integridade", label: "Integridade" },
] as const;
type Section = (typeof SECTIONS)[number]["value"];

const FILTER_KEYS: Array<[keyof AuditFilterState, string]> = [["from", "de"], ["to", "ate"], ["area", "area"], ["action", "acao"], ["actorType", "autor"], ["resultado", "resultado"], ["correlationId", "correlacao"], ["entityType", "recurso"], ["entityId", "recursoId"]];

/**
 * Central de Auditoria (M38). Restrita a quem tem `auditoria.leia` (proprietário e administrador); o servidor revalida em cada chamada e filtra tudo pela organização da URL.
 * O estado (aba, filtros, registro aberto, ponto de partida da rastreabilidade) vive na URL: o botão voltar do navegador devolve ao ponto anterior com os mesmos filtros.
 */
export default function OrganizationAuditPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = Number(params.organizationId);
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();

  const section: Section = SECTIONS.find((s) => s.value === search.get("aba"))?.value ?? "registros";
  const entryId = search.get("registro") && /^[0-9]{1,18}$/.test(search.get("registro")!) ? search.get("registro") : null;

  const filters: AuditFilterState = React.useMemo(() => {
    const f: AuditFilterState = { ...EMPTY_FILTERS };
    for (const [key, param] of FILTER_KEYS) (f as unknown as Record<string, string>)[key] = search.get(param) ?? "";
    return f;
  }, [search]);

  const start: TraceStart | null = React.useMemo(() => {
    const o = search.get("oportunidade"); const r = search.get("execucao"); const x = search.get("excecao"); const c = search.get("correlacao_trace");
    if (o && /^[0-9]{1,12}$/.test(o)) return { kind: "oportunidade", id: o };
    if (r && /^[0-9]{1,18}$/.test(r)) return { kind: "execucao", id: r };
    if (x && /^[0-9]{1,18}$/.test(x)) return { kind: "excecao", id: x };
    if (c && /^[0-9a-fA-F-]{36}$/.test(c)) return { kind: "correlacao", id: c };
    return null;
  }, [search]);

  const update = (mutate: (next: URLSearchParams) => void, replace = false) => setSearch((prev) => { const next = new URLSearchParams(prev); mutate(next); return next; }, { replace });
  const setSection = (value: Section) => update((n) => { if (value === "registros") n.delete("aba"); else n.set("aba", value); });
  const setFilters = (f: AuditFilterState) => update((n) => {
    for (const [key, param] of FILTER_KEYS) { const v = f[key] as string; if (v) n.set(param, v); else n.delete(param); }
    n.delete("aba"); // filtros pertencem à aba Registros (a padrão)
  });
  // Foco: guarda o botão que abriu o diálogo (e seu rótulo) para devolvê-lo ao fechar, mesmo que a lista tenha sido redesenhada.
  const trigger = React.useRef<{ el: HTMLElement; label: string | null } | null>(null);
  const restoreFocus = (): HTMLElement | null => {
    const t = trigger.current; if (!t) return null;
    if (t.el.isConnected) return t.el;
    return t.label ? document.querySelector<HTMLElement>(`[aria-label="${CSS.escape(t.label)}"]`) : null;
  };
  const setEntry = (id: string | null) => {
    const active = document.activeElement as HTMLElement | null;
    if (id && active && active !== document.body) trigger.current = { el: active, label: active.getAttribute("aria-label") };
    update((n) => { if (id) n.set("registro", id); else n.delete("registro"); });
  };
  const setStart = (s: TraceStart | null) => update((n) => {
    for (const k of ["oportunidade", "execucao", "excecao", "correlacao_trace"]) n.delete(k);
    if (s) n.set(s.kind === "correlacao" ? "correlacao_trace" : s.kind, s.id);
    n.set("aba", "rastreabilidade");
  });

  const orgsQuery = useQuery({ queryKey: ["organizations"], queryFn: () => getOrganizations() });
  const org = orgsQuery.data?.organizations.find((o) => o.id === organizationId);
  const canRead = !!org && (org.myRole === "proprietario" || org.myRole === "administrador");
  const auditOrgs = (orgsQuery.data?.organizations ?? []).filter((o) => o.myRole === "proprietario" || o.myRole === "administrador");

  const go = (href: string) => navigate(href);

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
        {canRead && <Link to={`/organizacoes/${organizationId}/automacao`} className={styles.tabNavItem}>Automação</Link>}
        {canRead && <ActiveTab className={styles.tabNavItemActive} aria-current="page">Auditoria</ActiveTab>}
      </nav>

      <h1 className={styles.title}>Central de Auditoria</h1>
      <p className={styles.subtitle}>
        Acompanhe o que aconteceu nesta organização, quem fez, que decisões os agentes registraram e o que mudou depois — e confira a integridade da trilha. Esta área é restrita a proprietários e administradores.
        {org ? ` Organização: ${org.name}.` : ""}
      </p>
      {auditOrgs.length > 1 && (
        <label style={{ display: "inline-flex", gap: "0.5rem", alignItems: "center", fontSize: "0.875rem", marginBottom: "0.5rem" }}>
          <span>Organização</span>
          <select value={organizationId} onChange={(e) => navigate(`/organizacoes/${e.target.value}/auditoria${section === "registros" ? "" : `?aba=${section}`}`)} style={{ font: "inherit", minHeight: "2.5rem", padding: "0 0.5rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--background)", color: "var(--foreground)" }}>
            {auditOrgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
      )}

      {orgsQuery.isLoading ? (
        <Skeleton className={styles.skeleton} />
      ) : !org || !canRead ? (
        <p className={styles.denied} role="alert">Esta área é restrita a proprietários e administradores da organização. Se você deveria ter acesso, peça a um proprietário para ajustar o seu papel.</p>
      ) : (
        <>
          <nav className={styles.sections} aria-label="Seções da auditoria">
            {SECTIONS.map((s) => (
              <button key={s.value} type="button" className={`${styles.sectionTab} ${section === s.value ? styles.sectionTabActive : ""}`} aria-current={section === s.value ? "page" : undefined} onClick={() => setSection(s.value)}>{s.label}</button>
            ))}
          </nav>
          <div className={styles.stack}>
            {section === "registros" && <AuditCenterPanel organizationId={organizationId} filters={filters} onFiltersChange={setFilters} onOpenTrace={go} canSeeAutomation={canRead} onEntryChange={setEntry} />}
            {section === "rastreabilidade" && <AuditTracePanel organizationId={organizationId} start={start} onStartChange={setStart} onOpenEntry={(id) => setEntry(id)} onNavigate={go} />}
            {section === "integridade" && <AuditIntegrityPanel organizationId={organizationId} onOpenEntry={(id) => setEntry(id)} />}
          </div>
          <AuditEntryDialog
            organizationId={organizationId}
            entryId={entryId}
            onClose={() => setEntry(null)}
            onFilterCorrelation={(c) => update((n) => { n.delete("registro"); n.delete("aba"); n.set("correlacao", c); })}
            onOpenTrace={go}
            onNavigate={go}
            restoreFocus={restoreFocus}
          />
        </>
      )}
    </div>
  );
}
