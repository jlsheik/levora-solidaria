import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCheck2 } from "lucide-react";
import { toast } from "sonner";
import { getAuditChainReceipts, type ReceiptView } from "../endpoints/audit-chain-receipts_GET.schema";
import { getAuditChainVerifications } from "../endpoints/audit-chain-verifications_GET.schema";
import { postAuditChainReceipt } from "../endpoints/audit-chain-receipt_POST.schema";
import { postAuditChainReceiptCompare, type OutputType as CompareOutput } from "../endpoints/audit-chain-receipt-compare_POST.schema";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Skeleton } from "./Skeleton";
import { RECEIPT_REASON_LABEL, RECEIPT_STATUS_LABEL, RECEIPT_TRUST_MODEL } from "./auditCenterView";
import styles from "./AuditCenter.module.css";

const fmt = (iso: string) => new Date(iso).toLocaleString("pt-BR");
const statusBadge = (s: string): "success" | "destructive" | "outline" => (s === "conferido" ? "success" : s === "divergencia" ? "destructive" : "outline");

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

/**
 * Comprovantes locais da cadeia (garantia B) e referência independente (garantia C, NÃO configurada). Gerar e comparar são ações da equipe da plataforma (a cadeia é global); as organizações
 * veem existência, data e estado. A tela nunca chama um comprovante local de âncora externa: o modelo de confiança é dito junto das ações.
 */
