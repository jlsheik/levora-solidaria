import React, { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { postFilesUpload, FILE_MAX_SIZE_BYTES, ALLOWED_CONTENT_TYPES } from "../endpoints/files-upload_POST.schema";
import { postFilesRescan } from "../endpoints/files-rescan_POST.schema";
import { postStockDestinationProof } from "../endpoints/stock-destination-proof_POST.schema";
import type { DestinationView } from "../helpers/destinationCorrections";
import { Button } from "./Button";
import { Textarea } from "./Textarea";
import { FileDropzone } from "./FileDropzone";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import styles from "./DestinationHistory.module.css";

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2, 12)}`);

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("Falha ao ler o arquivo"));
    reader.readAsDataURL(file);
  });
}

const formatSize = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
export const proofSizeLabel = formatSize;

/**
 * Fase 99J — anexar comprovante (OPCIONAL) a uma destinação. Dois passos honestos: 1) o arquivo é enviado e validado pelo servidor (tipo real pelo conteúdo, até 8 MB); 2) o vínculo é gravado como
 * evento. Se o passo 2 falhar, o arquivo já enviado é reaproveitado numa nova tentativa (mesma chave de idempotência) — nunca duplica. O comprovante não altera estoque nem atendimento e não prova,
 * por si só, que a destinação é válida. Não anexe documentos que identifiquem pessoas sem necessidade.
 */
export function AttachProofDialog({ organizationId, target, onClose, onDone }: { organizationId: number; target: DestinationView | null; onClose: () => void; onDone: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [uploadedId, setUploadedId] = useState<number | null>(null);
  // situação da análise de segurança do arquivo enviado: só "aprovado"/"dispensado" permite vincular
  const [scan, setScan] = useState<{ status: string; message: string } | null>(null);
  const [reason, setReason] = useState("Comprovante da entrega");
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);

  useEffect(() => {
    if (target) { setFile(null); setUploadedId(null); setScan(null); setReason("Comprovante da entrega"); setError(null); setKey(newKey()); }
  }, [target]);

  const mutation = useMutation({
    mutationFn: async () => {
      let fileId = uploadedId;
      if (fileId === null) {
        if (!file) throw new Error("Escolha o arquivo do comprovante");
        const fileBase64 = await fileToBase64(file);
        const up = await postFilesUpload({ organizationId, purpose: "comprovante_destinacao", fileName: file.name, contentType: file.type as (typeof ALLOWED_CONTENT_TYPES)[number], fileBase64 });
        fileId = up.file.id;
        setUploadedId(fileId);
        setScan({ status: up.file.scanStatus, message: up.file.scanMessage });
        if (!["aprovado", "dispensado"].includes(up.file.scanStatus)) throw new Error(up.file.scanMessage);
      } else if (scan && !["aprovado", "dispensado"].includes(scan.status)) {
        // arquivo já enviado e ainda retido: pede nova análise ao servidor antes de tentar o vínculo
        const r = await postFilesRescan({ organizationId, fileId });
        setScan({ status: r.file.scanStatus, message: r.file.scanMessage });
        if (!r.file.released) throw new Error(r.file.scanMessage);
      }
      return postStockDestinationProof({ organizationId, destinationId: target!.id, action: "anexar", fileId, reason: reason.trim(), idempotencyKey: key });
    },
    onSuccess: async () => {
      await onDone();
      toast.success("Comprovante vinculado à destinação.");
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Não foi possível anexar o comprovante"),
  });

  const typeOk = !file || (ALLOWED_CONTENT_TYPES as readonly string[]).includes(file.type);
  const sizeOk = !file || file.size <= FILE_MAX_SIZE_BYTES;
  const problems: string[] = [];
  if (!typeOk) problems.push("Tipo não aceito. Envie JPEG, PNG, WebP ou PDF.");
  if (!sizeOk) problems.push(`O arquivo passa de ${Math.round(FILE_MAX_SIZE_BYTES / 1024 / 1024)} MB.`);
  if (reason.trim().length > 0 && reason.trim().length < 5) problems.push("Explique o motivo (mínimo de 5 caracteres).");
  const ready = (file !== null || uploadedId !== null) && typeOk && sizeOk && reason.trim().length >= 5;

  if (!target) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
      <DialogContent>
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); setError(null); if (ready && !mutation.isPending) mutation.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Anexar comprovante: {target.itemName}</DialogTitle>
            <DialogDescription>
              Opcional. O arquivo fica privado e só é aberto por quem pode consultar destinações. Anexar não altera o estoque nem o atendimento e não prova, sozinho, a validade da destinação.
              {target.proof ? " Já existe um comprovante vigente: ao anexar outro, o anterior deve ser removido antes (somente proprietário ou administrador)." : ""}
            </DialogDescription>
          </DialogHeader>
          {uploadedId !== null ? (
            <p className={styles.notice} role="status" data-testid="proof-scan-state">
              Arquivo “{file?.name}” já enviado ao servidor.{" "}
              {scan && !["aprovado", "dispensado"].includes(scan.status) ? `${scan.message} Ele só pode ser vinculado depois de liberado.` : "Falta apenas confirmar o vínculo — tentar de novo é seguro."}
            </p>
          ) : (
            <FileDropzone
              accept="image/jpeg,image/png,image/webp,application/pdf"
              maxSize={FILE_MAX_SIZE_BYTES}
              disabled={mutation.isPending}
              title={file ? file.name : "Clique ou arraste uma foto ou PDF"}
              subtitle={file ? `${formatSize(file.size)} · ${file.type || "tipo desconhecido"}` : `Até ${Math.round(FILE_MAX_SIZE_BYTES / 1024 / 1024)} MB`}
              onFilesSelected={(files) => { setFile(files[0] ?? null); setError(null); }}
            />
          )}
          <p className={styles.help}>Não envie documentos que identifiquem pessoas (nomes, CPF, endereços) sem necessidade: o registro usa apenas números agregados.</p>
          <label className={styles.label} htmlFor="proof-reason">Motivo / descrição (obrigatório)</label>
          <Textarea id="proof-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} disabled={mutation.isPending} />
          <div aria-live="polite">{problems.length > 0 && <ul className={styles.problems}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}</div>
          {mutation.isPending && <p className={styles.notice} role="status">{uploadedId === null ? "Enviando e analisando o arquivo…" : "Confirmando o vínculo…"}</p>}
          {error && <p className={styles.error} role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancelar</Button>
            <Button type="submit" disabled={!ready || mutation.isPending}>{mutation.isPending ? "Enviando..." : scan && !["aprovado", "dispensado"].includes(scan.status) ? "Analisar novamente" : error ? "Tentar de novo" : "Anexar comprovante"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Remove a REFERÊNCIA ao comprovante vigente (proprietário/administrador). O arquivo não é apagado e a remoção fica no histórico. */
export function RemoveProofDialog({ organizationId, target, onClose, onDone }: { organizationId: number; target: DestinationView | null; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);
  useEffect(() => { if (target) { setReason(""); setError(null); setKey(newKey()); } }, [target]);

  const mutation = useMutation({
    mutationFn: () => postStockDestinationProof({ organizationId, destinationId: target!.id, action: "remover", fileId: target!.proof!.fileId, reason: reason.trim(), idempotencyKey: key }),
    onSuccess: async () => {
      await onDone();
      toast.success("Referência ao comprovante removida. O histórico foi preservado.");
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Não foi possível remover a referência"),
  });

  if (!target || !target.proof) return null;
  const ready = reason.trim().length >= 5;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
      <DialogContent>
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); setError(null); if (ready && !mutation.isPending) mutation.mutate(); }}>
          <DialogHeader>
            <DialogTitle>Remover comprovante</DialogTitle>
            <DialogDescription>
              “{target.proof.name}” deixará de valer como comprovante desta destinação. O arquivo e o registro do anexo permanecem no histórico (não há exclusão), e o estoque e o atendimento não mudam.
            </DialogDescription>
          </DialogHeader>
          <label className={styles.label} htmlFor="proof-remove-reason">Motivo (obrigatório)</label>
          <Textarea id="proof-remove-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} disabled={mutation.isPending} />
          {error && <p className={styles.error} role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancelar</Button>
            <Button type="submit" disabled={!ready || mutation.isPending}>{mutation.isPending ? "Removendo..." : "Remover referência"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
