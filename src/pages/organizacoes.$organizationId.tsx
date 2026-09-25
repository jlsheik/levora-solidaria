import React, { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getOrganizations } from "../endpoints/organizations_GET.schema";
import { getOrganizationMembers } from "../endpoints/organization-members_GET.schema";
import { getOrganizationInvites } from "../endpoints/organization-invites_GET.schema";
import { postOrganizationInvites } from "../endpoints/organization-invites_POST.schema";
import { postOrganizationInvitesRevoke } from "../endpoints/organization-invites-revoke_POST.schema";
import { getAuditLog } from "../endpoints/audit-log_GET.schema";
import { Badge } from "../components/Badge";
import { Skeleton } from "../components/Skeleton";
import { Button } from "../components/Button";
import { Input } from "../components/Input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "../components/Dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/Select";
import { ArrowLeft, ShieldAlert, Users, ScrollText, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
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

const inviteStatusLabels: Record<string, string> = {
  pendente: "Pendente",
  aceito: "Aceito",
  expirado: "Expirado",
  revogado: "Revogado",
};

const invitableRoles: Array<{ value: "administrador" | "operador" | "voluntario"; label: string }> = [
  { value: "administrador", label: "Administrador" },
  { value: "operador", label: "Operador" },
  { value: "voluntario", label: "Voluntário" },
];

export default function OrganizationDetailPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = Number(params.organizationId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"administrador" | "operador" | "voluntario">("operador");

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
  const canManageMembers = canSeeAuditLog; // mesma regra: proprietário/administrador

  const auditLogQuery = useQuery({
    queryKey: ["audit-log", organizationId],
    queryFn: () => getAuditLog({ organizationId }),
    enabled: Number.isFinite(organizationId) && canSeeAuditLog,
  });

  const invitesQuery = useQuery({
    queryKey: ["organization-invites", organizationId],
    queryFn: () => getOrganizationInvites({ organizationId }),
    enabled: Number.isFinite(organizationId) && canManageMembers,
  });

  const inviteMutation = useMutation({
    mutationFn: () => postOrganizationInvites({ organizationId, email: inviteEmail, role: inviteRole }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["organization-invites", organizationId] });
      if (data.emailSent) {
        toast.success(`Convite enviado por e-mail para ${inviteEmail}`);
      } else {
        toast.success("Convite criado. E-mail não configurado no servidor — copie o link abaixo e envie manualmente.", {
          duration: 10000,
          action: {
            label: "Copiar link",
            onClick: () => {
              navigator.clipboard.writeText(data.acceptUrl);
              toast.success("Link copiado");
            },
          },
        });
      }
      setInviteOpen(false);
      setInviteEmail("");
      setInviteRole("operador");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao criar convite"),
  });

  const revokeInviteMutation = useMutation({
    mutationFn: (inviteId: number) => postOrganizationInvitesRevoke({ organizationId, inviteId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organization-invites", organizationId] });
      toast.success("Convite revogado");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao revogar convite"),
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
          <div className={styles.sectionHeaderRow}>
            <h2 className={styles.sectionTitle}>
              <Users size={18} /> Equipe
            </h2>
            {canManageMembers && (
              <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <UserPlus size={14} /> Convidar
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Convidar membro</DialogTitle>
                    <DialogDescription>
                      A pessoa recebe um link por e-mail (ou você compartilha
                      manualmente, se o servidor não tiver e-mail
                      configurado) para entrar nesta organização com o papel
                      escolhido.
                    </DialogDescription>
                  </DialogHeader>
                  <form
                    className={styles.inviteForm}
                    onSubmit={(e) => {
                      e.preventDefault();
                      inviteMutation.mutate();
                    }}
                  >
                    <div className={styles.inviteFormField}>
                      <label className={styles.inviteFormLabel} htmlFor="invite-email">
                        E-mail
                      </label>
                      <Input
                        id="invite-email"
                        type="email"
                        required
                        placeholder="pessoa@exemplo.org"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                      />
                    </div>
                    <div className={styles.inviteFormField}>
                      <label className={styles.inviteFormLabel}>Papel</label>
                      <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as typeof inviteRole)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {invitableRoles.map((r) => (
                            <SelectItem key={r.value} value={r.value}>
                              {r.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <DialogFooter>
                      <Button type="submit" disabled={inviteMutation.isPending || !inviteEmail}>
                        {inviteMutation.isPending ? "Enviando..." : "Enviar convite"}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            )}
          </div>
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

          {canManageMembers && invitesQuery.data && invitesQuery.data.invites.filter((i) => i.status === "pendente").length > 0 && (
            <>
              <h3 className={styles.inviteListTitle}>Convites pendentes</h3>
              <ul className={styles.memberList}>
                {invitesQuery.data.invites
                  .filter((i) => i.status === "pendente")
                  .map((invite) => (
                    <li key={invite.id} className={styles.memberRow}>
                      <div>
                        <div className={styles.memberName}>{invite.email}</div>
                        <div className={styles.memberEmail}>
                          Convidado por {invite.invitedByDisplayName} · expira em{" "}
                          {new Date(invite.expiresAt).toLocaleDateString("pt-BR")}
                        </div>
                      </div>
                      <div className={styles.memberBadges}>
                        <Badge variant="outline">{membershipRoleLabels[invite.role]}</Badge>
                        <Badge variant="secondary">{inviteStatusLabels[invite.status]}</Badge>
                        <button
                          type="button"
                          className={styles.revokeButton}
                          title="Revogar convite"
                          onClick={() => revokeInviteMutation.mutate(invite.id)}
                          disabled={revokeInviteMutation.isPending}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </li>
                  ))}
              </ul>
            </>
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