export function AuditReceiptsPanel({ organizationId }: { organizationId: number }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [result, setResult] = useState<CompareOutput | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({ queryKey: ["audit-chain-receipts", organizationId], queryFn: () => getAuditChainReceipts({ organizationId, limit: 10 }) });
  const verifs = useQuery({ queryKey: ["audit-chain-verifications", organizationId], queryFn: () => getAuditChainVerifications({ organizationId, limit: 10 }) });
  const lastVerification = verifs.data?.verifications[0] ?? null;
  const canGenerate = !!q.data?.canManage && lastVerification?.status === "integra";

  const generate = useMutation({
    mutationFn: () => postAuditChainReceipt(),
    onSuccess: (out) => {
      setError(null); download(`levora-comprovante-cadeia-${out.receipt.lastEventId}.json`, out.canonical);
      toast.success("Comprovante gerado e baixado. Guarde o arquivo FORA do alcance de quem administra o banco.");
      queryClient.invalidateQueries({ queryKey: ["audit-chain-receipts", organizationId] });
    },
    onError: (e: Error) => setError(e.message || "Não foi possível gerar o comprovante."),
  });
  const compare = useMutation({
    mutationFn: () => postAuditChainReceiptCompare({ receipt: text }),
    onSuccess: (out) => { setError(null); setResult(out); queryClient.invalidateQueries({ queryKey: ["audit-chain-receipts", organizationId] }); },
    onError: (e: Error) => { setResult(null); setError(e.message || "Não foi possível comparar o comprovante."); },
  });

  const latest: ReceiptView | null = q.data?.receipts[0] ?? null;
  const lc = latest?.lastComparison ?? null;

  return (
    <section className={styles.section} aria-labelledby="ar-titulo">
      <h2 id="ar-titulo" className={styles.sectionTitle}><FileCheck2 size={18} aria-hidden="true" /> Comprovantes e referência independente</h2>
      <p className={styles.notice} role="note"><strong>Referência independente não configurada.</strong> {RECEIPT_TRUST_MODEL}</p>

      {q.isLoading ? <Skeleton className={styles.skeleton} /> : q.isError ? (
        <div className={styles.error} role="alert"><span>Não foi possível consultar os comprovantes ({(q.error as Error).message}). Isto não é um resultado de integridade.</span><Button variant="outline" size="sm" onClick={() => q.refetch()}>Tentar de novo</Button></div>
      ) : !latest ? (
        <p className={styles.empty} style={{ marginTop: "0.75rem" }}>Nenhum comprovante foi gerado ainda. Sem comprovante anterior, a verificação interna não consegue perceber a remoção dos últimos registros.</p>
      ) : (
        <div style={{ marginTop: "0.75rem" }}>
          <div className={`${styles.notice} ${lc?.status === "divergencia" ? styles.noticeAttention : ""}`} role="status" aria-live="polite">
            <div className={styles.rowBadges}>
              <Badge variant="secondary">Comprovante anterior disponível</Badge>
              {lc ? <Badge variant={statusBadge(lc.status)}>{RECEIPT_STATUS_LABEL[lc.status] ?? lc.status}</Badge> : <Badge variant="outline">Ainda não comparado</Badge>}
            </div>
            <p style={{ margin: "0.5rem 0 0 0" }}>Gerado em {fmt(latest.capturedAt)}, cobrindo a cadeia até o registro #{latest.lastEventId} ({latest.eventCount} registros).</p>
            {lc && <p style={{ margin: "0.5rem 0 0 0" }}>Última comparação em {fmt(lc.comparedAt)}: {lc.status === "conferido" ? `o estado atual confere com o comprovante${lc.eventsSinceReceipt !== null ? `; ${lc.eventsSinceReceipt} registro(s) novo(s) desde então (esperado)` : ""}.` : (lc.reason && RECEIPT_REASON_LABEL[lc.reason]) ?? "resultado diferente de 'confere'."}</p>}
            {lc?.status === "divergencia" && <p style={{ margin: "0.5rem 0 0 0" }}><strong>Exige investigação.</strong> Nada foi alterado nem reparado por esta tela.</p>}
            {lc?.status === "conferido" && <p style={{ margin: "0.5rem 0 0 0" }}>“Confere” vale tanto quanto a independência de quem guardou o comprovante: se ele esteve sob o mesmo controle do banco, não é prova contra essa pessoa.</p>}
          </div>
          {latest.receiptDigest && (
            <dl className={styles.kv} style={{ marginTop: "0.75rem" }} aria-label="Dados do comprovante (equipe da plataforma)">
              <dt>Algoritmo</dt><dd>SHA-256 · formato versão 1 · escopo: cadeia global</dd>
              <dt>Digest do comprovante</dt><dd className={styles.code}>{latest.receiptDigest}</dd>
              <dt>Hash do registro final</dt><dd className={styles.code}>{latest.headHash}</dd>
            </dl>
          )}
        </div>
      )}

      {q.data?.canManage ? (
        <div style={{ marginTop: "1rem" }}>
          <div className={styles.filterActions}>
            <Button onClick={() => generate.mutate()} disabled={!canGenerate || generate.isPending}>{generate.isPending ? "Gerando…" : "Gerar comprovante"}</Button>
            {latest?.canonical && <Button variant="outline" onClick={() => download(`levora-comprovante-cadeia-${latest.lastEventId}.json`, latest.canonical!)}>Baixar o último comprovante</Button>}
          </div>
          {!canGenerate && <p className={styles.help} style={{ marginTop: "0.5rem" }}>O comprovante só é gerado depois de uma verificação interna que confirmou a consistência. Execute a verificação acima primeiro.</p>}

          <h3 className={styles.subTitle}>Comparar com um comprovante anterior</h3>
          <p className={styles.help}>Cole o conteúdo do comprovante ou escolha o arquivo. A comparação só lê a trilha e registra o resultado; comprovantes malformados, de outra versão ou de outro escopo nunca aparecem como “confere”.</p>
          <label className={styles.field}><span className={styles.fieldLabel}>Arquivo do comprovante</span>
            <input className={styles.control} type="file" accept="application/json,.json" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText((await f.text()).slice(0, 5000)); }} />
          </label>
          <label className={styles.field} style={{ marginTop: "0.5rem" }}><span className={styles.fieldLabel}>Conteúdo do comprovante</span>
            <textarea className={styles.control} style={{ minHeight: "7rem", paddingTop: "0.5rem", fontFamily: "ui-monospace, monospace", fontSize: "0.75rem" }} value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} spellCheck={false} />
          </label>
          <div className={styles.filterActions} style={{ marginTop: "0.5rem" }}>
            <Button onClick={() => compare.mutate()} disabled={!text.trim() || compare.isPending}>{compare.isPending ? "Comparando…" : "Comparar com o estado atual"}</Button>
            <Button variant="outline" onClick={() => { setText(""); setResult(null); setError(null); }} disabled={compare.isPending}>Limpar</Button>
          </div>
          {error && <p className={styles.help} role="alert" style={{ color: "var(--destructive)", marginTop: "0.5rem" }}>{error}</p>}
          {result && (
            <div className={`${styles.notice} ${result.status === "conferido" ? "" : styles.noticeAttention}`} role="status" style={{ marginTop: "0.75rem" }}>
              <Badge variant={statusBadge(result.status)}>{RECEIPT_STATUS_LABEL[result.status] ?? result.status}</Badge>
              <p style={{ margin: "0.5rem 0 0 0" }}>{result.status === "conferido" ? `O estado atual confere com o comprovante até o registro #${result.comparedUpToEventId}${result.eventsSinceReceipt !== null ? `; ${result.eventsSinceReceipt} registro(s) novo(s) desde então.` : "."}` : RECEIPT_REASON_LABEL[result.reason ?? ""] ?? "Resultado sem motivo detalhado."}</p>
            </div>
          )}
        </div>
      ) : q.data ? (
        <p className={styles.help} style={{ marginTop: "0.75rem" }}><strong>Escopo não autorizado para gerar ou comparar.</strong> Gerar e comparar comprovantes são ações da equipe da plataforma, porque a cadeia é global. Você vê a existência, a data e o estado.</p>
      ) : null}
    </section>
  );
}
