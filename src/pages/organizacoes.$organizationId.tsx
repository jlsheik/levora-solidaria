import React, { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getOrganizations } from "../endpoints/organizations_GET.schema";
import { getOrganizationAllocations } from "../endpoints/organization-allocations_GET.schema";
import { getOrganizationMembers } from "../endpoints/organization-members_GET.schema";
import { getOrganizationInvites } from "../endpoints/organization-invites_GET.schema";
import { postOrganizationInvites } from "../endpoints/organization-invites_POST.schema";
import { postOrganizationInvitesRevoke } from "../endpoints/organization-invites-revoke_POST.schema";
import { postOrganizationMembersRole } from "../endpoints/organization-members-role_POST.schema";
import { postOrganizationMembersDeactivate } from "../endpoints/organization-members-deactivate_POST.schema";
import { postOrganizationMembersLeave } from "../endpoints/organization-members-leave_POST.schema";
import { useAuth } from "../helpers/useAuth";
import { ApiRequestError } from "../helpers/apiRequestError";
import type { MembershipRole } from "../helpers/schema";
import type { OutputType as MembersOutput } from "../endpoints/organization-members_GET.schema";
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
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../components/DropdownMenu";
import { ArrowLeft, ShieldAlert, Users, ScrollText, UserPlus, X, MoreVertical, LogOut, Pencil } from "lucide-react";
import { RenameOrganizationDialog } from "../components/RenameOrganizationDialog";
import { ActiveTab } from "../components/ActiveTab";
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

type Member = MembersOutput["members"][number];

type MemberDialog =
  | { type: "role"; member: Member; role: MembershipRole }
  | { type: "deactivate"; member: Member }
  | { type: "leave" };

const ALL_ROLES: MembershipRole[] = ["administrador", "operador", "voluntario", "proprietario"];
const ROLE_RANK: Record<MembershipRole, number> = { voluntario: 0, operador: 1, administrador: 2, proprietario: 3 };

// Espelha a matriz do servidor (docs/MEMBROS_ESPECIFICACAO.md, seção 3.1): o
// servidor é quem decide; aqui só se evita oferecer o que seria recusado.
function assignableRoles(actorRole: MembershipRole, target: Member): MembershipRole[] {
  if (target.status !== "ativo") return [];
  if (actorRole !== "proprietario" && target.role === "proprietario") return [];
  return ALL_ROLES.filter((role) => {
    if (role === target.role) return false;
    if (role === "proprietario" && actorRole !== "proprietario") return false;
    return true;
  });
}

