import React, { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getOrganizations } from "../endpoints/organizations_GET.schema";
import { getOrganizationAllocations } from "../endpoints/organization-allocations_GET.schema";
import { postAllocationsDecide } from "../endpoints/allocations-decide_POST.schema";
import { postAllocationsReceive } from "../endpoints/allocations-receive_POST.schema";
import { postAllocationsLogistics } from "../endpoints/allocations-logistics_POST.schema";
import { getAllocationsLogistics } from "../endpoints/allocations-logistics_GET.schema";
import { getInventoryItems } from "../endpoints/inventory-items_GET.schema";
import { postFilesUpload, FILE_MAX_SIZE_BYTES, ALLOWED_CONTENT_TYPES } from "../endpoints/files-upload_POST.schema";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "../components/Dialog";
import { Form, FormControl, FormItem, FormLabel, FormMessage, useForm } from "../components/Form";
import { Input } from "../components/Input";
import { Textarea } from "../components/Textarea";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { Skeleton } from "../components/Skeleton";
import { ReceiptHistoryPanel } from "../components/ReceiptHistoryPanel";
import { FileDropzone } from "../components/FileDropzone";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/Select";
import { z } from "zod";
import { ArrowLeft, Network, PackageCheck, FileCheck, X } from "lucide-react";
import { toast } from "sonner";
import styles from "./organizacoes.$organizationId.atribuicoes.module.css";

const statusLabels: Record<string, string> = {
  proposta: "Proposta", aceita: "Aceita", recusada: "Recusada", em_coleta: "Em coleta", em_transporte: "Em transporte", recebida: "Recebida", cancelada: "Cancelada",
};

const logisticsEventLabels: Record<string, string> = {
  coleta_agendada: "Coleta agendada", coleta_concluida: "Coleta concluída", transporte_iniciado: "Transporte iniciado", entrega_confirmada: "Entrega confirmada", cancelado: "Cancelado",
};

const receiveSchema = z.object({
  itemId: z.coerce.number().int().positive({ message: "Selecione o item recebido" }),
  quantityReceived: z.coerce.number().positive("Informe a quantidade recebida"),
  notes: z.string().optional(),
  proofUrl: z.string().optional(),
});

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // data:<mime>;base64,<conteúdo> — só o conteúdo interessa aqui.
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(reader.error ?? new Error("Falha ao ler o arquivo"));
    reader.readAsDataURL(file);
  });
}

