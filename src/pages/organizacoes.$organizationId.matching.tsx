import React, { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getOrganizations } from "../endpoints/organizations_GET.schema";
import { getOrganizationMatchingConfig } from "../endpoints/organization-matching-config_GET.schema";
import { postOrganizationCapacities } from "../endpoints/organization-capacities_POST.schema";
import { postOrganizationCapacitiesDelete } from "../endpoints/organization-capacities-delete_POST.schema";
import { postOrganizationMatchingSettings } from "../endpoints/organization-matching-settings_POST.schema";
import { postOrganizationServiceAreas } from "../endpoints/organization-service-areas_POST.schema";
import { postOrganizationServiceAreasDelete } from "../endpoints/organization-service-areas-delete_POST.schema";
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
import { Switch } from "../components/Switch";
import { UnitSelect } from "../components/UnitSelect";
import { Skeleton } from "../components/Skeleton";
import { ActiveTab } from "../components/ActiveTab";
import { z } from "zod";
import { ArrowLeft, Plus, Warehouse, Truck, MapPin, Pencil, Trash2, Info } from "lucide-react";
import { toast } from "sonner";
import styles from "./organizacoes.$organizationId.matching.module.css";

// Mesma restrição do backend (organization-capacities_POST.schema.ts) —
// duplicada aqui só para feedback imediato no formulário; a validação que
// vale de verdade continua sendo a do servidor.
const capacitySchema = z.object({
  category: z.string().trim().min(1, "Informe a categoria"),
  unit: z.string().trim().min(1, "Informe a unidade"),
  maxCapacity: z.coerce.number().nonnegative("Informe um valor maior ou igual a zero"),
});

const settingsSchema = z.object({
  realizaColeta: z.boolean(),
  raioColetaKm: z.coerce.number().int().positive().optional().nullable(),
  observacoesLogisticas: z.string().max(1000).optional().nullable(),
  observacoesHorarios: z.string().max(1000).optional().nullable(),
});

const serviceAreaSchema = z.object({
  city: z.string().trim().min(2, "Informe a cidade"),
  state: z
    .string()
    .trim()
    .length(2, "Use a sigla do estado, ex: MG")
    .transform((s) => s.toUpperCase()),
});

export default function OrganizationMatchingSettingsPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = Number(params.organizationId);
  const queryClient = useQueryClient();

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => getOrganizations(),
  });
  const org = orgsQuery.data?.organizations.find((o) => o.id === organizationId);
  // Mesma permissão exigida pelo backend (organizacao.gerencie, só
  // proprietario/administrador — ver src/helpers/permissions.tsx). A UI
  // nunca é a autoridade: mesmo que alguém force um botão a aparecer, o
  // endpoint recusa (403) quem não tem a permissão.
  const canManage = org && (org.myRole === "proprietario" || org.myRole === "administrador");

  const configQuery = useQuery({
    queryKey: ["organization-matching-config", organizationId],
    queryFn: () => getOrganizationMatchingConfig({ organizationId }),
    enabled: Number.isFinite(organizationId),
  });

  const invalidateConfig = () => queryClient.invalidateQueries({ queryKey: ["organization-matching-config", organizationId] });

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
        <Link to={`/organizacoes/${organizationId}/oportunidades`} className={styles.tabNavItem}>
          Oportunidades
        </Link>
        <Link to={`/organizacoes/${organizationId}/atribuicoes`} className={styles.tabNavItem}>
          Rede Levora
        </Link>
        <Link to={`/organizacoes/${organizationId}/prestacao-contas`} className={styles.tabNavItem}>
          Prestação de contas
        </Link>
        <ActiveTab className={styles.tabNavItemActive}>Configurações de Matching</ActiveTab>
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
          <h1 className={styles.title}>Configurações de Matching</h1>
          <p className={styles.subtitle}>
            Essas configurações ajudam o sistema a identificar quais organizações têm
            melhores condições de atender cada oportunidade. A capacidade considera o
            estoque atual, a logística considera a realização de coleta, e as áreas de
            atendimento consideram as localidades declaradas.
          </p>
        </div>
      </div>

      {!canManage && org && (
        <div className={styles.infoBanner}>
          <Info size={16} />
          Seu papel nesta organização ({org.myRole}) permite só visualizar estas
          configurações — apenas proprietário e administrador podem alterá-las.
        </div>
      )}

      <CapacitySection
        organizationId={organizationId}
        canManage={!!canManage}
        capacities={configQuery.data?.capacities}
        isLoading={configQuery.isFetching && !configQuery.data}
        onChanged={invalidateConfig}
      />

      <LogisticsSection
        organizationId={organizationId}
        canManage={!!canManage}
        settings={configQuery.data?.settings}
        isLoading={configQuery.isFetching && !configQuery.data}
        onChanged={invalidateConfig}
      />

      <ServiceAreasSection
        organizationId={organizationId}
        canManage={!!canManage}
        serviceAreas={configQuery.data?.serviceAreas}
        isLoading={configQuery.isFetching && !configQuery.data}
        onChanged={invalidateConfig}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Capacidade de armazenamento
