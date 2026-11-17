import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getSources } from "../endpoints/sources_GET.schema";
import { postSources } from "../endpoints/sources_POST.schema";
import { getOpportunityRegistry } from "../endpoints/opportunity-registry_GET.schema";
import { postOpportunityRegistry } from "../endpoints/opportunity-registry_POST.schema";
import { postOpportunityRegistryStatus } from "../endpoints/opportunity-registry-status_POST.schema";
import { postOpportunityAllocations } from "../endpoints/opportunity-allocations_POST.schema";
import { getAssignmentSettings } from "../endpoints/assignment-settings_GET.schema";
import { postAssignmentSettings } from "../endpoints/assignment-settings_POST.schema";
import { getOpportunityAllocationRefusals } from "../endpoints/opportunity-allocation-refusals_GET.schema";
import { Checkbox } from "../components/Checkbox";
import { getNeeds } from "../endpoints/needs_GET.schema";
import { postOpportunityRegistryMatch } from "../endpoints/opportunity-registry-match_POST.schema";
import { getMatchEvaluations } from "../endpoints/match-evaluations_GET.schema";
import { getBackgroundTasks } from "../endpoints/background-tasks_GET.schema";
import { postBackgroundTasksRetry } from "../endpoints/background-tasks-retry_POST.schema";
import { getPlatformOrganizations } from "../endpoints/platform-organizations_GET.schema";
import { postPlatformOrganizationsStatus } from "../endpoints/platform-organizations-status_POST.schema";
import { StepUpDialog } from "../components/StepUpDialog";
import { AccessCodesPanel } from "../components/AccessCodesPanel";
import { ApiRequestError } from "../helpers/apiRequestError";
import { SourceTypeArrayValues } from "../helpers/schema";
import { newSourceSchema, newDiscoverySchema } from "../helpers/platformFormSchemas";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from "../components/Dialog";
import { Form, FormControl, FormItem, FormLabel, FormMessage, useForm } from "../components/Form";
import { Input } from "../components/Input";
import { UnitSelect } from "../components/UnitSelect";
import { PlatformUnitRegularizationSection } from "../components/PlatformUnitRegularization";
import { FileScanOperationsPanel } from "../components/FileScanOperationsPanel";
import { AutomationControlsPanel } from "../components/AutomationControlsPanel";
import { PlatformLimitsPanel } from "../components/PlatformLimitsPanel";
import { Textarea } from "../components/Textarea";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { Skeleton } from "../components/Skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/Select";
import { z } from "zod";
import { HeartHandshake, Radio, Search, Send, AlertTriangle, Sparkles, ListChecks, RefreshCw, Pencil, Clock } from "lucide-react";
import { RenameSourceDialog } from "../components/RenameSourceDialog";
import { toast } from "sonner";
import styles from "./plataforma.module.css";

const sourceTypeLabels: Record<string, string> = {
  manual: "Manual", site_publico: "Site público", pesquisa_externa: "Pesquisa externa",
  pagina_empresarial: "Página empresarial", facebook_meta: "Facebook/Meta", x_twitter: "X",
  email_autorizado: "E-mail autorizado", formulario: "Formulário", outro: "Outro",
};

const sourceStatusLabels: Record<string, string> = {
  ativa: "Ativa", pausada: "Pausada", nao_configurada: "Conector não configurado", erro: "Erro", desativada: "Desativada",
};

const registryStatusLabels: Record<string, string> = {
  descoberta: "Descoberta", em_verificacao: "Em verificação", validada: "Validada",
  aguardando_destinacao: "Aguardando destinação", reservada: "Reservada", atribuida: "Atribuída",
  aguardando_coleta: "Aguardando coleta", em_transporte: "Em transporte", recebida: "Recebida",
  concluida: "Concluída", recusada: "Recusada", expirada: "Expirada", cancelada: "Cancelada",
  bloqueada: "Bloqueada", duplicada: "Duplicada",
};

const curatableStatuses = ["em_verificacao", "validada", "aguardando_destinacao", "recusada", "expirada", "cancelada", "bloqueada", "duplicada"] as const;



const allocationSchema = z.object({
  organizationId: z.coerce.number().int().positive(), quantityAllocated: z.coerce.number().positive(), notes: z.string().optional(),
  // Opcional (Fase 45): escolhida explicitamente aqui, nunca inferida —
  // ver seletor de need abaixo, que só lista needs elegíveis
  // (status='aberta' AND requiredRemaining>0) da organização selecionada.
  needId: z.coerce.number().int().positive().optional(),
});

