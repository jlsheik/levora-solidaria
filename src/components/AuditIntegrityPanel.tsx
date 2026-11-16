import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { getAuditChainVerifications, type VerificationView } from "../endpoints/audit-chain-verifications_GET.schema";
import { postAuditChainVerify } from "../endpoints/audit-chain-verify_POST.schema";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Skeleton } from "./Skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import { COVERAGE_LIMITS, DIVERGENCE_REASON_LABEL, THREE_GUARANTEES, verificationState } from "./auditCenterView";
import { AuditReceiptsPanel } from "./AuditReceiptsPanel";
import styles from "./AuditCenter.module.css";

const fmt = (iso: string) => new Date(iso).toLocaleString("pt-BR");
const tone = (t: "ok" | "attention" | "info" | "muted") => (t === "ok" ? "success" : t === "attention" ? "destructive" : t === "info" ? "secondary" : "outline") as "success" | "destructive" | "secondary" | "outline";

/**
 * Integridade da trilha (M38). Reusa a verificação canônica da cadeia. A cadeia é GLOBAL: só a equipe da plataforma executa; as organizações veem o último resultado, sem ids de outras
 * organizações. Estados em palavras: nunca verificado, em andamento, íntegra no escopo, inconsistência, incompleta, falha técnica, escopo não autorizado. "Íntegra" nunca é garantia absoluta.
 */
