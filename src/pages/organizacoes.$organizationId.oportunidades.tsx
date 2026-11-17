import React, { useState, useMemo, useEffect } from "react";
import { useParams, Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getOrganizations } from "../endpoints/organizations_GET.schema";
import { getOpportunities } from "../endpoints/opportunities_GET.schema";
import { OpportunityCategoryDialog } from "../components/OpportunityCategoryDialog";
import { OpportunityAssessmentBox } from "../components/OpportunityAssessmentBox";
import { MISSING_CATEGORY_HELP } from "../components/opportunityCategoryView";
import agentStyles from "../components/OpportunityAgent.module.css";
import { postOpportunities } from "../endpoints/opportunities_POST.schema";
import { postOpportunitiesStatus } from "../endpoints/opportunities-status_POST.schema";
import { postOpportunitiesReceive } from "../endpoints/opportunities-receive_POST.schema";
import { getNeeds } from "../endpoints/needs_GET.schema";
import { getInventoryItems } from "../endpoints/inventory-items_GET.schema";
import { OpportunityStatusArrayValues } from "../helpers/schema";
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
import { Textarea } from "../components/Textarea";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { UnitText } from "../components/UnitText";
import { UnitSelect } from "../components/UnitSelect";
import { Skeleton } from "../components/Skeleton";
import { ActiveTab } from "../components/ActiveTab";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/Select";
import { z } from "zod";
import { ArrowLeft, Gift, Lightbulb, PackageCheck } from "lucide-react";
import { toast } from "sonner";
import styles from "./organizacoes.$organizationId.oportunidades.module.css";

const nonReceiveStatuses = OpportunityStatusArrayValues.filter((s) => s !== "recebida");

const statusLabels: Record<string, string> = {
  registrada: "Registrada",
  em_contato: "Em contato",
  confirmada: "Confirmada",
  recebida: "Recebida",
  cancelada: "Cancelada",
};

const statusVariant: Record<string, "secondary" | "outline" | "success" | "destructive"> = {
  registrada: "outline",
  em_contato: "secondary",
  confirmada: "outline",
  recebida: "success",
  cancelada: "destructive",
};

const newOpportunitySchema = z.object({
  title: z.string().min(3, "Informe um título"),
  description: z.string().optional(),
  category: z.string().optional(),
  quantityOffered: z.coerce.number().positive().optional(),
  unit: z.string().optional(),
  donorName: z.string().min(2, "Informe o nome ou identificação do doador"),
  donorContact: z.string().optional(),
  linkedNeedId: z.coerce.number().int().positive().optional(),
});

const receiveSchema = z.object({
  itemId: z.coerce.number().int().positive({ message: "Selecione o item recebido" }),
  quantityReceived: z.coerce.number().positive("Informe a quantidade recebida"),
  notes: z.string().optional(),
});

