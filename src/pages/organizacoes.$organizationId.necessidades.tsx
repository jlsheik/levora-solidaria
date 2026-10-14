import React, { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getOrganizations } from "../endpoints/organizations_GET.schema";
import { getNeeds } from "../endpoints/needs_GET.schema";
import { postNeeds } from "../endpoints/needs_POST.schema";
import { postNeedsStatus } from "../endpoints/needs-status_POST.schema";
import { getInventoryItems } from "../endpoints/inventory-items_GET.schema";
import { NeedPriorityArrayValues, NeedStatusArrayValues } from "../helpers/schema";
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
import { Skeleton } from "../components/Skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/Select";
import { z } from "zod";
import { ArrowLeft, Plus, ClipboardList, Pencil } from "lucide-react";
import { EditNeedDialog, type EditableNeed } from "../components/EditNeedDialog";
import { toast } from "sonner";
import styles from "./organizacoes.$organizationId.necessidades.module.css";

const priorityLabels: Record<string, string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
  critica: "Crítica",
};

const priorityVariant: Record<string, "secondary" | "outline" | "destructive" | "success"> = {
  baixa: "secondary",
  media: "outline",
  alta: "destructive",
  critica: "destructive",
};

const statusLabels: Record<string, string> = {
  aberta: "Aberta",
  atendida: "Atendida",
  cancelada: "Cancelada",
};

const newNeedSchema = z.object({
  title: z.string().min(3, "Informe um título"),
  description: z.string().optional(),
  itemId: z.coerce.number().int().positive().optional(),
  quantityNeeded: z.coerce.number().positive("Informe uma quantidade maior que zero"),
  unit: z.string().min(1, "Informe a unidade"),
  priority: z.enum(NeedPriorityArrayValues).default("media"),
});