export default function OrganizationDetailPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = Number(params.organizationId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"administrador" | "operador" | "voluntario">("operador");
  const [memberDialog, setMemberDialog] = useState<MemberDialog | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const { authState } = useAuth();
  const myUserId = authState.type === "authenticated" ? authState.user.id : null;

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => getOrganizations(),
  });
  const org = orgsQuery.data?.organizations.find((o) => o.id === organizationId);

  // Pendências das atribuições automáticas (Fase 98): MESMA consulta e mesma chave da página "Rede Levora" — uma fonte única, sem contagem paralela.
  const allocationsQuery = useQuery({
    queryKey: ["organization-allocations", organizationId],
    queryFn: () => getOrganizationAllocations({ organizationId }),
    enabled: Number.isFinite(organizationId),
    refetchInterval: 60_000,
  });
  const pendingCount = allocationsQuery.data?.pendingCount ?? 0;

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

  const refreshTeam = () => {
    queryClient.invalidateQueries({ queryKey: ["organization-members", organizationId] });
    queryClient.invalidateQueries({ queryKey: ["organizations"] });
    queryClient.invalidateQueries({ queryKey: ["audit-log", organizationId] });
  };

  // Mapeia o status HTTP da falha (Fase 73). 409 é conflito de estado (a
  // equipe mudou); 403 pode ser papel rebaixado ou acesso perdido — a lista de
  // organizações é recarregada e, se o acesso acabou, a página cai no estado
  // "não é membro". Texto de 5xx nunca é mostrado: mensagem genérica.
  const handleMemberError = (err: unknown, fallback: string) => {
    setMemberDialog(null);
    const status = err instanceof ApiRequestError ? err.status : null;
    const serverMessage = err instanceof ApiRequestError ? err.message : fallback;

    if (status === 401) {
      toast.error("Sua sessão expirou. Entre novamente.");
      // Mesmo reset que o logout do app faz (helpers/useAuth.tsx): sem ele, quem
      // entrar a seguir nesta aba veria o cache (papel, ações de gestão) do usuário anterior.
      queryClient.resetQueries();
      navigate("/login");
    } else if (status === 403) {
      toast.error(serverMessage);
      refreshTeam();
    } else if (status === 404) {
      toast.error("Este membro não faz mais parte da equipe.");
      refreshTeam();
    } else if (status === 409) {
      toast.error(serverMessage);
      toast.info("A equipe pode ter sido alterada por outra pessoa; atualizamos a lista.");
      refreshTeam();
    } else if (status === 429) {
      toast.error(serverMessage);
    } else {
      toast.error("Não foi possível concluir a ação. Tente novamente em instantes.");
    }
  };

  const changeRoleMutation = useMutation({
    mutationFn: (vars: { membershipId: number; role: MembershipRole }) =>
      postOrganizationMembersRole({ organizationId, ...vars }),
    onSuccess: () => {
      refreshTeam();
      toast.success("Papel alterado");
      setMemberDialog(null);
    },
    onError: (err) => handleMemberError(err, "Falha ao alterar o papel"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (membershipId: number) => postOrganizationMembersDeactivate({ organizationId, membershipId }),
    onSuccess: () => {
      refreshTeam();
      toast.success("Acesso desativado");
      setMemberDialog(null);
    },
    onError: (err) => handleMemberError(err, "Falha ao desativar o acesso"),
  });

  const leaveMutation = useMutation({
    mutationFn: () => postOrganizationMembersLeave({ organizationId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      toast.success("Você saiu da organização");
      setMemberDialog(null);
      navigate("/");
    },
    onError: (err) => handleMemberError(err, "Falha ao sair da organização"),
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

  const members = membersQuery.data?.members ?? [];
  const formerMembers = members.filter((m) => m.status !== "ativo");
  const activeOwnerCount = members.filter((m) => m.role === "proprietario" && m.status === "ativo").length;
  const isOnlyOwner = org?.myRole === "proprietario" && activeOwnerCount <= 1;

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
          <div className={styles.headerActions}>
            {org.myRole === "proprietario" && org.status === "ativa" && (
              <Button variant="outline" size="sm" onClick={() => setRenameOpen(true)} aria-label="Renomear organização">
                <Pencil size={14} /> Renomear
              </Button>
            )}
            <Badge variant={org.status === "ativa" ? "success" : org.status === "suspensa" ? "destructive" : "secondary"}>
              {org.status === "ativa" ? "Ativa" : org.status === "suspensa" ? "Suspensa" : "Em análise"}
            </Badge>
          </div>
          <RenameOrganizationDialog organizationId={organizationId} currentName={org.name} open={renameOpen} onOpenChange={setRenameOpen} />
        </header>
      )}

      <nav className={styles.tabNav}>
        <ActiveTab className={styles.tabNavItemActive}>Visão geral</ActiveTab>
        <Link to={`/organizacoes/${organizationId}/inventario`} className={styles.tabNavItem}>
          Inventário
        </Link>
        <Link to={`/organizacoes/${organizationId}/destinacoes`} className={styles.tabNavItem}>
          Destinação
        </Link>
        <Link to={`/organizacoes/${organizationId}/necessidades`} className={styles.tabNavItem}>
          Necessidades
        </Link>
        <Link to={`/organizacoes/${organizationId}/oportunidades`} className={styles.tabNavItem}>
          Oportunidades
        </Link>
        <Link to={`/organizacoes/${organizationId}/atribuicoes`} className={styles.tabNavItem} aria-label={pendingCount > 0 ? `Rede Levora, ${pendingCount} ${pendingCount === 1 ? "pendência com prazo" : "pendências com prazo"}` : undefined}>
          Rede Levora
          {pendingCount > 0 && <span className={styles.navBadge} aria-hidden="true">{pendingCount}</span>}
        </Link>
        <Link to={`/organizacoes/${organizationId}/prestacao-contas`} className={styles.tabNavItem}>
          Prestação de contas
        </Link>
        <Link to={`/organizacoes/${organizationId}/matching`} className={styles.tabNavItem}>
          Configurações de Matching
        </Link>
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

      <div className={styles.columns}>
        <section className={styles.section}>
          <div className={styles.sectionHeaderRow}>
            <h2 className={styles.sectionTitle}>
              <Users size={18} /> Equipe
            </h2>
            {canManageMembers && (
              <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" className={styles.touchTarget}>
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
          ) : membersQuery.data && membersQuery.data.members.some((m) => m.status === "ativo") ? (
            <ul className={styles.memberList}>
              {membersQuery.data.members
                .filter((m) => m.status === "ativo")
                .map((m) => {
                  const isMe = m.userId === myUserId;
                  const myRole = org?.myRole;
                  const roleOptions = myRole && canManageMembers && !isMe ? assignableRoles(myRole, m) : [];
                  const canDeactivate =
                    canManageMembers && !isMe && !(myRole !== "proprietario" && m.role === "proprietario");
                  return (
                    <li key={m.membershipId} className={styles.memberRow}>
                      <div>
                        <div className={styles.memberName}>
                          {m.displayName}
                          {isMe ? " (você)" : ""}
                        </div>
                        <div className={styles.memberEmail}>{m.email}</div>
                      </div>
                      <div className={styles.memberBadges}>
                        <Badge variant="outline">{membershipRoleLabels[m.role]}</Badge>
                        <Badge variant="success">{membershipStatusLabels[m.status]}</Badge>
                        {(roleOptions.length > 0 || canDeactivate) && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button type="button" className={styles.actionButton} aria-label={`Ações para ${m.displayName}`}>
                                <MoreVertical size={16} />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {roleOptions.length > 0 && (
                                <DropdownMenuItem
                                  className={styles.touchTarget}
                                  onSelect={() => setMemberDialog({ type: "role", member: m, role: roleOptions.find((role) => role !== "proprietario") ?? roleOptions[0] })}
                                >
                                  Alterar papel
                                </DropdownMenuItem>
                              )}
                              {roleOptions.length > 0 && canDeactivate && <DropdownMenuSeparator />}
                              {canDeactivate && (
                                <DropdownMenuItem
                                  className={styles.touchTarget}
                                  onSelect={() => setMemberDialog({ type: "deactivate", member: m })}
                                >
                                  Desativar acesso
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </li>
                  );
                })}
            </ul>
          ) : (
            <p className={styles.emptyText}>Nenhum membro encontrado.</p>
          )}

          {org && myUserId !== null && (
            <div className={styles.leaveRow}>
              <Button
                variant="outline"
                size="sm"
                className={styles.touchTarget}
                disabled={isOnlyOwner}
                onClick={() => setMemberDialog({ type: "leave" })}
              >
                <LogOut size={14} /> Sair da organização
              </Button>
              {isOnlyOwner && <p className={styles.leaveHint}>Promova outro proprietário antes de sair.</p>}
            </div>
          )}

          {canManageMembers && formerMembers.length > 0 && (
            <details className={styles.formerMembers}>
              <summary>Ex-membros ({formerMembers.length})</summary>
              <ul className={styles.memberList}>
                {formerMembers.map((m) => (
                  <li key={m.membershipId} className={styles.memberRow}>
                    <div>
                      <div className={styles.memberName}>{m.displayName}</div>
                      <div className={styles.memberEmail}>{m.email}</div>
                    </div>
                    <div className={styles.memberBadges}>
                      <Badge variant="outline">{membershipRoleLabels[m.role]}</Badge>
                      <Badge variant="secondary">{membershipStatusLabels[m.status]}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
              <p className={styles.formerHint}>Para voltar, envie um novo convite.</p>
            </details>
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

        <Dialog open={memberDialog !== null} onOpenChange={(open) => !open && setMemberDialog(null)}>
          <DialogContent>
            {memberDialog?.type === "role" && (
              <>
                <DialogHeader>
                  <DialogTitle>Alterar papel</DialogTitle>
                  <DialogDescription>
                    {memberDialog.member.displayName} passa de {membershipRoleLabels[memberDialog.member.role]} para o
                    papel escolhido, com efeito imediato.
                    {(memberDialog.role === "proprietario" ||
                      memberDialog.member.role === "proprietario" ||
                      ROLE_RANK[memberDialog.role] < ROLE_RANK[memberDialog.member.role]) &&
                      " Esta mudança é um rebaixamento ou envolve proprietário: confirme com atenção."}
                  </DialogDescription>
                </DialogHeader>
                <div className={styles.inviteFormField}>
                  <label className={styles.inviteFormLabel}>Novo papel</label>
                  <Select
                    value={memberDialog.role}
                    onValueChange={(v) => setMemberDialog({ ...memberDialog, role: v as MembershipRole })}
                  >
                    <SelectTrigger className={styles.touchTarget}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(org ? assignableRoles(org.myRole, memberDialog.member) : []).map((role) => (
                        <SelectItem key={role} value={role}>
                          {membershipRoleLabels[role]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <DialogFooter>
                  <Button
                    className={styles.touchTarget}
                    disabled={changeRoleMutation.isPending}
                    onClick={() =>
                      changeRoleMutation.mutate({ membershipId: memberDialog.member.membershipId, role: memberDialog.role })
                    }
                  >
                    {changeRoleMutation.isPending ? "Salvando..." : "Confirmar"}
                  </Button>
                </DialogFooter>
              </>
            )}
            {memberDialog?.type === "deactivate" && (
              <>
                <DialogHeader>
                  <DialogTitle>Desativar acesso</DialogTitle>
                  <DialogDescription>
                    {memberDialog.member.displayName} perde o acesso imediatamente. Os registros dessa pessoa continuam
                    no histórico. Para voltar, será preciso um novo convite.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button
                    variant="destructive"
                    className={styles.touchTarget}
                    disabled={deactivateMutation.isPending}
                    onClick={() => deactivateMutation.mutate(memberDialog.member.membershipId)}
                  >
                    {deactivateMutation.isPending ? "Desativando..." : "Desativar acesso"}
                  </Button>
                </DialogFooter>
              </>
            )}
            {memberDialog?.type === "leave" && (
              <>
                <DialogHeader>
                  <DialogTitle>Sair da organização</DialogTitle>
                  <DialogDescription>
                    Você perde o acesso imediatamente. Os seus registros continuam no histórico. Para voltar, será
                    preciso um novo convite.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button
                    variant="destructive"
                    className={styles.touchTarget}
                    disabled={leaveMutation.isPending}
                    onClick={() => leaveMutation.mutate()}
                  >
                    {leaveMutation.isPending ? "Saindo..." : "Sair da organização"}
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>

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