export function AuditIntegrityPanel({ organizationId, onOpenEntry }: { organizationId: number; onOpenEntry?: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["audit-chain-verifications", organizationId],
    queryFn: () => getAuditChainVerifications({ organizationId, limit: 10 }),
    // Enquanto há verificação em andamento, consulta a cada 2 s para mostrar a conclusão sem recarregar a página.
    refetchInterval: (query) => (query.state.data?.verifications[0]?.status === "em_andamento" ? 2000 : false),
  });
  const run = useMutation({
    mutationFn: () => postAuditChainVerify({}),
    onSuccess: () => { setConfirm(false); setRunError(null); toast.success("Verificação iniciada. O resultado aparece aqui quando terminar."); queryClient.invalidateQueries({ queryKey: ["audit-chain-verifications", organizationId] }); },
    onError: (e: Error & { code?: string }) => { setRunError(e.code === "verificacao_em_andamento" ? "Já existe uma verificação em andamento. Aguarde a conclusão." : e.message || "Não foi possível iniciar a verificação."); queryClient.invalidateQueries({ queryKey: ["audit-chain-verifications", organizationId] }); },
  });

  const last: VerificationView | null = q.data?.verifications[0] ?? null;
  const st = verificationState(last);
  const running = last?.status === "em_andamento";

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="ai-estado">
        <h2 id="ai-estado" className={styles.sectionTitle}><ShieldCheck size={18} aria-hidden="true" /> Integridade da trilha</h2>
        <p className={styles.help}>A trilha é encadeada por hashes: cada evento guarda o hash do anterior. A verificação recalcula esses hashes e confere os elos. Ela <strong>só lê</strong>: nunca repara, recalcula nem apaga nada.</p>

        {q.isLoading ? <Skeleton className={styles.skeleton} /> : q.isError ? (
          <div className={styles.error} role="alert"><span>Não foi possível consultar as verificações ({(q.error as Error).message}). Isto não é um resultado de integridade.</span><Button variant="outline" size="sm" onClick={() => q.refetch()}>Tentar de novo</Button></div>
        ) : (
          <>
            <div className={`${styles.notice} ${st.tone === "attention" ? styles.noticeAttention : ""}`} role="status" aria-live="polite">
              <div className={styles.rowBadges}><Badge variant={tone(st.tone)}>{st.label}</Badge>{last && <span className={styles.rowMeta}>pedido em {fmt(last.startedAt)}{last.finishedAt ? ` · concluído em ${fmt(last.finishedAt)}` : ""}</span>}</div>
              <p style={{ margin: "0.5rem 0 0 0" }}>{st.message}</p>
              {st.requiresInvestigation && <p style={{ margin: "0.5rem 0 0 0" }}><strong>Exige investigação.</strong> Preserve os registros e acione a equipe responsável pela plataforma. Esta tela não oferece reparo automático e nenhum registro foi alterado.</p>}
            </div>

            {last && last.status !== "em_andamento" && (
              <dl className={styles.kv} style={{ marginTop: "1rem" }} aria-label="Abrangência da última verificação">
                <dt>Escopo</dt><dd>Cadeia global (todas as organizações)</dd>
                <dt>Eventos cobertos</dt><dd>{last.coveredUpToEventId !== null ? `todos até o registro #${last.coveredUpToEventId} (lido no início da verificação; eventos gravados depois não entram)` : "não definido"}</dd>
                <dt>Total / verificados</dt><dd>{last.totalEvents ?? "—"} / {last.verifiedEvents ?? "—"}</dd>
                <dt>Sem hash (não verificáveis)</dt><dd>{last.unhashedEvents ?? "—"}</dd>
                <dt>Divergências</dt><dd>{last.divergenceCount ?? "—"}{last.status === "inconsistencia" && !q.data?.isPlatformAdmin ? ` · ${last.divergencesInYourOrganization ?? "?"} em eventos da sua organização` : ""}</dd>
                <dt>Duração</dt><dd>{last.durationMs !== null ? `${last.durationMs} ms` : "—"}</dd>
                {last.requestedByName && (<><dt>Solicitada por</dt><dd>{last.requestedByName}</dd></>)}
              </dl>
            )}

            {last?.status === "inconsistencia" && (
              <div style={{ marginTop: "0.75rem" }}>
                {last.divergences ? (
                  <>
                    <h3 className={styles.subTitle}>Eventos afetados (equipe da plataforma)</h3>
                    <ul className={styles.list}>
                      {last.divergences.slice(0, 20).map((d) => <li key={d.id} className={`${styles.row} ${styles.rowAttention}`}><div className={styles.rowMain}><span className={styles.rowTitle}>Registro #{d.id}</span><span className={styles.rowMeta}>{DIVERGENCE_REASON_LABEL[d.reason] ?? d.reason}</span></div>{onOpenEntry && <Button variant="outline" size="sm" onClick={() => onOpenEntry(d.id)} aria-label={`Ver o registro ${d.id}`}>Detalhes</Button>}</li>)}
                    </ul>
                    {last.divergenceCount !== null && last.divergenceCount > 20 && <p className={styles.help}>Exibindo 20 de {last.divergenceCount} divergências. Os detalhes completos ficam com a equipe técnica.</p>}
                    <p className={styles.help}>Os registros de outra organização só abrem na Central dessa organização. Os valores de hash nunca são exibidos.</p>
                  </>
                ) : <p className={styles.help}>Os registros afetados são tratados pela equipe da plataforma; eles não são listados para as organizações.</p>}
              </div>
            )}
          </>
        )}

        <div style={{ marginTop: "1rem" }}>
          {q.data?.canRun ? (
            <>
              <Button onClick={() => { setRunError(null); setConfirm(true); }} disabled={running || run.isPending}>{running ? "Verificação em andamento…" : "Verificar a integridade agora"}</Button>
              {runError && <p className={styles.help} role="alert" style={{ color: "var(--destructive)", marginTop: "0.5rem" }}>{runError}</p>}
            </>
          ) : q.data ? (
            <p className={styles.help}><strong>Escopo não autorizado para executar.</strong> A cadeia é global, por isso apenas a equipe da plataforma pode iniciar a verificação. Você vê o último resultado registrado.</p>
          ) : null}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="ai-garantias">
        <h2 id="ai-garantias" className={styles.sectionTitle}>Três garantias diferentes</h2>
        <p className={styles.help}>Elas não se substituem. Só a A e a B existem nesta instalação, e a B só vale se o comprovante foi preservado fora do alcance de quem administra o banco.</p>
        <ul className={styles.list}>
          {THREE_GUARANTEES.map((g) => (
            <li key={g.key} className={styles.row}>
              <div className={styles.rowMain}><span className={styles.rowTitle}>Garantia {g.key} — {g.title}</span><span className={styles.rowMeta}>{g.text}</span></div>
              <Badge variant={g.key === "C" ? "outline" : "secondary"}>{g.status}</Badge>
            </li>
          ))}
        </ul>
      </section>

      <AuditReceiptsPanel organizationId={organizationId} />

      <section className={styles.section} aria-labelledby="ai-limites">
        <h2 id="ai-limites" className={styles.sectionTitle}>O que esta verificação prova — e o que não prova</h2>
        <ul className={styles.limits}>{COVERAGE_LIMITS.map((l) => <li key={l}>{l}</li>)}</ul>
      </section>

      <section className={styles.section} aria-labelledby="ai-hist">
        <h2 id="ai-hist" className={styles.sectionTitle}>Verificações anteriores</h2>
        {q.isLoading ? <Skeleton className={styles.skeleton} /> : !q.data || q.data.verifications.length === 0 ? <p className={styles.empty}>Nenhuma verificação foi registrada ainda.</p> : (
          <ul className={styles.list}>
            {q.data.verifications.map((v) => {
              const s = verificationState(v);
              return <li key={v.id} className={styles.row}><div className={styles.rowMain}><span className={styles.rowTitle}>{s.label}</span><span className={styles.rowMeta}>{fmt(v.startedAt)} · divergências: {v.divergenceCount ?? "—"} · verificados: {v.verifiedEvents ?? "—"}</span></div><Badge variant={tone(s.tone)}>{v.status.replace(/_/g, " ")}</Badge></li>;
            })}
          </ul>
        )}
      </section>

      <Dialog open={confirm} onOpenChange={(o) => !o && !run.isPending && setConfirm(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Verificar a integridade da trilha?</DialogTitle>
            <DialogDescription>A verificação lê toda a cadeia de auditoria (de todas as organizações) e recalcula cada hash. Ela não altera, repara nem apaga registros, e só uma pode rodar por vez. O pedido fica registrado na trilha; o resultado, em uma tabela operacional separada.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)} disabled={run.isPending}>Cancelar</Button>
            <Button onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? "Iniciando…" : "Iniciar verificação"}</Button>
          </DialogFooter>
          {runError && <p className={styles.help} role="alert" style={{ color: "var(--destructive)" }}>{runError}</p>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
