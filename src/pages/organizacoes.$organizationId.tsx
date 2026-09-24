import React from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getOrganizations } from "../endpoints/organizations_GET.schema";
import { getOrganizationMembers } from "../endpoints/organization-members_GET.schema";
import { getAuditLog } from "../endpoints/audit-log_GET.schema";
import { Badge } from "../components/Badge";
import { Skeleton } from "../components/Skeleton";
import { ArrowLeft, ShieldAlert, Users, ScrollText } from "lucide-react";
import styles from "./organizacoes.$organizationId.module.css";

const membershipRoleLabels: Record<string, string> = {
  proprietario: "Proprietário",
  administrador: "Administrador",
  operador: "Operador",
  voluntario: "Voluntário",
};

const membershipStatusLabels: Record<string, string> = {
  ativo: "Ativo",
  convidado: "Convidado",
  inativo: "Inativo",
};

export default function OrganizationDetailPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = Number(params.organizationId);
  const navigate = useNavigate();

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => getOrganizations(),
  });
  const org = orgsQuery.data?.organizations.find((o) => o.id === organizationId);

  const membersQuery = useQuery({
    queryKey: ["organization-members", organizationId],
    queryFn: () => getOrganizationMembers({ organizationId }),
    enabled: Number.isFinite(organizationId),
  });

  const canSeeAuditLog = org?.myRole === "proprietario" || org?.myRole === "administrador";

  const auditLogQuery = useQuery({
    queryKey: ["audit-log", organizationId],
    queryFn: () => getAuditLog({ organizationId }),
    enabled: Number.isFinite(organizationId) && canSeeAuditLog,
  });

  if (orgsQuery.isFetching && !orgsQuery.data) {
    return (
      <div className={styles.page}>
        <Skeleton className={styles.headerSkeleton} />
        <Skeleton className={styles.bodySkeleton} />
      </div>
    );
  }

  if (orgsQuery.data && !org) {
    return (
      <div className={styles.page}>
        <div className={styles.notMember}>
          <ShieldAlert size={32} />
          <p>Você não é membro desta organização ou ela não existe.</p>
          <button className={styles.backLink} onClick={() => navigate("/")}>
            Voltar ao painel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.backLink}>
        <ArrowLeft size={16} /> Voltar
      </Link>

      {org && (
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>{org.name}</h1>
            <p className={styles.subtitle}>
              {org.city}/{org.state} · Seu papel: {membershipRoleLabels[org.myRole]}
            </p>
          </div>
          <Badge variant={org.status === "ativa" ? "success" : org.status === "suspensa" ? "destructive" : "secondary"}>
            {org.status === "ativa" ? "Ativa" : org.status === "suspensa" ? "Suspensa" : "Em análise"}
          </Badge>
        </header>
      )}

      <nav className={styles.tabNav}>
        <span className={styles.tabNavItemActive}>Visão geral</span>
        <Link to={`/organizacoes/${organizationId}/inventario`} className={styles.tabNavItem}>
          Inventário
        </Link>
        <Link to={`/organizacoes/${organizationId}/necessidades`} className={styles.tabNavItem}>
          Necessidades
        </Link>
        <Link to={`/organizacoes/${organizationId}/oportunidades`} className={styles.tabNavItem}>
          Oportunidades
        </Link>
        <Link to={`/organizacoes/${organizationId}/atribuicoes`} className={styles.tabNavItem}>
          Rede Levora
        </Link>
        <Link to={`/organizacoes/${organizationId}/prestacao-contas`} className={styles.tabNavItem}>
          Prestação de contas
        </Link>
      </nav>

      <div className={styles.columns}>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>
            <Users size={18} /> Equipe
          </h2>
          {membersQuery.isFetching && !membersQuery.data ? (
            <Skeleton className={styles.listSkeleton} />
          ) : membersQuery.data && membersQuery.data.members.length > 0 ? (
            <ul className={styles.memberList}>
              {membersQuery.data.members.map((m) => (
                <li key={m.membershipId} className={styles.memberRow}>
                  <div>
                    <div className={styles.memberName}>{m.displayName}</div>
                    <div className={styles.memberEmail}>{m.email}</div>
                  </div>
                  <div className={styles.memberBadges}>
                    <Badge variant="outline">{membershipRoleLabels[m.role]}</Badge>
                    <Badge variant={m.status === "ativo" ? "success" : "secondary"}>
                      {membershipStatusLabels[m.status]}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.emptyText}>Nenhum membro encontrado.</p>
          )}
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>
            <ScrollText size={18} /> Trilha de auditoria
          </h2>
          {!canSeeAuditLog ? (
            <p className={styles.emptyText}>
              Apenas proprietários e administradores podem visualizar a trilha
              de auditoria desta organização.
            </p>
          ) : auditLogQuery.isFetching && !auditLogQuery.data ? (
            <Skeleton className={styles.listSkeleton} />
          ) : auditLogQuery.data && auditLogQuery.data.entries.length > 0 ? (
            <ul className={styles.auditList}>
              {auditLogQuery.data.entries.map((entry) => (
                <li key={entry.id} className={styles.auditRow}>
                  <div className={styles.auditAction}>{entry.action}</div>
                  <div className={styles.auditMeta}>
                    {entry.actorDisplayName ?? "Sistema"} ·{" "}
                    {new Date(entry.createdAt).toLocaleString("pt-BR")}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.emptyText}>
              Nenhum evento registrado ainda. Cada ação relevante nesta
              organização ficará registrada aqui, de forma permanente.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
