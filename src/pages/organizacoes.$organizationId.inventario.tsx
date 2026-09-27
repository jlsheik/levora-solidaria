import React, { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getOrganizations } from "../endpoints/organizations_GET.schema";
import { getInventoryItems } from "../endpoints/inventory-items_GET.schema";
import { postInventoryItems } from "../endpoints/inventory-items_POST.schema";
import { getStockTransactions } from "../endpoints/stock-transactions_GET.schema";
import { postStockTransactions } from "../endpoints/stock-transactions_POST.schema";
import { getApprovalRequests } from "../endpoints/approval-requests_GET.schema";
import { postApprovalRequestsDecide } from "../endpoints/approval-requests-decide_POST.schema";
import { StockTransactionTypeArrayValues } from "../helpers/schema";
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
import { ArrowLeft, Plus, Package, ArrowDownCircle, ArrowUpCircle, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import styles from "./organizacoes.$organizationId.inventario.module.css";

const stockTypeLabels: Record<string, string> = {
  entrada: "Entrada",
  saida: "Saída",
  ajuste: "Ajuste",
};

const newItemSchema = z.object({
  name: z.string().min(2, "Informe o nome do item"),
  unit: z.string().min(1, "Informe a unidade"),
  category: z.string().optional(),
  initialQuantity: z.coerce.number().nonnegative().optional(),
});

const movementSchema = z.object({
  type: z.enum(StockTransactionTypeArrayValues),
  quantity: z.coerce.number().refine((v) => v !== 0, "Informe uma quantidade diferente de zero"),
  reason: z.string().min(2, "Descreva o motivo"),
});

export default function InventoryPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = Number(params.organizationId);
  const queryClient = useQueryClient();
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [movementItem, setMovementItem] = useState<{ id: number; name: string; unit: string } | null>(null);

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => getOrganizations(),
  });
  const org = orgsQuery.data?.organizations.find((o) => o.id === organizationId);
  const canManage = org && ["proprietario", "administrador", "operador"].includes(org.myRole);

  const itemsQuery = useQuery({
    queryKey: ["inventory-items", organizationId],
    queryFn: () => getInventoryItems({ organizationId }),
    enabled: Number.isFinite(organizationId),
  });

  const ledgerQuery = useQuery({
    queryKey: ["stock-transactions", organizationId],
    queryFn: () => getStockTransactions({ organizationId }),
    enabled: Number.isFinite(organizationId),
  });

  const newItemForm = useForm({ schema: newItemSchema, defaultValues: { name: "", unit: "", category: "" } });
  const movementForm = useForm({ schema: movementSchema, defaultValues: { type: "entrada" as const, quantity: 0, reason: "" } });

  const createItemMutation = useMutation({
    mutationFn: (data: z.infer<typeof newItemSchema>) => postInventoryItems({ organizationId, ...data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inventory-items", organizationId] });
      queryClient.invalidateQueries({ queryKey: ["stock-transactions", organizationId] });
      toast.success("Item cadastrado");
      setNewItemOpen(false);
      newItemForm.setValues({ name: "", unit: "", category: "" } as any);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao cadastrar item"),
  });

  const movementMutation = useMutation({
    mutationFn: (data: z.infer<typeof movementSchema>) =>
      postStockTransactions({ organizationId, itemId: movementItem!.id, ...data }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["inventory-items", organizationId] });
      queryClient.invalidateQueries({ queryKey: ["stock-transactions", organizationId] });
      if (result.requiresApproval) {
        queryClient.invalidateQueries({ queryKey: ["approval-requests", organizationId] });
        toast.info(result.message);
      } else {
        toast.success("Movimentação registrada");
      }
      setMovementItem(null);
      movementForm.setValues({ type: "entrada", quantity: 0, reason: "" } as any);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao registrar movimentação"),
  });

  const approvalsQuery = useQuery({
    queryKey: ["approval-requests", organizationId],
    queryFn: () => getApprovalRequests({ organizationId }),
    enabled: Number.isFinite(organizationId) && org?.myRole === "proprietario" || org?.myRole === "administrador",
  });

  const decideApprovalMutation = useMutation({
    mutationFn: (vars: { requestId: number; decision: "aprovada" | "rejeitada" }) => postApprovalRequestsDecide({ organizationId, ...vars }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["approval-requests", organizationId] });
      queryClient.invalidateQueries({ queryKey: ["inventory-items", organizationId] });
      queryClient.invalidateQueries({ queryKey: ["stock-transactions", organizationId] });
      toast.success("Decisão registrada");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao registrar decisão"),
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
        <span className={styles.tabNavItemActive}>Inventário</span>
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
        <Link to={`/organizacoes/${organizationId}/matching`} className={styles.tabNavItem}>
          Configurações de Matching
        </Link>
      </nav>

      <div className={styles.titleRow}>
        <div>
          <h1 className={styles.title}>Inventário</h1>
          <p className={styles.subtitle}>
            O saldo de cada item é sempre a soma das movimentações reais — nunca
            um número editado diretamente.
          </p>
        </div>
        {canManage && (
          <Dialog open={newItemOpen} onOpenChange={setNewItemOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus size={16} /> Novo item
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Cadastrar item de inventário</DialogTitle>
                <DialogDescription>
                  Se já houver quantidade em mãos, informe-a como quantidade
                  inicial — isso gera automaticamente um lançamento de entrada.
                </DialogDescription>
              </DialogHeader>
              <Form {...newItemForm}>
                <form
                  className={styles.formGrid}
                  onSubmit={newItemForm.handleSubmit((data) => createItemMutation.mutate(data))}
                >
                  <FormItem name="name">
                    <FormLabel>Nome do item</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Arroz, cobertor, fralda descartável..."
                        value={newItemForm.values.name || ""}
                        onChange={(e) => newItemForm.setValues((p: any) => ({ ...p, name: e.target.value }))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                  <div className={styles.formRow}>
                    <FormItem name="unit" className={styles.formRowItem}>
                      <FormLabel>Unidade</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="kg, unidade, cesta..."
                          value={newItemForm.values.unit || ""}
                          onChange={(e) => newItemForm.setValues((p: any) => ({ ...p, unit: e.target.value }))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                    <FormItem name="category" className={styles.formRowItem}>
                      <FormLabel>Categoria (opcional)</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Alimentos, higiene..."
                          value={newItemForm.values.category || ""}
                          onChange={(e) => newItemForm.setValues((p: any) => ({ ...p, category: e.target.value }))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  </div>
                  <FormItem name="initialQuantity">
                    <FormLabel>Quantidade inicial em mãos (opcional)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.001"
                        placeholder="0"
                        value={newItemForm.values.initialQuantity ?? ""}
                        onChange={(e) => newItemForm.setValues((p: any) => ({ ...p, initialQuantity: e.target.value }))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                  <DialogFooter>
                    <Button type="submit" disabled={createItemMutation.isPending}>
                      {createItemMutation.isPending ? "Cadastrando..." : "Cadastrar item"}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {itemsQuery.isFetching && !itemsQuery.data ? (
        <div className={styles.grid}>
          {[1, 2, 3].map((i) => <Skeleton key={i} className={styles.cardSkeleton} />)}
        </div>
      ) : itemsQuery.data && itemsQuery.data.items.length > 0 ? (
        <div className={styles.grid}>
          {itemsQuery.data.items.map((item) => (
            <div key={item.id} className={styles.itemCard}>
              <div className={styles.itemCardHeader}>
                <Package size={18} className={styles.itemIcon} />
                {item.category && <Badge variant="outline">{item.category}</Badge>}
              </div>
              <h3 className={styles.itemName}>{item.name}</h3>
              <p className={styles.itemStock}>
                {item.currentStock} <span className={styles.itemUnit}>{item.unit}</span>
              </p>
              {canManage && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setMovementItem({ id: item.id, name: item.name, unit: item.unit });
                    movementForm.setValues({ type: "entrada", quantity: 0, reason: "" } as any);
                  }}
                >
                  Lançar movimentação
                </Button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.emptyState}>
          Nenhum item cadastrado ainda. Cadastre o primeiro item do inventário
          desta organização.
        </div>
      )}

      {org && (org.myRole === "proprietario" || org.myRole === "administrador") && approvalsQuery.data && approvalsQuery.data.requests.some((r) => r.status === "pendente") && (
        <section className={styles.ledgerSection} style={{ marginBottom: "1.5rem", borderColor: "var(--warning)" }}>
          <h2 className={styles.sectionTitle}>Pedidos de aprovação pendentes</h2>
          <ul className={styles.ledgerList}>
            {approvalsQuery.data.requests.filter((r) => r.status === "pendente").map((r) => (
              <li key={r.id} className={styles.ledgerRow}>
                <div className={styles.ledgerInfo}>
                  <span className={styles.ledgerItemName}>{r.actionType}</span>
                  <span className={styles.ledgerMeta}>{r.reason} — pedido por {r.requestedByDisplayName} em {new Date(r.createdAt).toLocaleString("pt-BR")}</span>
                </div>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <Button size="sm" onClick={() => decideApprovalMutation.mutate({ requestId: r.id, decision: "aprovada" })}>Aprovar</Button>
                  <Button size="sm" variant="secondary" onClick={() => decideApprovalMutation.mutate({ requestId: r.id, decision: "rejeitada" })}>Rejeitar</Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.ledgerSection}>
        <h2 className={styles.sectionTitle}>Últimas movimentações</h2>
        {ledgerQuery.isFetching && !ledgerQuery.data ? (
          <Skeleton className={styles.listSkeleton} />
        ) : ledgerQuery.data && ledgerQuery.data.transactions.length > 0 ? (
          <ul className={styles.ledgerList}>
            {ledgerQuery.data.transactions.map((tx) => (
              <li key={tx.id} className={styles.ledgerRow}>
                <div className={styles.ledgerIcon}>
                  {tx.type === "entrada" ? (
                    <ArrowDownCircle size={16} className={styles.iconIn} />
                  ) : tx.type === "saida" ? (
                    <ArrowUpCircle size={16} className={styles.iconOut} />
                  ) : (
                    <SlidersHorizontal size={16} className={styles.iconAdjust} />
                  )}
                </div>
                <div className={styles.ledgerInfo}>
                  <span className={styles.ledgerItemName}>{tx.itemName}</span>
                  <span className={styles.ledgerMeta}>
                    {stockTypeLabels[tx.type]} de {Math.abs(tx.delta)} · {tx.reason} ·{" "}
                    {tx.actorDisplayName ?? "—"} · {new Date(tx.createdAt).toLocaleString("pt-BR")}
                  </span>
                </div>
                <span className={tx.delta >= 0 ? styles.deltaPositive : styles.deltaNegative}>
                  {tx.delta >= 0 ? "+" : ""}
                  {tx.delta}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.emptyText}>Nenhuma movimentação registrada ainda.</p>
        )}
      </section>

      <Dialog open={!!movementItem} onOpenChange={(open) => !open && setMovementItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Movimentar: {movementItem?.name}</DialogTitle>
            <DialogDescription>
              Toda movimentação fica registrada de forma permanente na trilha
              de auditoria e no histórico de estoque.
            </DialogDescription>
          </DialogHeader>
          <Form {...movementForm}>
            <form
              className={styles.formGrid}
              onSubmit={movementForm.handleSubmit((data) => movementMutation.mutate(data))}
            >
              <FormItem name="type">
                <FormLabel>Tipo</FormLabel>
                <FormControl>
                  <Select
                    value={movementForm.values.type}
                    onValueChange={(v) => movementForm.setValues((p: any) => ({ ...p, type: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="entrada">Entrada</SelectItem>
                      <SelectItem value="saida">Saída</SelectItem>
                      <SelectItem value="ajuste">Ajuste (pode ser negativo)</SelectItem>
                    </SelectContent>
                  </Select>
                </FormControl>
                <FormMessage />
              </FormItem>
              <FormItem name="quantity">
                <FormLabel>
                  Quantidade {movementItem ? `(${movementItem.unit})` : ""}
                </FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="0.001"
                    value={movementForm.values.quantity ?? ""}
                    onChange={(e) => movementForm.setValues((p: any) => ({ ...p, quantity: e.target.value }))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
              <FormItem name="reason">
                <FormLabel>Motivo</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="Ex: doação recebida de fulano, distribuição para família X, contagem de conferência..."
                    value={movementForm.values.reason || ""}
                    onChange={(e) => movementForm.setValues((p: any) => ({ ...p, reason: e.target.value }))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
              <DialogFooter>
                <Button type="submit" disabled={movementMutation.isPending}>
                  {movementMutation.isPending ? "Registrando..." : "Registrar movimentação"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
