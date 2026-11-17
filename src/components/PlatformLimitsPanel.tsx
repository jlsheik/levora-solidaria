import React from "react";
import { useQuery } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import { getPlatformPolicyLimits } from "../endpoints/platform-policy-limits_GET.schema";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Skeleton } from "./Skeleton";
import { LIMIT_COPY, fmtLimit } from "./agentOpsView";
import styles from "./AgentOps.module.css";

/**
 * Limites GLOBAIS de autonomia, vistos pela equipe da plataforma — SOMENTE LEITURA. A escrita global não foi implementada porque as regras de negócio não estão definidas (quem autoriza, faixas, se
 * pode ficar menos restritivo que o padrão). Só aparece em `/plataforma`; o servidor recusa quem não é da equipe.
 */
export function PlatformLimitsPanel() {
  const query = useQuery({ queryKey: ["platform-policy-limits"], queryFn: () => getPlatformPolicyLimits(), retry: false });
  return (
    <section className={styles.section} aria-labelledby="limites-globais-titulo" aria-busy={query.isFetching}>
      <h2 id="limites-globais-titulo" className={styles.sectionTitle}><SlidersHorizontal size={18} aria-hidden="true" /> Limites globais de autonomia <Badge variant="outline">Somente leitura</Badge></h2>
      <p className={styles.help}>Valem para todas as organizações; cada organização só pode ser <strong>mais restritiva</strong>. A edição do limite global pela interface <strong>não está habilitada</strong> até o proprietário definir as regras abaixo.</p>
      {query.isError ? (
        <div className={styles.error}>
          <p className={styles.errorText} role="alert">Não foi possível carregar os limites globais. {query.error instanceof Error ? query.error.message : ""}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>Tentar de novo</Button>
        </div>
      ) : !query.data ? <Skeleton className={styles.skeleton} /> : (
        <>
          <ul className={styles.list} aria-label="Limites globais">
            {query.data.limits.map((l) => {
              const c = LIMIT_COPY[l.key] ?? { label: l.key, help: "", unit: null, effect: "" };
              return (
                <li key={l.key} className={styles.row}>
                  <div className={styles.rowMain}>
                    <h3 className={styles.rowTitle}>{c.label}</h3>
                    <span className={styles.rowMeta}>{c.help} Ao ultrapassar: {c.effect}.</span>
                    <dl className={styles.kv}><dt>Padrão em código</dt><dd>{fmtLimit(l.defaultValue, c.unit)}</dd><dt>Global em vigor</dt><dd><strong>{fmtLimit(l.globalValue, c.unit)}</strong></dd><dt>Organizações que restringem</dt><dd>{l.organizationsRestricting}</dd></dl>
                  </div>
                </li>
              );
            })}
          </ul>
          <h3 className={styles.rowTitle} style={{ marginTop: "1rem" }}>Decisões do proprietário pendentes</h3>
          <ul className={styles.history}>{query.data.pendingDecisions.map((d) => <li key={d}>{d}</li>)}</ul>
        </>
      )}
    </section>
  );
}