function normalize(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export default function OpportunitiesPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = Number(params.organizationId);
  const queryClient = useQueryClient();
  const [newOpen, setNewOpen] = useState(false);
  const [receiveTarget, setReceiveTarget] = useState<{ id: number; title: string } | null>(null);
  const [categoryTarget, setCategoryTarget] = useState<{ id: number; title: string; category: string | null; version: number } | null>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const highlightId = Number(searchParams.get("destaque")) || null; // navegação contextual: vindo da justificativa do agente, destaca a oferta

  const orgsQuery = useQuery({ queryKey: ["organizations"], queryFn: () => getOrganizations() });
  const org = orgsQuery.data?.organizations.find((o) => o.id === organizationId);
  const canManage = org && ["proprietario", "administrador", "operador"].includes(org.myRole);
  const canRequestReevaluation = !!org && ["proprietario", "administrador"].includes(org.myRole); // permissão de automação (o servidor decide de verdade)

  const opportunitiesQuery = useQuery({
    queryKey: ["opportunities", organizationId],
    queryFn: () => getOpportunities({ organizationId }),
    enabled: Number.isFinite(organizationId),
  });

  useEffect(() => {
    if (highlightId && opportunitiesQuery.data) document.getElementById(`oportunidade-${highlightId}`)?.scrollIntoView({ block: "center" });
  }, [highlightId, opportunitiesQuery.data]);

  const needsQuery = useQuery({
    queryKey: ["needs", organizationId],
    queryFn: () => getNeeds({ organizationId }),
    enabled: Number.isFinite(organizationId),
  });

  const itemsQuery = useQuery({
    queryKey: ["inventory-items", organizationId],
    queryFn: () => getInventoryItems({ organizationId }),
    enabled: Number.isFinite(organizationId) && !!receiveTarget,
  });

  const openNeeds = useMemo(
    () => (needsQuery.data ? needsQuery.data.needs.filter((n) => n.status === "aberta") : []),
    [needsQuery.data]
  );

  function suggestedNeedsFor(opportunity: { title: string; category: string | null; description: string | null }) {
    const haystack = normalize(`${opportunity.title} ${opportunity.category ?? ""} ${opportunity.description ?? ""}`);
    return openNeeds.filter((need) => {
      const words = normalize(need.title).split(/\s+/).filter((w) => w.length > 3);
      return words.some((w) => haystack.includes(w));
    });
  }

  const form = useForm({
    schema: newOpportunitySchema,
    defaultValues: { title: "", donorName: "", description: "", category: "", unit: "" },
  });

  const createMutation = useMutation({
    mutationFn: (data: z.infer<typeof newOpportunitySchema>) => postOpportunities({ organizationId, ...data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["opportunities", organizationId] });
      toast.success("Oportunidade registrada");
      setNewOpen(false);
      form.setValues({ title: "", donorName: "", description: "", category: "", unit: "" } as any);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao registrar oportunidade"),
  });

  const statusMutation = useMutation({
    mutationFn: (vars: { opportunityId: number; status: (typeof nonReceiveStatuses)[number] }) =>
      postOpportunitiesStatus({ organizationId, ...vars }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["opportunities", organizationId] });
      toast.success("Status atualizado");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao atualizar status"),
  });

  const receiveForm = useForm({ schema: receiveSchema, defaultValues: { quantityReceived: 0, notes: "" } });

  const receiveMutation = useMutation({
    mutationFn: (data: z.infer<typeof receiveSchema>) =>
      postOpportunitiesReceive({ organizationId, opportunityId: receiveTarget!.id, ...data }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["opportunities", organizationId] });
      queryClient.invalidateQueries({ queryKey: ["inventory-items", organizationId] });
      queryClient.invalidateQueries({ queryKey: ["stock-transactions", organizationId] });
      queryClient.invalidateQueries({ queryKey: ["unit-regularization-cases", organizationId] });
      if (result.pendingRegularization) toast.warning(result.pendingRegularization.message, { duration: 12000 });
      else toast.success(`Recebimento registrado. Novo saldo do item: ${result.newStock}`);
      setReceiveTarget(null);
      receiveForm.setValues({ quantityReceived: 0, notes: "" } as any);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao registrar recebimento"),
  });

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.backLink}>
        <ArrowLeft size={16} /> Voltar ao painel
      </Link>

      <nav className={styles.tabNav}>
        <Link to={`/organizacoes/${organizationId}`} className={styles.tabNavItem}>
          Visão geral
        </Link>
        <Link to={`/organizacoes/${organizationId}/inventario`} className={styles.tabNavItem}>
          Inventário
        </Link>
        <Link to={`/organizacoes/${organizationId}/destinacoes`} className={styles.tabNavItem}>Destinação</Link>
        <Link to={`/organizacoes/${organizationId}/necessidades`} className={styles.tabNavItem}>
          Necessidades
        </Link>
        <ActiveTab className={styles.tabNavItemActive}>Oportunidades</ActiveTab>
        <Link to={`/organizacoes/${organizationId}/atribuicoes`} className={styles.tabNavItem}>
          Rede Levora
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

      <div className={styles.titleRow}>
        <div>
          <h1 className={styles.title}>Oportunidades de doação</h1>
          <p className={styles.subtitle}>
            Registro manual de contatos com doadores. As relações sugeridas com
            necessidades abertas são um cruzamento simples de palavras-chave —
            não uma confirmação automática, sempre revise antes de vincular.
          </p>
        </div>
        {canManage && (
          <Dialog open={newOpen} onOpenChange={setNewOpen}>
            <DialogTrigger asChild>
              <Button>
                <Gift size={16} /> Nova oportunidade
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Registrar oportunidade de doação</DialogTitle>
                <DialogDescription>
                  Registre o que o doador ofereceu. Isso não confirma o
                  recebimento — o recebimento real é feito depois, à parte,
                  com conferência da quantidade.
                </DialogDescription>
              </DialogHeader>
              <Form {...form}>
                <form
                  className={styles.formGrid}
                  onSubmit={form.handleSubmit((data) => createMutation.mutate(data))}
                >
                  <FormItem name="title">
                    <FormLabel>O que foi oferecido</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Ex: 50 cestas básicas"
                        value={form.values.title || ""}
                        onChange={(e) => form.setValues((p: any) => ({ ...p, title: e.target.value }))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                  <div className={styles.formRow}>
                    <FormItem name="donorName" className={styles.formRowItem}>
                      <FormLabel>Doador</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Nome ou empresa"
                          value={form.values.donorName || ""}
                          onChange={(e) => form.setValues((p: any) => ({ ...p, donorName: e.target.value }))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                    <FormItem name="donorContact" className={styles.formRowItem}>
                      <FormLabel>Contato (opcional)</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Telefone ou e-mail"
                          value={form.values.donorContact || ""}
                          onChange={(e) => form.setValues((p: any) => ({ ...p, donorContact: e.target.value }))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  </div>
                  <div className={styles.formRow}>
                    <FormItem name="quantityOffered" className={styles.formRowItem}>
                      <FormLabel>Quantidade oferecida (opcional)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.001"
                          value={form.values.quantityOffered ?? ""}
                          onChange={(e) => form.setValues((p: any) => ({ ...p, quantityOffered: e.target.value }))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                    <FormItem name="unit" className={styles.formRowItem}>
                      <FormLabel>Unidade</FormLabel>
                      <FormControl>
                        <UnitSelect allowEmpty value={form.values.unit || ""} onChange={(v) => form.setValues((p: any) => ({ ...p, unit: v }))} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  </div>
                  <FormItem name="category">
                    <FormLabel>Categoria (opcional)</FormLabel>
                    <FormControl>
                      <Input
                        list="categoria-sugestoes-cadastro"
                        placeholder="Deixe em branco se ainda não souber"
                        maxLength={60}
                        autoComplete="off"
                        value={form.values.category || ""}
                        onChange={(e) => form.setValues((p: any) => ({ ...p, category: e.target.value }))}
                      />
                    </FormControl>
                    <datalist id="categoria-sugestoes-cadastro">{(opportunitiesQuery.data?.categorySuggestions ?? []).map((s) => <option key={s.value} value={s.value} />)}</datalist>
                    <p className={agentStyles.help}>{MISSING_CATEGORY_HELP}</p>
                    <FormMessage />
                  </FormItem>
                  <FormItem name="description">
                    <FormLabel>Detalhes (opcional)</FormLabel>
                    <FormControl>
                      <Textarea
                        value={form.values.description || ""}
                        onChange={(e) => form.setValues((p: any) => ({ ...p, description: e.target.value }))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                  {openNeeds.length > 0 && (
                    <FormItem name="linkedNeedId">
                      <FormLabel>Vincular a uma necessidade aberta (opcional)</FormLabel>
                      <FormControl>
                        <Select
                          value={form.values.linkedNeedId ? String(form.values.linkedNeedId) : undefined}
                          onValueChange={(v) => form.setValues((p: any) => ({ ...p, linkedNeedId: v }))}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Nenhuma" />
                          </SelectTrigger>
                          <SelectContent>
                            {openNeeds.map((n) => (
                              <SelectItem key={n.id} value={String(n.id)}>
                                {n.title}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                  <DialogFooter>
                    <Button type="submit" disabled={createMutation.isPending}>
                      {createMutation.isPending ? "Registrando..." : "Registrar oportunidade"}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {opportunitiesQuery.isFetching && !opportunitiesQuery.data ? (
        <Skeleton className={styles.listSkeleton} />
      ) : opportunitiesQuery.data && opportunitiesQuery.data.opportunities.length > 0 ? (
        <ul className={styles.oppList}>
          {opportunitiesQuery.data.opportunities.map((opp) => {
            const suggestions = suggestedNeedsFor(opp).filter((n) => n.id !== opp.linkedNeedId);
            const isFinal = opp.status === "recebida" || opp.status === "cancelada";
            return (
              <li key={opp.id} id={`oportunidade-${opp.id}`} className={`${styles.oppCard} ${highlightId === opp.id ? agentStyles.highlight : ""}`}>
                <div className={styles.oppHeaderRow}>
                  <h3 className={styles.oppTitle}>{opp.title}</h3>
                  <Badge variant={statusVariant[opp.status]}>{statusLabels[opp.status]}</Badge>
                </div>
                <p className={styles.oppMeta}>
                  Doador: {opp.donorName}
                  {opp.donorContact ? ` (${opp.donorContact})` : ""}
                  {opp.quantityOffered ? <> · {opp.quantityOffered} <UnitText unit={opp.unit} /></> : ""} · registrada por{" "}
                  {opp.createdByDisplayName} em {new Date(opp.createdAt).toLocaleDateString("pt-BR")}
                </p>
                {opp.description && <p className={styles.oppDescription}>{opp.description}</p>}
                <div className={agentStyles.categoryRow}>
                  <strong>Categoria:</strong>
                  {opp.category ? <Badge variant="secondary">{opp.category}</Badge> : <Badge variant="outline">Sem categoria</Badge>}
                  {opp.canEditCategory && opp.version !== undefined && (
                    <Button type="button" variant="outline" size="sm" onClick={() => setCategoryTarget({ id: opp.id, title: opp.title, category: opp.category, version: opp.version! })} aria-label={`${opp.category ? "Corrigir" : "Definir"} a categoria de ${opp.title}`}>
                      {opp.category ? "Corrigir categoria…" : "Definir categoria…"}
                    </Button>
                  )}
                </div>
                {!opp.category && !isFinal && <p className={agentStyles.help}>{MISSING_CATEGORY_HELP}</p>}
                {opp.assessment && (
                  <OpportunityAssessmentBox
                    organizationId={organizationId}
                    opportunityId={opp.id}
                    assessment={opp.assessment}
                    canRequest={canRequestReevaluation}
                    justificationHref={`/organizacoes/${organizationId}/automacao?run=${opp.assessment.runId}`}
                    onOpenJustification={() => navigate(`/organizacoes/${organizationId}/automacao?run=${opp.assessment!.runId}`)}
                    traceHref={canRequestReevaluation ? `/organizacoes/${organizationId}/auditoria?aba=rastreabilidade&oportunidade=${opp.id}` : undefined}
                    onOpenTrace={() => navigate(`/organizacoes/${organizationId}/auditoria?aba=rastreabilidade&oportunidade=${opp.id}`)}
                  />
                )}
                {opp.linkedNeedTitle && (
                  <p className={styles.linkedNeed}>Vinculada à necessidade: {opp.linkedNeedTitle}</p>
                )}

                {!isFinal && suggestions.length > 0 && (
                  <div className={styles.suggestionBox}>
                    <div className={styles.suggestionHeader}>
                      <Lightbulb size={14} />
                      Possível relação com necessidades abertas (sugestão por palavra-chave)
                    </div>
                    <div className={styles.suggestionChips}>
                      {suggestions.map((n) => (
                        <button
                          key={n.id}
                          className={styles.suggestionChip}
                          disabled={!canManage}
                          onClick={() =>
                            postOpportunitiesStatus({ organizationId, opportunityId: opp.id, linkedNeedId: n.id })
                              .then(() => {
                                queryClient.invalidateQueries({ queryKey: ["opportunities", organizationId] });
                                toast.success("Vinculado à necessidade");
                              })
                              .catch((err) => toast.error(err instanceof Error ? err.message : "Falha ao vincular"))
                          }
                        >
                          {n.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {canManage && !isFinal && (
                  <div className={styles.oppActions}>
                    <Select
                      value={opp.status}
                      onValueChange={(v) =>
                        statusMutation.mutate({ opportunityId: opp.id, status: v as (typeof nonReceiveStatuses)[number] })
                      }
                    >
                      <SelectTrigger className={styles.statusSelect}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {nonReceiveStatuses.map((s) => (
                          <SelectItem key={s} value={s}>
                            {statusLabels[s]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setReceiveTarget({ id: opp.id, title: opp.title });
                        receiveForm.setValues({ quantityReceived: 0, notes: "" } as any);
                      }}
                    >
                      <PackageCheck size={14} /> Registrar recebimento
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className={styles.emptyState}>
          Nenhuma oportunidade registrada ainda para esta organização.
        </div>
      )}

      <OpportunityCategoryDialog organizationId={organizationId} target={categoryTarget} suggestions={opportunitiesQuery.data?.categorySuggestions ?? []} onClose={() => setCategoryTarget(null)} />

      <Dialog open={!!receiveTarget} onOpenChange={(open) => !open && setReceiveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar recebimento: {receiveTarget?.title}</DialogTitle>
            <DialogDescription>
              Selecione o item do inventário e a quantidade realmente conferida
              — isso gera uma entrada real no estoque, vinculada a esta
              oportunidade.
            </DialogDescription>
          </DialogHeader>
          <Form {...receiveForm}>
            <form
              className={styles.formGrid}
              onSubmit={receiveForm.handleSubmit((data) => receiveMutation.mutate(data))}
            >
              <FormItem name="itemId">
                <FormLabel>Item recebido</FormLabel>
                <FormControl>
                  <Select
                    value={receiveForm.values.itemId ? String(receiveForm.values.itemId) : undefined}
                    onValueChange={(v) => receiveForm.setValues((p: any) => ({ ...p, itemId: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione um item cadastrado" />
                    </SelectTrigger>
                    <SelectContent>
                      {(itemsQuery.data?.items ?? []).map((item) => (
                        <SelectItem key={item.id} value={String(item.id)}>
                          {item.name} ({item.unit})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormControl>
                {itemsQuery.data && itemsQuery.data.items.length === 0 && (
                  <p className={styles.hintText}>
                    Nenhum item cadastrado ainda — cadastre o item no
                    Inventário antes de registrar o recebimento.
                  </p>
                )}
                <FormMessage />
              </FormItem>
              <FormItem name="quantityReceived">
                <FormLabel>Quantidade recebida</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="0.001"
                    value={receiveForm.values.quantityReceived ?? ""}
                    onChange={(e) => receiveForm.setValues((p: any) => ({ ...p, quantityReceived: e.target.value }))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
              <FormItem name="notes">
                <FormLabel>Observações (opcional)</FormLabel>
                <FormControl>
                  <Textarea
                    value={receiveForm.values.notes || ""}
                    onChange={(e) => receiveForm.setValues((p: any) => ({ ...p, notes: e.target.value }))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
              <DialogFooter>
                <Button type="submit" disabled={receiveMutation.isPending}>
                  {receiveMutation.isPending ? "Registrando..." : "Confirmar recebimento"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