export default function OrganizationAllocationsPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = Number(params.organizationId);
  const queryClient = useQueryClient();
  const [receiveTarget, setReceiveTarget] = useState<{ id: number; title: string } | null>(null);
  const [expandedTimelineId, setExpandedTimelineId] = useState<number | null>(null);
  const [expandedReceiptId, setExpandedReceiptId] = useState<number | null>(null);
  const [uploadedProof, setUploadedProof] = useState<{ id: number; originalFilename: string } | null>(null);

  const orgsQuery = useQuery({ queryKey: ["organizations"], queryFn: () => getOrganizations() });
  const org = orgsQuery.data?.organizations.find((o) => o.id === organizationId);
  const canManage = org && ["proprietario", "administrador", "operador"].includes(org.myRole);

  const allocationsQuery = useQuery({
    queryKey: ["organization-allocations", organizationId],
    queryFn: () => getOrganizationAllocations({ organizationId }),
    enabled: Number.isFinite(organizationId),
  });

  const itemsQuery = useQuery({
    queryKey: ["inventory-items", organizationId],
    queryFn: () => getInventoryItems({ organizationId }),
    enabled: Number.isFinite(organizationId) && !!receiveTarget,
  });

  const decideMutation = useMutation({
    mutationFn: (vars: { allocationId: number; decision: "aceita" | "recusada" }) =>
      postAllocationsDecide({ organizationId, ...vars }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organization-allocations", organizationId] });
      toast.success("Decisão registrada");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao registrar decisão"),
  });

  const timelineQuery = useQuery({
    queryKey: ["allocation-logistics", organizationId, expandedTimelineId],
    queryFn: () => getAllocationsLogistics({ organizationId, allocationId: expandedTimelineId! }),
    enabled: expandedTimelineId !== null,
  });

  const logisticsMutation = useMutation({
    mutationFn: (vars: { allocationId: number; eventType: "coleta_agendada" | "coleta_concluida" | "transporte_iniciado" | "cancelado" }) =>
      postAllocationsLogistics({ organizationId, ...vars }),
    onSuccess: (_r, vars) => {
      queryClient.invalidateQueries({ queryKey: ["organization-allocations", organizationId] });
      queryClient.invalidateQueries({ queryKey: ["allocation-logistics", organizationId, vars.allocationId] });
      toast.success("Evento de logística registrado");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao registrar evento"),
  });

  const receiveForm = useForm({ schema: receiveSchema, defaultValues: { quantityReceived: 0, notes: "" } });
  const receiveMutation = useMutation({
    mutationFn: (data: z.infer<typeof receiveSchema>) =>
      postAllocationsReceive({ organizationId, allocationId: receiveTarget!.id, proofFileId: uploadedProof?.id, ...data }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["organization-allocations", organizationId] });
      queryClient.invalidateQueries({ queryKey: ["inventory-items", organizationId] });
      queryClient.invalidateQueries({ queryKey: ["stock-transactions", organizationId] });
      toast.success(`Recebimento registrado. Novo saldo do item: ${result.newStock}`);
      setReceiveTarget(null);
      setUploadedProof(null);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao registrar recebimento"),
  });

  const uploadProofMutation = useMutation({
    mutationFn: async (file: File) => {
      const fileBase64 = await fileToBase64(file);
      return postFilesUpload({
        organizationId,
        purpose: "comprovante_entrega",
        fileName: file.name,
        contentType: file.type as (typeof ALLOWED_CONTENT_TYPES)[number],
        fileBase64,
      });
    },
    onSuccess: (result) => {
      setUploadedProof({ id: result.file.id, originalFilename: result.file.originalFilename });
      toast.success("Comprovante enviado");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Falha ao enviar comprovante"),
  });

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.backLink}><ArrowLeft size={16} /> Voltar ao painel</Link>

      <nav className={styles.tabNav}>
        <Link to={`/organizacoes/${organizationId}`} className={styles.tabNavItem}>Visão geral</Link>
        <Link to={`/organizacoes/${organizationId}/inventario`} className={styles.tabNavItem}>Inventário</Link>
        <Link to={`/organizacoes/${organizationId}/necessidades`} className={styles.tabNavItem}>Necessidades</Link>
        <Link to={`/organizacoes/${organizationId}/oportunidades`} className={styles.tabNavItem}>Oportunidades</Link>
        <span className={styles.tabNavItemActive}>Rede Levora</span>
        <Link to={`/organizacoes/${organizationId}/prestacao-contas`} className={styles.tabNavItem}>Prestação de contas</Link>
        <Link to={`/organizacoes/${organizationId}/matching`} className={styles.tabNavItem}>Configurações de Matching</Link>
      </nav>

      <div className={styles.titleRow}>
        <div>
          <h1 className={styles.title}><Network size={20} /> Atribuições da rede Levora</h1>
          <p className={styles.subtitle}>
            Oportunidades descobertas centralmente pela equipe da Levora e
            atribuídas a esta organização. Aceite ou recuse — só depois de
            aceitar é possível registrar o recebimento.
          </p>
        </div>
      </div>

      {allocationsQuery.isFetching && !allocationsQuery.data ? <Skeleton className={styles.listSkeleton} /> : (
        <ul className={styles.list}>
          {(allocationsQuery.data?.allocations ?? []).map((a) => (
            <li key={a.id} className={styles.card}>
              <div className={styles.headerRow}>
                <h3 className={styles.cardTitle}>{a.opportunityTitle}</h3>
                <Badge variant={a.status === "recebida" ? "success" : a.status === "recusada" || a.status === "cancelada" ? "destructive" : "outline"}>
                  {statusLabels[a.status]}
                </Badge>
              </div>
              <p className={styles.meta}>
                Fonte: {a.sourceName} · quantidade atribuída: {a.quantityAllocated} {a.opportunityUnit ?? ""}
                {a.opportunityLocationCity ? ` · ${a.opportunityLocationCity}/${a.opportunityLocationState ?? ""}` : ""}
              </p>
              {a.opportunityDescription && <p className={styles.description}>{a.opportunityDescription}</p>}
              {canManage && a.status === "proposta" && (
                <div className={styles.actions}>
                  <Button size="sm" onClick={() => decideMutation.mutate({ allocationId: a.id, decision: "aceita" })}>Aceitar</Button>
                  <Button size="sm" variant="secondary" onClick={() => decideMutation.mutate({ allocationId: a.id, decision: "recusada" })}>Recusar</Button>
                </div>
              )}
              {canManage && a.status === "aceita" && (
                <div className={styles.actions}>
                  <Button size="sm" variant="secondary" onClick={() => logisticsMutation.mutate({ allocationId: a.id, eventType: "coleta_agendada" })}>Agendar coleta</Button>
                  <Button size="sm" variant="secondary" onClick={() => { setReceiveTarget({ id: a.id, title: a.opportunityTitle }); receiveForm.setValues({ quantityReceived: 0, notes: "", proofUrl: "" } as any); setUploadedProof(null); }}>
                    <PackageCheck size={14} /> Registrar recebimento direto
                  </Button>
                </div>
              )}
              {canManage && a.status === "em_coleta" && (
                <div className={styles.actions}>
                  <Button size="sm" variant="secondary" onClick={() => logisticsMutation.mutate({ allocationId: a.id, eventType: "coleta_concluida" })}>Marcar coleta concluída</Button>
                  <Button size="sm" variant="secondary" onClick={() => logisticsMutation.mutate({ allocationId: a.id, eventType: "transporte_iniciado" })}>Iniciar transporte</Button>
                </div>
              )}
              {canManage && (a.status === "aceita" || a.status === "em_coleta" || a.status === "em_transporte") && (
                <div className={styles.actions}>
                  {a.status === "em_transporte" && (
                    <Button size="sm" onClick={() => { setReceiveTarget({ id: a.id, title: a.opportunityTitle }); receiveForm.setValues({ quantityReceived: 0, notes: "", proofUrl: "" } as any); setUploadedProof(null); }}>
                      <PackageCheck size={14} /> Confirmar entrega
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => setExpandedTimelineId(expandedTimelineId === a.id ? null : a.id)}>
                    {expandedTimelineId === a.id ? "Ocultar" : "Ver"} linha do tempo
                  </Button>
                </div>
              )}
              {a.status === "recebida" && (
                <div className={styles.actions}>
                  <Button size="sm" variant="outline" onClick={() => setExpandedReceiptId(expandedReceiptId === a.id ? null : a.id)}>
                    {expandedReceiptId === a.id ? "Ocultar" : "Ver"} histórico do recebimento
                  </Button>
                </div>
              )}
              {a.status === "recebida" && expandedReceiptId === a.id && <ReceiptHistoryPanel organizationId={organizationId} allocationId={a.id} />}
              {expandedTimelineId === a.id && (
                <div className={styles.timelineBox}>
                  {timelineQuery.isFetching && !timelineQuery.data ? <Skeleton className={styles.listSkeleton} /> : (
                    (timelineQuery.data?.events ?? []).length === 0 ? (
                      <p className={styles.hintText}>Nenhum evento de logística registrado ainda.</p>
                    ) : (
                      <ul className={styles.timelineList}>
                        {timelineQuery.data!.events.map((ev) => (
                          <li key={ev.id} className={styles.timelineRow}>
                            <strong>{logisticsEventLabels[ev.eventType]}</strong> — {ev.actorDisplayName ?? "sistema"} · {new Date(ev.occurredAt).toLocaleString("pt-BR")}
                            {ev.notes ? ` — ${ev.notes}` : ""}
                            {ev.proofUrl && (
                              <>
                                {" — "}
                                <a href={ev.proofUrl} target="_blank" rel="noopener noreferrer" className={styles.proofLink}>
                                  ver comprovante
                                </a>
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    )
                  )}
                </div>
              )}
            </li>
          ))}
          {allocationsQuery.data && allocationsQuery.data.allocations.length === 0 && (
            <div className={styles.emptyState}>Nenhuma atribuição da rede Levora para esta organização ainda.</div>
          )}
        </ul>
      )}

      <Dialog open={!!receiveTarget} onOpenChange={(open) => !open && setReceiveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar recebimento: {receiveTarget?.title}</DialogTitle>
            <DialogDescription>Selecione o item e a quantidade realmente conferida — gera uma entrada real no estoque.</DialogDescription>
          </DialogHeader>
          <Form {...receiveForm}>
            <form className={styles.formGrid} onSubmit={receiveForm.handleSubmit((d) => receiveMutation.mutate(d))}>
              <FormItem name="itemId">
                <FormLabel>Item recebido</FormLabel>
                <FormControl>
                  <Select value={receiveForm.values.itemId ? String(receiveForm.values.itemId) : undefined} onValueChange={(v) => receiveForm.setValues((p: any) => ({ ...p, itemId: v }))}>
                    <SelectTrigger><SelectValue placeholder="Selecione um item cadastrado" /></SelectTrigger>
                    <SelectContent>
                      {(itemsQuery.data?.items ?? []).map((item) => <SelectItem key={item.id} value={String(item.id)}>{item.name} ({item.unit})</SelectItem>)}
                    </SelectContent>
                  </Select>
                </FormControl>
                {itemsQuery.data && itemsQuery.data.items.length === 0 && (
                  <p className={styles.hintText}>Nenhum item cadastrado — cadastre no Inventário antes de receber.</p>
                )}
                <FormMessage />
              </FormItem>
              <FormItem name="quantityReceived">
                <FormLabel>Quantidade recebida</FormLabel>
                <FormControl><Input type="number" step="0.001" value={receiveForm.values.quantityReceived ?? ""} onChange={(e) => receiveForm.setValues((p: any) => ({ ...p, quantityReceived: e.target.value }))} /></FormControl>
                <FormMessage />
              </FormItem>
              <FormItem name="notes">
                <FormLabel>Observações (opcional)</FormLabel>
                <FormControl><Textarea value={receiveForm.values.notes || ""} onChange={(e) => receiveForm.setValues((p: any) => ({ ...p, notes: e.target.value }))} /></FormControl>
              </FormItem>
              <FormItem name="proof">
                <FormLabel>Comprovante (foto ou PDF, opcional)</FormLabel>
                {uploadedProof ? (
                  <div className={styles.uploadedProof}>
                    <FileCheck size={16} />
                    <span>{uploadedProof.originalFilename}</span>
                    <button type="button" className={styles.removeProofButton} onClick={() => setUploadedProof(null)} aria-label="Remover comprovante">
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <FileDropzone
                    accept={ALLOWED_CONTENT_TYPES.join(",")}
                    maxSize={FILE_MAX_SIZE_BYTES}
                    disabled={uploadProofMutation.isPending}
                    title={uploadProofMutation.isPending ? "Enviando..." : "Clique ou arraste uma foto/PDF"}
                    subtitle={`Até ${Math.round(FILE_MAX_SIZE_BYTES / 1024 / 1024)}MB`}
                    onFilesSelected={(files) => files[0] && uploadProofMutation.mutate(files[0])}
                  />
                )}
                <p className={styles.hintText}>
                  Ou, se já tiver uma foto hospedada em outro lugar, cole o link abaixo em vez de enviar um arquivo:
                </p>
                <FormControl>
                  <Input
                    placeholder="https://..."
                    disabled={!!uploadedProof}
                    value={receiveForm.values.proofUrl || ""}
                    onChange={(e) => receiveForm.setValues((p: any) => ({ ...p, proofUrl: e.target.value }))}
                  />
                </FormControl>
              </FormItem>
              <DialogFooter>
                <Button type="submit" disabled={receiveMutation.isPending}>{receiveMutation.isPending ? "Registrando..." : "Confirmar recebimento"}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

