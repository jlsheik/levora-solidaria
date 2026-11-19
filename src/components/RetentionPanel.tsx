import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import { getRetentionPreview } from "../endpoints/retention-preview_GET.schema";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Skeleton } from "./Skeleton";
import { fmtDateTime } from "./agentOpsView";
import styles from "./AgentOps.module.css";

const PERIODS = [{ days: 0, label: "Sem simulação" }, { days: 90, label: "Mais de 90 dias" }, { days: 180, label: "Mais de 180 dias" }, { days: 365, label: "Mais de 365 dias" }];

/** Retenção: só CLASSIFICAÇÃO e SIMULAÇÃO. Não existe política de retenção definida nem exclusão automática; a trilha de auditoria nunca é candidata a expirar. */
export function RetentionPanel({ organizationId }: { organizationId: number }) {
  const [days, setDays] = useState(0);
  const query = useQuery({ queryKey: ["retention-preview", organizationId, days], queryFn: () => getRetentionPreview({ organizationId, olderThanDays: days || undefined }), retry: false });
  return (
    <section className={styles.section} aria-labelledby="retencao-titulo" aria-busy={query.isFetching}>
      <h2 id="retencao-titulo" className={styles.sectionTitle}><Archive size={18} aria-hidden="true" /> Retenção dos registros <Badge variant="outline">Somente leitura</Badge></h2>
      <p className={styles.help}>Nenhum prazo de guarda foi definido e <strong>nenhum registro é apagado</strong> automaticamente. Esta tela só mostra o que existe e simula quantos registros passariam de um prazo hipotético, para o proprietário decidir. A trilha de auditoria é encadeada por hash e nunca é descartável.</p>
      <div className={styles.chips} role="group" aria-label="Simular prazo" style={{ marginBottom: "1rem" }}>
        {PERIODS.map((p) => (<button key={p.days} type="button" className={`${styles.chip} ${days === p.days ? styles.chipActive : ""}`} aria-pressed={days === p.days} onClick={() => setDays(p.days)}>{p.label}</button>))}
      </div>
      {query.isError ? (
        <div className={styles.error}>
          <p className={styles.errorText} role="alert">Não foi possível carregar a classificação. {query.error instanceof Error ? query.error.message : ""}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>Tentar de novo</Button>
        </div>
      ) : !query.data ? <Skeleton className={styles.skeleton} /> : (
        <>
          <ul className={styles.list} aria-label="Categorias de registros">
            {query.data.rows.map((r) => (
              <li key={r.key} className={styles.row}>
                <div className={styles.rowMain}>
                  <h3 className={styles.rowTitle}>{r.label} <Badge variant={r.group === "auditoria" ? "destructive" : "outline"}>{r.group === "auditoria" ? "Nunca expira" : "Prazo não definido"}</Badge></h3>
                  <span className={styles.rowMeta}>{r.note}</span>
                  <dl className={styles.kv}><dt>Registros</dt><dd>{r.total}</dd><dt>Mais antigo</dt><dd>{r.oldestAt ? fmtDateTime(r.oldestAt) : "—"}</dd>{r.olderThanSimulated !== null && (<><dt>Simulação (&gt; {query.data.olderThanDays} dias)</dt><dd>{r.group === "auditoria" ? `${r.olderThanSimulated} — não seriam tocados` : `${r.olderThanSimulated} passariam do prazo (nada é apagado)`}</dd></>)}</dl>
                </div>
              </li>
            ))}
          </ul>
          <h3 className={styles.rowTitle} style={{ marginTop: "1rem" }}>Decisões do proprietário pendentes</h3>
          <ul className={styles.history}>{query.data.decisionsPending.map((d) => <li key={d}>{d}</li>)}</ul>
        </>
      )}
    </section>
  );
}