export default function NeedsPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = Number(params.organizationId);
  const queryClient = useQueryClient();
  const [editNeed, setEditNeed] = useState<EditableNeed | null>(null);
  const [newNeedOpen, setNewNeedOpen] = useState(false);

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => getOrganizations(),
  });
  const org = orgsQuery.data?.organizations.find((o) => o.id === organizationId);
  const canManage = org && ["proprietario", "administrador", "operador"].includes(org.myRole);

  const needsQuery = useQuery({
    queryKey: ["needs", organizationId],
    queryFn: () => getNeeds({ organizationId }),
    enabled: Number.isFinite(organizationId),
  });

  const itemsQuery = useQuery({
    queryKey: ["inventory-items", organizationId],
    queryFn: () => getInventoryItems({ organizationId }),
    enabled: Number.isFinite(organizationId) && newNeedOpen,
  });

  const form = useForm({
    schema: newNeedSchema,
    defaultValues: { title: "", description: "", unit: "", priority: "media" as const, quantityNeeded: 0 },
  });

  const createNeedMutation = useMutation({
    mutationFn: (data: z.infer<typeof newNeedSchema>) => postNeeds({ organizationId, ...data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["needs", organizationId] });
      toast.success("Necessidade cadastrada");
      setNewNeedOpen(false);
      form.setValues({ title: "", description: "", unit: "", priority: "media", quantityNeeded: 0 } as any);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao cadastrar necessidade"),
  });

  const statusMutation = useMutation({
    mutationFn: (vars: { needId: number; status: (typeof NeedStatusArrayValues)[number] }) =>
      postNeedsStatus({ organizationId, ...vars }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["needs", organizationId] });
      toast.success("Status atualizado");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao atualizar status"),
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
        <span className={styles.tabNavItemActive}>Necessidades</span>
        <Link to={`/organizacoes/${organizationId}/oportunidades`} className={styles.tabNavItem}>
          Oportunidades
        </Link>
        <Link to={`/organizacoes/${organizationId}/atribuicoes`} className={styles.tabNavItem}>
          Rede Levora
        </Link>
        <Link to={`/organizacoes/${organizationId}/prestacao-contas`} className={styles.tabNavItem}>
          Prestação de contas
        </Link>
        <Link to={`/organizacoes/${organizationId}/matching`} className={styles.tabNavItem}>
          Configurações de Matching
        </Link>
      </nav>

      <div className={styles.titleRow}>
        <div>
          <h1 className={styles.title}>Necessidades</h1>
          <p className={styles.subtitle}>
            O que esta organização precisa receber, por prioridade.
          </p>
        </div>
        {canManage && (
          <Dialog open={newNeedOpen} onOpenChange={setNewNeedOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus size={16} /> Nova necessidade
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Cadastrar necessidade</DialogTitle>
                <DialogDescription>
                  Descreva o que falta. Você pode vincular a um item do
                  inventário já cadastrado, se fizer sentido.
                </DialogDescription>
              </DialogHeader>
              <Form {...form}>
                <form
                  className={styles.formGrid}
                  onSubmit={form.handleSubmit((data) => createNeedMutation.mutate(data))}
                >
                  <FormItem name="title">
                    <FormLabel>Título</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Ex: Cestas básicas para 20 famílias"
                        value={form.values.title || ""}
                        onChange={(e) => form.setValues((p: any) => ({ ...p, title: e.target.value }))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>

                  <FormItem name="description">
                    <FormLabel>Descrição (opcional)</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Contexto adicional..."
                        value={form.values.description || ""}
                        onChange={(e) => form.setValues((p: any) => ({ ...p, description: e.target.value }))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>

                  <div className={styles.formRow}>
                    <FormItem name="quantityNeeded" className={styles.formRowItem}>
                      <FormLabel>Quantidade</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.001"
                          value={form.values.quantityNeeded ?? ""}
                          onChange={(e) => form.setValues((p: any) => ({ ...p, quantityNeeded: e.target.value }))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                    <FormItem name="unit" className={styles.formRowItem}>
                      <FormLabel>Unidade</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="cestas, kg, unidades..."
                          value={form.values.unit || ""}
                          onChange={(e) => form.setValues((p: any) => ({ ...p, unit: e.target.value }))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  </div>

                  <FormItem name="priority">
                    <FormLabel>Prioridade</FormLabel>
                    <FormControl>
                      <Select
                        value={form.values.priority}
                        onValueChange={(v) => form.setValues((p: any) => ({ ...p, priority: v }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {NeedPriorityArrayValues.map((p) => (
                            <SelectItem key={p} value={p}>
                              {priorityLabels[p]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>

                  {itemsQuery.data && itemsQuery.data.items.length > 0 && (
                    <FormItem name="itemId">
                      <FormLabel>Vincular a um item do inventário (opcional)</FormLabel>
                      <FormControl>
                        <Select
                          value={form.values.itemId ? String(form.values.itemId) : undefined}
                          onValueChange={(v) => form.setValues((p: any) => ({ ...p, itemId: v }))}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Nenhum" />
                          </SelectTrigger>
                          <SelectContent>
                            {itemsQuery.data.items.map((item) => (
                              <SelectItem key={item.id} value={String(item.id)}>
                                {item.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}

                  <DialogFooter>
                    <Button type="submit" disabled={createNeedMutation.isPending}>
                      {createNeedMutation.isPending ? "Cadastrando..." : "Cadastrar necessidade"}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {needsQuery.isFetching && !needsQuery.data ? (
        <Skeleton className={styles.listSkeleton} />
      ) : needsQuery.data && needsQuery.data.needs.length > 0 ? (
        <ul className={styles.needList}>
          {needsQuery.data.needs.map((need) => (
            <li key={need.id} className={styles.needCard}>
              <div className={styles.needIcon}>
                <ClipboardList size={18} />
              </div>
              <div className={styles.needBody}>
                <div className={styles.needHeaderRow}>
                  <h3 className={styles.needTitle}>{need.title}</h3>
                  <Badge variant={priorityVariant[need.priority]}>{priorityLabels[need.priority]}</Badge>
                </div>
                {need.description && <p className={styles.needDescription}>{need.description}</p>}
                <p className={styles.needMeta}>
                  {need.itemName ? `vinculado a "${need.itemName}" · ` : ""}cadastrada por{" "}
                  {need.createdByDisplayName} em {new Date(need.createdAt).toLocaleDateString("pt-BR")}
                </p>

                {/* Progresso derivado do Modelo B (Fase 42) — nunca sincronizado
                    com `status`: uma need "Aberta" pode já não faltar nada pela
                    rede (requiredRemaining=0), e uma need "Atendida" manualmente
                    pode não ter recebido nada da rede (fulfilled=0). As duas
                    dimensões são intencionalmente independentes (Fase 37). */}
                <div className={styles.progressGrid}>
                  <div className={styles.progressStat}>
                    <span className={styles.progressLabel}>Quantidade necessária</span>
                    <span className={styles.progressValue}>{need.quantityNeeded} {need.unit}</span>
                  </div>
                  <div className={styles.progressStat}>
                    <span className={styles.progressLabel}>Recebido pela rede</span>
                    <span className={styles.progressValue}>{need.fulfilled} {need.unit}</span>
                  </div>
                  <div className={styles.progressStat}>
                    <span className={styles.progressLabel}>Faltam</span>
                    <span className={styles.progressValue}>{need.requiredRemaining} {need.unit}</span>
                  </div>
                  <div className={styles.progressStat}>
                    <span className={styles.progressLabel}>Excedente</span>
                    <span className={need.surplus > 0 ? `${styles.progressValue} ${styles.progressValueSurplus}` : styles.progressValue}>
                      {need.surplus} {need.unit}
                    </span>
                  </div>
                  {need.fulfilled > 0 && need.requiredRemaining > 0 && (
                    <Badge variant="outline" className={styles.partialBadge}>
                      Parcialmente atendida pela rede
                    </Badge>
                  )}
                </div>
              </div>
              <div className={styles.needActions}>
                {canManage && (
                  <Button variant="ghost" size="icon-sm" onClick={() => setEditNeed({ id: need.id, title: need.title, description: need.description, priority: need.priority })} aria-label={"Editar a necessidade " + need.title}>
                    <Pencil size={14} />
                  </Button>
                )}
                {canManage ? (
                  <Select
                    value={need.status}
                    onValueChange={(v) =>
                      statusMutation.mutate({ needId: need.id, status: v as (typeof NeedStatusArrayValues)[number] })
                    }
                  >
                    <SelectTrigger className={styles.statusSelect}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {NeedStatusArrayValues.map((s) => (
                        <SelectItem key={s} value={s}>
                          {statusLabels[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant={need.status === "atendida" ? "success" : need.status === "cancelada" ? "secondary" : "outline"}>
                    {statusLabels[need.status]}
                  </Badge>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.emptyState}>
          Nenhuma necessidade cadastrada ainda para esta organização.
        </div>
      )}
      <EditNeedDialog organizationId={organizationId} need={editNeed} onOpenChange={(open) => !open && setEditNeed(null)} />
    </div>
  );
}