// ---------------------------------------------------------------------------

function CapacitySection({
  organizationId,
  canManage,
  capacities,
  isLoading,
  onChanged,
}: {
  organizationId: number;
  canManage: boolean;
  capacities: Array<{ id: number; category: string; unit: string; maxCapacity: number }> | undefined;
  isLoading: boolean;
  onChanged: () => void;
}) {
  const [dialogState, setDialogState] = useState<{ mode: "create" } | { mode: "edit"; id: number; category: string; unit: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; category: string; unit: string } | null>(null);

  const form = useForm({ schema: capacitySchema, defaultValues: { category: "", unit: "", maxCapacity: 0 } });

  const saveMutation = useMutation({
    mutationFn: (data: z.infer<typeof capacitySchema>) => postOrganizationCapacities({ organizationId, ...data }),
    onSuccess: () => {
      onChanged();
      toast.success("Capacidade salva");
      setDialogState(null);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Não foi possível salvar a capacidade"),
  });

  const deleteMutation = useMutation({
    mutationFn: (capacityId: number) => postOrganizationCapacitiesDelete({ organizationId, capacityId }),
    onSuccess: () => {
      onChanged();
      toast.success("Capacidade removida");
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Não foi possível remover a capacidade"),
  });

  function openCreate() {
    form.setValues({ category: "", unit: "", maxCapacity: 0 } as never);
    setDialogState({ mode: "create" });
  }

  function openEdit(cap: { id: number; category: string; unit: string; maxCapacity: number }) {
    form.setValues({ category: cap.category, unit: cap.unit, maxCapacity: cap.maxCapacity } as never);
    setDialogState({ mode: "edit", id: cap.id, category: cap.category, unit: cap.unit });
  }

  const isEditing = dialogState?.mode === "edit";

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div className={styles.sectionHeading}>
          <Warehouse size={18} className={styles.sectionIcon} />
          <h2 className={styles.sectionTitle}>Capacidade de armazenamento</h2>
        </div>
        {canManage && (
          <Dialog open={!!dialogState} onOpenChange={(open) => !open && setDialogState(null)}>
            <DialogTrigger asChild>
              <Button size="sm" onClick={openCreate}>
                <Plus size={16} /> Adicionar capacidade
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{isEditing ? "Editar capacidade" : "Nova capacidade"}</DialogTitle>
                <DialogDescription>
                  A capacidade máxima é um teto declarado — quanto já está em uso vem
                  sempre do estoque real, nunca é editado aqui.
                </DialogDescription>
              </DialogHeader>
              <Form {...form}>
                <form className={styles.formGrid} onSubmit={form.handleSubmit((data) => saveMutation.mutate(data))}>
                  <div className={styles.formRow}>
                    <FormItem name="category" className={styles.formRowItem}>
                      <FormLabel>Categoria</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Alimentos, água, cestas básicas..."
                          disabled={isEditing}
                          value={form.values.category || ""}
                          onChange={(e) => form.setValues((p: any) => ({ ...p, category: e.target.value }))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                    <FormItem name="unit" className={styles.formRowItem}>
                      <FormLabel>Unidade</FormLabel>
                      <FormControl>
                        <UnitSelect disabled={isEditing} value={form.values.unit || ""} onChange={(v) => form.setValues((p: any) => ({ ...p, unit: v }))} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  </div>
                  {isEditing && (
                    <p className={styles.helperText}>
                      Categoria e unidade não podem ser alteradas aqui — elas identificam
                      qual capacidade é esta. Para mudar, remova e cadastre uma nova.
                    </p>
                  )}
                  <FormItem name="maxCapacity">
                    <FormLabel>Capacidade máxima {form.values.unit ? `(${form.values.unit})` : ""}</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.001"
                        min="0"
                        value={form.values.maxCapacity ?? ""}
                        onChange={(e) => form.setValues((p: any) => ({ ...p, maxCapacity: e.target.value }))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                  <DialogFooter>
                    <Button type="submit" disabled={saveMutation.isPending}>
                      {saveMutation.isPending ? "Salvando..." : "Salvar"}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {isLoading ? (
        <Skeleton className={styles.listSkeleton} />
      ) : capacities && capacities.length > 0 ? (
        <ul className={styles.itemList}>
          {capacities.map((cap) => (
            <li key={cap.id} className={styles.itemRow}>
              <div className={styles.itemInfo}>
                <span className={styles.itemPrimary}>{cap.category}</span>
                <span className={styles.itemSecondary}>
                  até {cap.maxCapacity} {cap.unit}
                </span>
              </div>
              {canManage && (
                <div className={styles.itemActions}>
                  <Button variant="ghost" size="icon" aria-label={`Editar capacidade de ${cap.category}`} onClick={() => openEdit(cap)}>
                    <Pencil size={16} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Excluir capacidade de ${cap.category}`}
                    onClick={() => setDeleteTarget({ id: cap.id, category: cap.category, unit: cap.unit })}
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.emptyText}>Nenhuma capacidade de armazenamento configurada.</p>
      )}

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Excluir esta capacidade?</DialogTitle>
            <DialogDescription>
              A capacidade de "{deleteTarget?.category}" ({deleteTarget?.unit}) deixará de
              ser considerada pelo matching. Esta ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {deleteMutation.isPending ? "Excluindo..." : "Excluir"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Capacidade logística
// ---------------------------------------------------------------------------

function LogisticsSection({
  organizationId,
  canManage,
  settings,
  isLoading,
  onChanged,
}: {
  organizationId: number;
  canManage: boolean;
  settings: { realizaColeta: boolean; raioColetaKm: number | null; observacoesLogisticas: string | null; observacoesHorarios: string | null } | null | undefined;
  isLoading: boolean;
  onChanged: () => void;
}) {
  const isConfigured = settings != null;
  const form = useForm({
    schema: settingsSchema,
    defaultValues: {
      realizaColeta: settings?.realizaColeta ?? false,
      raioColetaKm: settings?.raioColetaKm ?? null,
      observacoesLogisticas: settings?.observacoesLogisticas ?? "",
      observacoesHorarios: settings?.observacoesHorarios ?? "",
    },
  });
  // Sincroniza o formulário quando o dado chega/muda vindo do servidor —
  // sem isto, o formulário ficaria travado nos valores padrão iniciais.
  const [syncedKey, setSyncedKey] = useState<string | null>(null);
  const settingsKey = JSON.stringify(settings);
  if (settingsKey !== syncedKey) {
    setSyncedKey(settingsKey);
    form.setValues({
      realizaColeta: settings?.realizaColeta ?? false,
      raioColetaKm: settings?.raioColetaKm ?? null,
      observacoesLogisticas: settings?.observacoesLogisticas ?? "",
      observacoesHorarios: settings?.observacoesHorarios ?? "",
    } as never);
  }

  const saveMutation = useMutation({
    mutationFn: (data: z.infer<typeof settingsSchema>) =>
      postOrganizationMatchingSettings({
        organizationId,
        realizaColeta: data.realizaColeta,
        raioColetaKm: data.raioColetaKm || null,
        observacoesLogisticas: data.observacoesLogisticas || null,
        observacoesHorarios: data.observacoesHorarios || null,
      }),
    onSuccess: () => {
      onChanged();
      toast.success("Configuração de logística salva");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Não foi possível salvar a configuração"),
  });

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeading}>
        <Truck size={18} className={styles.sectionIcon} />
        <h2 className={styles.sectionTitle}>Capacidade logística</h2>
      </div>

      {isLoading ? (
        <Skeleton className={styles.listSkeleton} />
      ) : (
        <>
          {!isConfigured && (
            <p className={styles.emptyText}>A capacidade de coleta ainda não foi configurada.</p>
          )}
          <Form {...form}>
            <form className={styles.formGrid} onSubmit={form.handleSubmit((data) => saveMutation.mutate(data))}>
              <FormItem name="realizaColeta" className={styles.switchRow}>
                <FormLabel>Realiza coleta?</FormLabel>
                <div className={styles.switchControl}>
                  <FormControl>
                    <Switch
                      checked={!!form.values.realizaColeta}
                      onCheckedChange={(checked) => form.setValues((p: any) => ({ ...p, realizaColeta: checked }))}
                      disabled={!canManage}
                    />
                  </FormControl>
                  <span className={styles.switchLabel}>{form.values.realizaColeta ? "Sim" : "Não"}</span>
                </div>
              </FormItem>

              <div className={styles.formRow}>
                <FormItem name="raioColetaKm" className={styles.formRowItem}>
                  <FormLabel>Raio de coleta em km (opcional)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min="1"
                      step="1"
                      placeholder="Ex: 20"
                      disabled={!canManage}
                      value={form.values.raioColetaKm ?? ""}
                      onChange={(e) => form.setValues((p: any) => ({ ...p, raioColetaKm: e.target.value }))}
                    />
                  </FormControl>
                  <p className={styles.helperTextSmall}>Ainda não usado no cálculo — só informativo por enquanto.</p>
                  <FormMessage />
                </FormItem>
              </div>

              <FormItem name="observacoesLogisticas">
                <FormLabel>Observações de logística (opcional)</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="Ex: só realizamos coleta às terças e quintas, precisa de agendamento prévio..."
                    disabled={!canManage}
                    value={form.values.observacoesLogisticas || ""}
                    onChange={(e) => form.setValues((p: any) => ({ ...p, observacoesLogisticas: e.target.value }))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>

              <FormItem name="observacoesHorarios">
                <FormLabel>Observações de horários (opcional)</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="Ex: recebemos doações de segunda a sexta, das 9h às 17h..."
                    disabled={!canManage}
                    value={form.values.observacoesHorarios || ""}
                    onChange={(e) => form.setValues((p: any) => ({ ...p, observacoesHorarios: e.target.value }))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>

              {canManage && (
                <div>
                  <Button type="submit" disabled={saveMutation.isPending}>
                    {saveMutation.isPending ? "Salvando..." : "Salvar configuração"}
                  </Button>
                </div>
              )}
            </form>
          </Form>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Áreas de atendimento
// ---------------------------------------------------------------------------

function ServiceAreasSection({
  organizationId,
  canManage,
  serviceAreas,
  isLoading,
  onChanged,
}: {
  organizationId: number;
  canManage: boolean;
  serviceAreas: Array<{ id: number; city: string; state: string }> | undefined;
  isLoading: boolean;
  onChanged: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; city: string; state: string } | null>(null);
  const form = useForm({ schema: serviceAreaSchema, defaultValues: { city: "", state: "" } });

  const addMutation = useMutation({
    mutationFn: (data: z.infer<typeof serviceAreaSchema>) => postOrganizationServiceAreas({ organizationId, ...data }),
    onSuccess: () => {
      onChanged();
      toast.success("Área de atendimento adicionada");
      setAddOpen(false);
      form.setValues({ city: "", state: "" } as never);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Não foi possível adicionar a área de atendimento"),
  });

  const deleteMutation = useMutation({
    mutationFn: (areaId: number) => postOrganizationServiceAreasDelete({ organizationId, areaId }),
    onSuccess: () => {
      onChanged();
      toast.success("Área de atendimento removida");
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Não foi possível remover a área de atendimento"),
  });

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div className={styles.sectionHeading}>
          <MapPin size={18} className={styles.sectionIcon} />
          <h2 className={styles.sectionTitle}>Áreas de atendimento</h2>
        </div>
        {canManage && (
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus size={16} /> Adicionar área
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Nova área de atendimento</DialogTitle>
              </DialogHeader>
              <Form {...form}>
                <form className={styles.formGrid} onSubmit={form.handleSubmit((data) => addMutation.mutate(data))}>
                  <div className={styles.formRow}>
                    <FormItem name="city" className={styles.formRowItem}>
                      <FormLabel>Cidade</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Contagem"
                          value={form.values.city || ""}
                          onChange={(e) => form.setValues((p: any) => ({ ...p, city: e.target.value }))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                    <FormItem name="state" className={styles.formRowItem}>
                      <FormLabel>UF</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="MG"
                          maxLength={2}
                          value={form.values.state || ""}
                          onChange={(e) => form.setValues((p: any) => ({ ...p, state: e.target.value }))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  </div>
                  <DialogFooter>
                    <Button type="submit" disabled={addMutation.isPending}>
                      {addMutation.isPending ? "Adicionando..." : "Adicionar"}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <p className={styles.helperText}>
        A cidade da sede já é considerada no matching. As áreas abaixo representam
        localidades adicionais atendidas pela organização.
      </p>

      {isLoading ? (
        <Skeleton className={styles.listSkeleton} />
      ) : serviceAreas && serviceAreas.length > 0 ? (
        <ul className={styles.itemList}>
          {serviceAreas.map((area) => (
            <li key={area.id} className={styles.itemRow}>
              <div className={styles.itemInfo}>
                <span className={styles.itemPrimary}>
                  {area.city} / {area.state}
                </span>
              </div>
              {canManage && (
                <div className={styles.itemActions}>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remover área de ${area.city}/${area.state}`}
                    onClick={() => setDeleteTarget(area)}
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.emptyText}>Nenhuma área adicional de atendimento configurada.</p>
      )}

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remover esta área de atendimento?</DialogTitle>
            <DialogDescription>
              "{deleteTarget?.city} / {deleteTarget?.state}" deixará de ser considerada
              pelo matching. Esta ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {deleteMutation.isPending ? "Removendo..." : "Remover"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
