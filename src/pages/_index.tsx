import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getOrganizations } from "../endpoints/organizations_GET.schema";
import { postOrganizations } from "../endpoints/organizations_POST.schema";
import { DeleteAccountDialog } from "../components/DeleteAccountDialog";
import { OrganizationTypeArrayValues } from "../helpers/schema";
import { useAuth, AUTH_QUERY_KEY } from "../helpers/useAuth";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "../components/Dialog";
import {
  Form,
  FormControl,
  FormItem,
  FormLabel,
  FormMessage,
  useForm,
} from "../components/Form";
import { Input } from "../components/Input";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { Skeleton } from "../components/Skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/Select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/DropdownMenu";
import { z } from "zod";
import { HeartHandshake, Plus, Building2, LogOut, Network, MoreVertical, Trash2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import styles from "./_index.module.css";

const organizationTypeLabels: Record<string, string> = {
  igreja: "Igreja",
  organizacao_social: "Organização social",
  ponto_distribuicao: "Ponto de distribuição",
};

const membershipRoleLabels: Record<string, string> = {
  proprietario: "Proprietário",
  administrador: "Administrador",
  operador: "Operador",
  voluntario: "Voluntário",
};

const organizationStatusLabels: Record<string, string> = {
  ativa: "Ativa",
  em_analise: "Em análise",
  suspensa: "Suspensa",
};

const createOrgSchema = z.object({
  name: z.string().min(2, "Informe o nome da organização"),
  type: z.enum(OrganizationTypeArrayValues),
  city: z.string().min(2, "Informe a cidade"),
  state: z.string().length(2, "Use a sigla do estado, ex: MG"),
});

export default function DashboardPage() {
  const { authState, logout } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => getOrganizations(),
  });

  const form = useForm({
    schema: createOrgSchema,
    defaultValues: { name: "", city: "", state: "" },
  });

  const createOrgMutation = useMutation({
    mutationFn: (data: z.infer<typeof createOrgSchema>) => postOrganizations(data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      toast.success("Organização criada com sucesso");
      setDialogOpen(false);
      form.setValues({ name: "", city: "", state: "" } as any);
      navigate(`/organizacoes/${result.organization.id}`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Não foi possível criar a organização");
    },
  });

  // Retorno da reautenticação (/?reauth=ok|erro): reabre o diálogo de exclusão; a barra de endereço é limpa (replace).
  const [searchParams, setSearchParams] = useSearchParams();
  const [justReauthenticated, setJustReauthenticated] = useState(false);
  useEffect(() => {
    const reauth = searchParams.get("reauth");
    if (!reauth) return;
    if (reauth === "ok") {
      setJustReauthenticated(true);
      setDeleteAccountOpen(true);
    } else {
      toast.error("Não foi possível confirmar sua identidade. Tente novamente.");
    }
    setSearchParams({}, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAccountDeleted = () => {
    // A sessão já foi encerrada pelo servidor (cookie limpo na resposta) — só limpa o estado local e vai para o login.
    queryClient.setQueryData(AUTH_QUERY_KEY, null);
    queryClient.resetQueries();
    toast.success("Conta excluída. Sentiremos sua falta.");
    navigate("/login");
  };

  const userName = authState.type === "authenticated" ? authState.user.displayName : "";

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <HeartHandshake className={styles.brandIcon} size={24} />
          <span className={styles.brandName}>Levora Solidária</span>
        </div>
        <div className={styles.headerActions}>
          {authState.type === "authenticated" && authState.user.role === "admin" && (
            <Button variant="outline" size="sm" onClick={() => navigate("/plataforma")}>
              <Network size={14} /> Operação de plataforma
            </Button>
          )}
          <span className={styles.userGreeting}>Olá, {userName}</span>
          <Button variant="ghost" size="icon-sm" onClick={() => logout()} title="Sair">
            <LogOut size={18} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" title="Mais opções">
                <MoreVertical size={18} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => navigate("/seguranca")}>
                <ShieldCheck size={14} /> Segurança (autenticador)
              </DropdownMenuItem>
              <DropdownMenuItem className={styles.dangerMenuItem} onSelect={() => setDeleteAccountOpen(true)}>
                <Trash2 size={14} /> Excluir minha conta
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <DeleteAccountDialog open={deleteAccountOpen} onOpenChange={setDeleteAccountOpen} onDeleted={handleAccountDeleted} justReauthenticated={justReauthenticated} />

      <main className={styles.main}>
        <div className={styles.titleRow}>
          <div>
            <h1 className={styles.title}>Suas organizações</h1>
            <p className={styles.subtitle}>
              Cada organização opera de forma isolada: dados, papéis e trilha de
              auditoria não são compartilhados entre elas.
            </p>
          </div>

          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus size={16} />
                Nova organização
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Cadastrar organização</DialogTitle>
                <DialogDescription>
                  Você será o proprietário desta organização e poderá convidar
                  outros administradores e voluntários depois.
                </DialogDescription>
              </DialogHeader>
              <Form {...form}>
                <form
                  className={styles.formGrid}
                  onSubmit={form.handleSubmit((data) => createOrgMutation.mutate(data))}
                >
                  <FormItem name="name">
                    <FormLabel>Nome da organização</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Ex: Igreja Batista Central"
                        value={form.values.name || ""}
                        onChange={(e) =>
                          form.setValues((prev: any) => ({ ...prev, name: e.target.value }))
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>

                  <FormItem name="type">
                    <FormLabel>Tipo</FormLabel>
                    <FormControl>
                      <Select
                        value={form.values.type}
                        onValueChange={(v) => form.setValues((prev: any) => ({ ...prev, type: v }))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Selecione o tipo" />
                        </SelectTrigger>
                        <SelectContent>
                          {OrganizationTypeArrayValues.map((t) => (
                            <SelectItem key={t} value={t}>
                              {organizationTypeLabels[t]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>

                  <div className={styles.formRow}>
                    <FormItem name="city" className={styles.formRowItem}>
                      <FormLabel>Cidade</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Belo Horizonte"
                          value={form.values.city || ""}
                          onChange={(e) =>
                            form.setValues((prev: any) => ({ ...prev, city: e.target.value }))
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>

                    <FormItem name="state" className={styles.formRowState}>
                      <FormLabel>UF</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="MG"
                          maxLength={2}
                          value={form.values.state || ""}
                          onChange={(e) =>
                            form.setValues((prev: any) => ({
                              ...prev,
                              state: e.target.value.toUpperCase(),
                            }))
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  </div>

                  <DialogFooter>
                    <Button type="submit" disabled={createOrgMutation.isPending}>
                      {createOrgMutation.isPending ? "Criando..." : "Criar organização"}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>

        {orgsQuery.isFetching && !orgsQuery.data ? (
          <div className={styles.grid}>
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className={styles.cardSkeleton} />
            ))}
          </div>
        ) : orgsQuery.isError ? (
          <div className={styles.emptyState}>
            Não foi possível carregar suas organizações. Tente atualizar a página.
          </div>
        ) : orgsQuery.data && orgsQuery.data.organizations.length > 0 ? (
          <div className={styles.grid}>
            {orgsQuery.data.organizations.map((org) => (
              <button
                key={org.id}
                className={styles.orgCard}
                onClick={() => navigate(`/organizacoes/${org.id}`)}
              >
                <div className={styles.orgCardHeader}>
                  <Building2 size={20} className={styles.orgIcon} />
                  <Badge variant={org.status === "ativa" ? "success" : org.status === "suspensa" ? "destructive" : "secondary"}>
                    {organizationStatusLabels[org.status]}
                  </Badge>
                </div>
                <h3 className={styles.orgName}>{org.name}</h3>
                <p className={styles.orgMeta}>
                  {organizationTypeLabels[org.type]} · {org.city}/{org.state}
                </p>
                <div className={styles.orgFooter}>
                  <span className={styles.orgRole}>Seu papel: {membershipRoleLabels[org.myRole] ?? org.myRole}</span>
                  <span className={styles.orgMembers}>{org.memberCount} membro(s)</span>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className={styles.emptyState}>
            Você ainda não participa de nenhuma organização. Cadastre a primeira
            para começar a operar.
          </div>
        )}
      </main>
    </div>
  );
}