export default function PlatformPage() {
  const queryClient = useQueryClient();
  const [newSourceOpen, setNewSourceOpen] = useState(false);
  const [newDiscoveryOpen, setNewDiscoveryOpen] = useState(false);
  const [renameSource, setRenameSource] = useState<{ id: number; name: string } | null>(null);
  const [allocateTarget, setAllocateTarget] = useState<{ id: number; title: string } | null>(null);
  const [expandedEvalId, setExpandedEvalId] = useState<number | null>(null);

  const sourcesQuery = useQuery({ queryKey: ["sources"], queryFn: () => getSources() });
  const registryQuery = useQuery({ queryKey: ["opportunity-registry"], queryFn: () => getOpportunityRegistry({}) });
  const orgsQuery = useQuery({ queryKey: ["platform-organizations"], queryFn: () => getPlatformOrganizations() });

  const evalQuery = useQuery({
    queryKey: ["match-evaluations", expandedEvalId],
    queryFn: () => getMatchEvaluations({ opportunityId: expandedEvalId! }),
    enabled: expandedEvalId !== null,
  });

  const tasksQuery = useQuery({ queryKey: ["background-tasks"], queryFn: () => getBackgroundTasks() });

  const matchMutation = useMutation({
    mutationFn: (opportunityId: number) => postOpportunityRegistryMatch({ opportunityId }),
    onSuccess: (result, opportunityId) => {
      queryClient.invalidateQueries({ queryKey: ["opportunity-registry"] });
      if (expandedEvalId === opportunityId) queryClient.invalidateQueries({ queryKey: ["match-evaluations", opportunityId] });
      toast.success(result.skipped ? `Matching não rodou: ${result.reason}` : `Matching rodou: ${result.allocationsCreated.length} atribuição(ões) criada(s), ${result.discarded.length} descartada(s)`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao rodar matching"),
  });

  const retryTaskMutation = useMutation({
    mutationFn: (runId: number) => postBackgroundTasksRetry({ runId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["background-tasks"] });
      toast.success("Tarefa reprocessada");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao reprocessar"),
  });

  const orgStatusMutation = useMutation({
    mutationFn: (vars: { organizationId: number; status: "ativa" | "suspensa" | "em_analise" }) => postPlatformOrganizationsStatus(vars),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["platform-organizations"] });
      toast.success("Status da organização atualizado");
    },
    onError: (err, vars) => {
      // Step-up (Fase 90): ação crítica sem MFA recente → pede o código do autenticador e REPETE a ação.
      if (err instanceof ApiRequestError && err.code === "reauth_required") {
        setStepUpRetry(vars);
        return;
      }
      toast.error(err instanceof Error ? err.message : "Falha ao atualizar organização");
    },
  });
  const [stepUpRetry, setStepUpRetry] = useState<{ organizationId: number; status: "ativa" | "suspensa" | "em_analise" } | null>(null);

  const activeSources = (sourcesQuery.data?.sources ?? []).filter((s) => s.status === "ativa");

  const sourceForm = useForm({ schema: newSourceSchema, defaultValues: { name: "", connectorKey: "manual" } });
  const createSourceMutation = useMutation({
    mutationFn: (data: z.infer<typeof newSourceSchema>) => postSources(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      toast.success("Fonte cadastrada");
      setNewSourceOpen(false);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao cadastrar fonte"),
  });

  const discoveryForm = useForm({ schema: newDiscoverySchema, defaultValues: { title: "", urgency: "media" as const } });
  const createDiscoveryMutation = useMutation({
    mutationFn: (data: z.infer<typeof newDiscoverySchema>) => postOpportunityRegistry(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["opportunity-registry"] });
      toast.success("Descoberta registrada");
      setNewDiscoveryOpen(false);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao registrar descoberta"),
  });

  const statusMutation = useMutation({
    mutationFn: (vars: { opportunityId: number; status: (typeof curatableStatuses)[number] }) =>
      postOpportunityRegistryStatus(vars),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["opportunity-registry"] });
      const closed = data.closedProposals ?? 0;
      toast.success(closed > 0 ? `Status atualizado. ${closed} proposta(s) pendente(s) encerrada(s) junto com a oferta.` : "Status atualizado");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao atualizar status"),
  });

  const allocationForm = useForm({ schema: allocationSchema, defaultValues: { quantityAllocated: 0, notes: "" } });
  const allocationOrgId = allocationForm.values.organizationId ? Number(allocationForm.values.organizationId) : undefined;

  // Fase 98 — aviso de recusa anterior: consulta SEMPRE ao servidor (sem cache) quando uma organização é escolhida; o servidor também exige a confirmação.
  const [confirmPriorRefusal, setConfirmPriorRefusal] = useState(false);
  const refusalsQuery = useQuery({
    queryKey: ["allocation-refusals", allocateTarget?.id, allocationOrgId],
    queryFn: () => getOpportunityAllocationRefusals({ opportunityId: allocateTarget!.id, organizationId: allocationOrgId! }),
    enabled: !!allocateTarget && !!allocationOrgId,
    staleTime: 0,
    gcTime: 0,
  });
  const priorRefusals = refusalsQuery.data?.refusals ?? [];
  const refusalCheckPending = !!allocationOrgId && (refusalsQuery.isFetching || refusalsQuery.isError);
  const needsConfirmation = priorRefusals.length > 0;

  // Fase 98 — prazo global das atribuições automáticas (72 h por padrão).
  const settingsQuery = useQuery({ queryKey: ["assignment-settings"], queryFn: () => getAssignmentSettings() });
  const [hoursInput, setHoursInput] = useState<string>("");
  const settingsMutation = useMutation({
    mutationFn: (hours: number) => postAssignmentSettings({ responseDeadlineHours: hours }),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["assignment-settings"] });
      setHoursInput("");
      toast.success(r.changed ? `Prazo atualizado para ${r.responseDeadlineHours} h (vale para as novas atribuições automáticas).` : "O prazo já estava com este valor.");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Não foi possível salvar o prazo"),
  });

  // Needs elegíveis para vínculo (Fase 45): reaproveita o mesmo endpoint e
  // os mesmos campos derivados (fulfilled/requiredRemaining/surplus) já
  // implementados na Fase 42 — nenhum cálculo de progresso paralelo aqui.
  // Filtro de elegibilidade (status='aberta' AND requiredRemaining>0) é a
  // MESMA regra já aprovada no Matching 1.4 (Fase 43), aplicada aqui só
  // sobre campos que o servidor já calculou — não é uma inferência nova,
  // é filtrar dado já pronto.
  const needsForAllocationQuery = useQuery({
    queryKey: ["needs", allocationOrgId],
    queryFn: () => getNeeds({ organizationId: allocationOrgId! }),
    enabled: !!allocationOrgId,
  });
  const eligibleNeeds = (needsForAllocationQuery.data?.needs ?? []).filter((n) => n.status === "aberta" && n.requiredRemaining > 0);

  const allocateMutation = useMutation({
    mutationFn: (data: z.infer<typeof allocationSchema>) =>
      postOpportunityAllocations({ opportunityId: allocateTarget!.id, ...data, ...(confirmPriorRefusal ? { confirmPriorRefusal: true } : {}) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["opportunity-registry"] });
      toast.success("Atribuição proposta à organização");
      setConfirmPriorRefusal(false);
      setAllocateTarget(null);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao atribuir"),
  });

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <HeartHandshake size={22} className={styles.brandIcon} />
        <span className={styles.brandName}>Levora Solidária — Operação de plataforma</span>
      </header>

      <main className={styles.main}>
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}><Radio size={18} /> Registro de fontes</h2>
            <Dialog open={newSourceOpen} onOpenChange={setNewSourceOpen}>
              <DialogTrigger asChild><Button size="sm">Nova fonte</Button></DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Cadastrar fonte</DialogTitle>
                  <DialogDescription>
                    Só a fonte com conector "manual" nasce ativa. Qualquer outro
                    tipo nasce "Conector não configurado" até uma integração real
                    ser implementada e conectada — isso é decidido pelo servidor,
                    não pode ser contornado aqui.
                  </DialogDescription>
                </DialogHeader>
                <Form {...sourceForm}>
                  <form className={styles.formGrid} onSubmit={sourceForm.handleSubmit((d) => createSourceMutation.mutate(d))}>
                    <FormItem name="name">
                      <FormLabel>Nome</FormLabel>
                      <FormControl><Input value={sourceForm.values.name || ""} onChange={(e) => sourceForm.setValues((p: any) => ({ ...p, name: e.target.value }))} /></FormControl>
                      <FormMessage />
                    </FormItem>
                    <FormItem name="type">
                      <FormLabel>Tipo</FormLabel>
                      <FormControl>
                        <Select value={sourceForm.values.type} onValueChange={(v) => sourceForm.setValues((p: any) => ({ ...p, type: v }))}>
                          <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                          <SelectContent>
                            {SourceTypeArrayValues.map((t) => <SelectItem key={t} value={t}>{sourceTypeLabels[t]}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                    <FormItem name="connectorKey">
                      <FormLabel>Chave do conector</FormLabel>
                      <FormControl><Input placeholder="manual" value={sourceForm.values.connectorKey || ""} onChange={(e) => sourceForm.setValues((p: any) => ({ ...p, connectorKey: e.target.value }))} /></FormControl>
                      <FormMessage />
                    </FormItem>
                    <FormItem name="endpointOrAddress">
                      <FormLabel>Endereço (opcional)</FormLabel>
                      <FormControl><Input value={sourceForm.values.endpointOrAddress || ""} onChange={(e) => sourceForm.setValues((p: any) => ({ ...p, endpointOrAddress: e.target.value }))} /></FormControl>
                      <FormMessage />
                    </FormItem>
                    <DialogFooter>
                      <Button type="submit" disabled={createSourceMutation.isPending}>{createSourceMutation.isPending ? "Cadastrando..." : "Cadastrar"}</Button>
                    </DialogFooter>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          </div>

          {sourcesQuery.isFetching && !sourcesQuery.data ? <Skeleton className={styles.listSkeleton} /> : (
            <ul className={styles.sourceList}>
              {(sourcesQuery.data?.sources ?? []).map((s) => (
                <li key={s.id} className={styles.sourceRow}>
                  <div>
                    <div className={styles.sourceName}>{s.name}</div>
                    <div className={styles.sourceMeta}>{sourceTypeLabels[s.type]} · conector: {s.connectorKey}</div>
                  </div>
                  <div className={styles.sourceActions}>
                    <Button variant="ghost" size="icon-sm" onClick={() => setRenameSource({ id: s.id, name: s.name })} aria-label={"Renomear a fonte " + s.name}>
                      <Pencil size={14} />
                    </Button>
                    <Badge variant={s.status === "ativa" ? "success" : s.status === "erro" ? "destructive" : "secondary"}>
                      {s.status === "nao_configurada" && <AlertTriangle size={12} />} {sourceStatusLabels[s.status]}
                    </Badge>
                  </div>
                </li>
              ))}
              <RenameSourceDialog source={renameSource} onOpenChange={(open) => !open && setRenameSource(null)} />
              {sourcesQuery.data && sourcesQuery.data.sources.length === 0 && (
                <p className={styles.emptyText}>Nenhuma fonte cadastrada. Cadastre a fonte "manual" para começar a registrar descobertas.</p>
              )}
            </ul>
          )}
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}><ListChecks size={18} /> Organizações</h2>
          <p className={styles.emptyText} style={{ marginBottom: "0.75rem" }}>
            Só organizações "ativa" entram como candidatas no motor de
            correspondência. Toda organização nasce "em análise".
          </p>
          {orgsQuery.isFetching && !orgsQuery.data ? <Skeleton className={styles.listSkeleton} /> : (
            <ul className={styles.sourceList}>
              {(orgsQuery.data?.organizations ?? []).map((o) => (
                <li key={o.id} className={styles.sourceRow}>
                  <div>
                    <div className={styles.sourceName}>{o.name}</div>
                    <div className={styles.sourceMeta}>{o.city}/{o.state}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <Badge variant={o.status === "ativa" ? "success" : o.status === "suspensa" ? "destructive" : "secondary"}>{o.status}</Badge>
                    {o.status !== "ativa" && (
                      <Button size="sm" onClick={() => orgStatusMutation.mutate({ organizationId: o.id, status: "ativa" })}>Aprovar</Button>
                    )}
                    {o.status === "ativa" && (
                      <Button size="sm" variant="outline" onClick={() => orgStatusMutation.mutate({ organizationId: o.id, status: "suspensa" })}>Suspender</Button>
                    )}
                  </div>
                </li>
              ))}
              {orgsQuery.data && orgsQuery.data.organizations.length === 0 && <p className={styles.emptyText}>Nenhuma organização cadastrada ainda.</p>}
            </ul>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}><Search size={18} /> Registro central de oportunidades</h2>
            <Dialog open={newDiscoveryOpen} onOpenChange={setNewDiscoveryOpen}>
              <DialogTrigger asChild>
                <Button size="sm" disabled={activeSources.length === 0}>Nova descoberta</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Registrar descoberta</DialogTitle>
                  <DialogDescription>
                    A Levora nunca é dona física do item — esta descoberta só vira
                    responsabilidade de alguém quando você a atribuir a uma
                    organização.
                  </DialogDescription>
                </DialogHeader>
                <Form {...discoveryForm}>
                  <form className={styles.formGrid} onSubmit={discoveryForm.handleSubmit((d) => createDiscoveryMutation.mutate(d))}>
                    <FormItem name="sourceId">
                      <FormLabel>Fonte</FormLabel>
                      <FormControl>
                        <Select value={discoveryForm.values.sourceId ? String(discoveryForm.values.sourceId) : undefined} onValueChange={(v) => discoveryForm.setValues((p: any) => ({ ...p, sourceId: v }))}>
                          <SelectTrigger><SelectValue placeholder="Selecione uma fonte ativa" /></SelectTrigger>
                          <SelectContent>
                            {activeSources.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                    <FormItem name="title">
                      <FormLabel>O que foi descoberto</FormLabel>
                      <FormControl><Input value={discoveryForm.values.title || ""} onChange={(e) => discoveryForm.setValues((p: any) => ({ ...p, title: e.target.value }))} /></FormControl>
                      <FormMessage />
                    </FormItem>
                    <div className={styles.formRow}>
                      <FormItem name="quantity" className={styles.formRowItem}>
                        <FormLabel>Quantidade</FormLabel>
                        <FormControl><Input type="number" step="0.001" value={discoveryForm.values.quantity ?? ""} onChange={(e) => discoveryForm.setValues((p: any) => ({ ...p, quantity: e.target.value }))} /></FormControl>
                        <FormMessage />
                      </FormItem>
                      <FormItem name="unit" className={styles.formRowItem}>
                        <FormLabel>Unidade</FormLabel>
                        <FormControl><UnitSelect allowEmpty value={discoveryForm.values.unit || ""} onChange={(v) => discoveryForm.setValues((p: any) => ({ ...p, unit: v }))} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    </div>
                    <div className={styles.formRow}>
                      <FormItem name="locationCity" className={styles.formRowItem}>
                        <FormLabel>Cidade</FormLabel>
                        <FormControl><Input value={discoveryForm.values.locationCity || ""} onChange={(e) => discoveryForm.setValues((p: any) => ({ ...p, locationCity: e.target.value }))} /></FormControl>
                      </FormItem>
                      <FormItem name="locationState" className={styles.formRowItem}>
                        <FormLabel>UF</FormLabel>
                        <FormControl><Input maxLength={2} value={discoveryForm.values.locationState || ""} onChange={(e) => discoveryForm.setValues((p: any) => ({ ...p, locationState: e.target.value.toUpperCase() }))} /></FormControl>
                      </FormItem>
                    </div>
                    <FormItem name="originContact">
                      <FormLabel>Contato de origem (opcional)</FormLabel>
                      <FormControl><Input value={discoveryForm.values.originContact || ""} onChange={(e) => discoveryForm.setValues((p: any) => ({ ...p, originContact: e.target.value }))} /></FormControl>
                    </FormItem>
                    <FormItem name="description">
                      <FormLabel>Descrição (opcional)</FormLabel>
                      <FormControl><Textarea value={discoveryForm.values.description || ""} onChange={(e) => discoveryForm.setValues((p: any) => ({ ...p, description: e.target.value }))} /></FormControl>
                    </FormItem>
                    <DialogFooter>
                      <Button type="submit" disabled={createDiscoveryMutation.isPending}>{createDiscoveryMutation.isPending ? "Registrando..." : "Registrar descoberta"}</Button>
                    </DialogFooter>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          </div>
          {activeSources.length === 0 && (
            <p className={styles.emptyText}>Nenhuma fonte ativa ainda — cadastre a fonte "manual" acima primeiro.</p>
          )}

          {registryQuery.isFetching && !registryQuery.data ? <Skeleton className={styles.listSkeleton} /> : (
            <ul className={styles.registryList}>
              {(registryQuery.data?.opportunities ?? []).map((o) => {
                const isFinal = ["concluida", "recusada", "expirada", "cancelada", "bloqueada", "duplicada"].includes(o.status);
                const canAllocate = ["validada", "aguardando_destinacao", "reservada"].includes(o.status);
                return (
                  <li key={o.id} className={styles.registryRow}>
                    <div className={styles.registryHeaderRow}>
                      <h3 className={styles.registryTitle}>{o.title}</h3>
                      <Badge variant={o.status === "concluida" ? "success" : isFinal ? "destructive" : "outline"}>
                        {registryStatusLabels[o.status]}
                      </Badge>
                    </div>
                    <p className={styles.registryMeta}>
                      Fonte: {o.sourceName}
                      {o.quantity ? ` · ${o.quantity} ${o.unit ?? ""} (${o.allocatedQuantity} já atribuído)` : ""}
                      {o.locationCity ? ` · ${o.locationCity}/${o.locationState ?? ""}` : ""}
                    </p>
                    {!isFinal && (
                      <div className={styles.registryActions}>
                        <Select value={o.status} onValueChange={(v) => statusMutation.mutate({ opportunityId: o.id, status: v as (typeof curatableStatuses)[number] })}>
                          <SelectTrigger className={styles.statusSelect}><SelectValue>{registryStatusLabels[o.status] ?? o.status}</SelectValue></SelectTrigger>
                          <SelectContent>
                            {curatableStatuses.map((s) => <SelectItem key={s} value={s}>{registryStatusLabels[s]}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        {canAllocate && (
                          <>
                            <Button size="sm" variant="secondary" onClick={() => matchMutation.mutate(o.id)} disabled={matchMutation.isPending}>
                              <Sparkles size={14} /> Rodar matching agora
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => { setAllocateTarget({ id: o.id, title: o.title }); allocationForm.setValues({ quantityAllocated: 0, notes: "" } as any); }}>
                              <Send size={14} /> Atribuir manualmente
                            </Button>
                          </>
                        )}
                        <Button size="sm" variant="outline" onClick={() => setExpandedEvalId(expandedEvalId === o.id ? null : o.id)}>
                          <ListChecks size={14} /> {expandedEvalId === o.id ? "Ocultar" : "Ver"} avaliações de matching
                        </Button>
                      </div>
                    )}
                    {expandedEvalId === o.id && (
                      <div className={styles.evalBox}>
                        {evalQuery.isFetching && !evalQuery.data ? <Skeleton className={styles.listSkeleton} /> : (
                          (evalQuery.data?.evaluations ?? []).length === 0 ? (
                            <p className={styles.emptyText}>Nenhuma avaliação de matching ainda para esta descoberta.</p>
                          ) : (
                            <ul className={styles.evalList}>
                              {evalQuery.data!.evaluations.map((ev) => (
                                <li key={ev.id} className={styles.evalRow}>
                                  <div className={styles.evalHeaderRow}>
                                    <strong>{ev.organizationName}</strong>
                                    <Badge variant={ev.decision === "atribuido_automatico" ? "success" : ev.decision === "proposto" ? "outline" : "secondary"}>
                                      {ev.decision} · {ev.finalScore}%
                                    </Badge>
                                  </div>
                                  <div className={styles.evalMeta}>
                                    necessidade: {ev.needTitle ?? "—"} · algoritmo v{ev.algorithmVersion}
                                    {ev.aiModelUsed ? ` · IA usada: ${ev.aiModelUsed}` : ""} · {new Date(ev.createdAt).toLocaleString("pt-BR")}
                                  </div>
                                  <pre className={styles.evalCriteria}>{JSON.stringify(ev.criteria, null, 2)}</pre>
                                </li>
                              ))}
                            </ul>
                          )
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
              {registryQuery.data && registryQuery.data.opportunities.length === 0 && (
                <p className={styles.emptyText}>Nenhuma descoberta registrada ainda.</p>
              )}
            </ul>
          )}
        </section>

        <section className={styles.section} aria-labelledby="prazo-titulo">
          <h2 id="prazo-titulo" className={styles.sectionTitle}><Clock size={18} /> Prazo das atribuições automáticas</h2>
          {settingsQuery.isFetching && !settingsQuery.data ? <Skeleton className={styles.listSkeleton} style={{ height: "4rem" }} /> : settingsQuery.isError ? (
            <p className={styles.emptyText} role="alert">Não foi possível carregar o prazo. {settingsQuery.error instanceof Error ? settingsQuery.error.message : ""}</p>
          ) : (
            <>
              <p className={styles.emptyText} style={{ marginBottom: "0.75rem" }}>
                Prazo atual: <strong>{settingsQuery.data?.responseDeadlineHours} horas</strong>{settingsQuery.data?.isDefault ? " (padrão)" : ""}. É o mesmo para todas as
                organizações. Vale para as <strong>novas</strong> atribuições automáticas de alta compatibilidade: as já criadas mantêm o vencimento que receberam.
                Sem movimentação (coleta, transporte ou recebimento) até o vencimento, a atribuição é encerrada, a oportunidade volta para outras organizações e a mesma
                organização fica {settingsQuery.data?.reassignmentPauseDays} dias sem ser escolhida automaticamente para aquela oportunidade. Expirar não é recusar.
              </p>
              <form
                className={styles.formGrid}
                style={{ maxWidth: "20rem" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const n = Number(hoursInput);
                  if (!Number.isInteger(n)) { toast.error("Informe um número inteiro de horas"); return; }
                  settingsMutation.mutate(n);
                }}
              >
                <label htmlFor="prazo-horas" style={{ fontSize: "0.875rem", fontWeight: 500 }}>Novo prazo, em horas ({settingsQuery.data?.minHours}–{settingsQuery.data?.maxHours})</label>
                <Input id="prazo-horas" type="number" inputMode="numeric" min={settingsQuery.data?.minHours} max={settingsQuery.data?.maxHours} step={1} value={hoursInput} onChange={(e) => setHoursInput(e.target.value)} placeholder={String(settingsQuery.data?.responseDeadlineHours ?? 72)} />
                <Button type="submit" size="sm" disabled={settingsMutation.isPending || hoursInput === ""}>{settingsMutation.isPending ? "Salvando..." : "Salvar prazo"}</Button>
              </form>
            </>
          )}
        </section>

        <PlatformUnitRegularizationSection />

        <FileScanOperationsPanel />

        <AutomationControlsPanel scope="plataforma" canManage />

        <PlatformLimitsPanel />

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}><RefreshCw size={18} /> Tarefas de fundo</h2>
          <p className={styles.emptyText} style={{ marginBottom: "0.75rem" }}>
            Histórico real de execução (expirar oportunidades vencidas, expirar
            reservas de matching automático, varredura periódica de matching).
            O agendamento automático depende da configuração do servidor: tarefas
            opcionais, como o processamento de eventos dos agentes, ficam
            desligadas até a plataforma habilitá-las explicitamente, e o
            reprocessamento de uma delas é recusado enquanto estiver desligada.
            Aqui embaixo está o histórico de execuções já ocorridas.
          </p>
          {tasksQuery.isFetching && !tasksQuery.data ? <Skeleton className={styles.listSkeleton} /> : (
            <ul className={styles.sourceList}>
              {(tasksQuery.data?.runs ?? []).map((r) => (
                <li key={r.id} className={styles.sourceRow}>
                  <div>
                    <div className={styles.sourceName}>{r.taskName}</div>
                    <div className={styles.sourceMeta}>
                      tentativa {r.attemptCount}/{r.maxAttempts} · {new Date(r.createdAt).toLocaleString("pt-BR")}
                      {r.error ? ` · erro: ${JSON.stringify(r.error)}` : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <Badge variant={r.status === "concluida" ? "success" : r.status === "falhou" ? "destructive" : "secondary"}>{r.status}</Badge>
                    {r.status === "falhou" && (
                      <Button size="sm" variant="outline" onClick={() => retryTaskMutation.mutate(Number(r.id))} disabled={retryTaskMutation.isPending}>
                        Reprocessar
                      </Button>
                    )}
                  </div>
                </li>
              ))}
              {tasksQuery.data && tasksQuery.data.runs.length === 0 && (
                <p className={styles.emptyText}>Nenhuma execução registrada ainda.</p>
              )}
            </ul>
          )}
        </section>
        <AccessCodesPanel />
      </main>

      <Dialog open={!!allocateTarget} onOpenChange={(open) => { if (!open) { setAllocateTarget(null); setConfirmPriorRefusal(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Atribuir: {allocateTarget?.title}</DialogTitle>
            <DialogDescription>Uma oportunidade pode ser dividida entre várias organizações — atribua o quanto fizer sentido para cada uma.</DialogDescription>
          </DialogHeader>
          <Form {...allocationForm}>
            <form className={styles.formGrid} onSubmit={allocationForm.handleSubmit((d) => allocateMutation.mutate(d))}>
              <FormItem name="organizationId">
                <FormLabel>Organização</FormLabel>
                <FormControl>
                  <Select
                    value={allocationForm.values.organizationId ? String(allocationForm.values.organizationId) : undefined}
                    onValueChange={(v) => { setConfirmPriorRefusal(false); allocationForm.setValues((p: any) => ({ ...p, organizationId: v, needId: undefined })); }}
                  >
                    <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                    <SelectContent>
                      {(orgsQuery.data?.organizations ?? []).map((o) => <SelectItem key={o.id} value={String(o.id)}>{o.name} ({o.city}/{o.state})</SelectItem>)}
                    </SelectContent>
                  </Select>
                </FormControl>
                <FormMessage />
              </FormItem>
              {allocationOrgId && refusalsQuery.isError && (
                <p className={styles.emptyText} role="alert">
                  Não foi possível verificar o histórico de recusas desta organização. Tente novamente antes de atribuir.{" "}
                  <Button type="button" size="sm" variant="outline" onClick={() => refusalsQuery.refetch()}>Verificar de novo</Button>
                </p>
              )}
              {allocationOrgId && needsConfirmation && (
                <div role="alert" style={{ border: "1px solid var(--warning)", borderRadius: "var(--radius-md)", padding: "0.75rem", background: "var(--surface)", fontSize: "0.875rem", lineHeight: 1.5 }}>
                  <p style={{ margin: 0, fontWeight: 600 }}><AlertTriangle size={14} aria-hidden="true" style={{ verticalAlign: "-2px" }} /> Esta organização já recusou ou cancelou esta oportunidade</p>
                  <p style={{ margin: "0.25rem 0" }}>
                    Oportunidade: <strong>{allocateTarget?.title}</strong>. {priorRefusals.map((r) => `${r.kind === "recusada" ? "Recusou" : "Cancelou"} em ${new Date(r.occurredAt).toLocaleString("pt-BR")}`).join("; ")}.
                    O matching automático não a escolhe de novo; atribuir manualmente é uma <strong>exceção administrativa</strong>, que fica registrada na auditoria.
                  </p>
                  <label style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", cursor: "pointer" }}>
                    <Checkbox checked={confirmPriorRefusal} onChange={(e) => setConfirmPriorRefusal(e.target.checked)} aria-describedby="confirmar-recusa-ajuda" />
                    <span id="confirmar-recusa-ajuda">Entendo e quero atribuir mesmo assim.</span>
                  </label>
                </div>
              )}
              {allocationOrgId && (
                <FormItem name="needId">
                  <FormLabel>Necessidade (opcional)</FormLabel>
                  <FormControl>
                    {needsForAllocationQuery.isFetching && !needsForAllocationQuery.data ? (
                      <Skeleton className={styles.listSkeleton} style={{ height: "2.25rem" }} />
                    ) : eligibleNeeds.length === 0 ? (
                      <p className={styles.emptyText}>Esta organização não possui necessidades abertas com saldo pendente.</p>
                    ) : (
                      <Select
                        value={allocationForm.values.needId ? String(allocationForm.values.needId) : "none"}
                        onValueChange={(v) => allocationForm.setValues((p: any) => ({ ...p, needId: v === "none" ? undefined : v }))}
                      >
                        <SelectTrigger><SelectValue placeholder="Nenhuma" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Nenhuma</SelectItem>
                          {eligibleNeeds.map((n) => (
                            <SelectItem key={n.id} value={String(n.id)}>
                              {n.title} — necessária: {n.quantityNeeded}{n.unit} · recebido: {n.fulfilled}{n.unit} · faltam: {n.requiredRemaining}{n.unit}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
              <FormItem name="quantityAllocated">
                <FormLabel>Quantidade atribuída</FormLabel>
                <FormControl><Input type="number" step="0.001" value={allocationForm.values.quantityAllocated ?? ""} onChange={(e) => allocationForm.setValues((p: any) => ({ ...p, quantityAllocated: e.target.value }))} /></FormControl>
                <FormMessage />
              </FormItem>
              <FormItem name="notes">
                <FormLabel>Observações (opcional)</FormLabel>
                <FormControl><Textarea value={allocationForm.values.notes || ""} onChange={(e) => allocationForm.setValues((p: any) => ({ ...p, notes: e.target.value }))} /></FormControl>
              </FormItem>
              <DialogFooter>
                <Button type="submit" disabled={allocateMutation.isPending || refusalCheckPending || (needsConfirmation && !confirmPriorRefusal)}>{allocateMutation.isPending ? "Enviando..." : refusalCheckPending && refusalsQuery.isFetching ? "Verificando histórico..." : "Propor atribuição"}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <StepUpDialog
        open={stepUpRetry !== null}
        onOpenChange={(open) => !open && setStepUpRetry(null)}
        onConfirmed={() => {
          const vars = stepUpRetry;
          setStepUpRetry(null);
          if (vars) orgStatusMutation.mutate(vars);
        }}
      />
    </div>
  );
}
