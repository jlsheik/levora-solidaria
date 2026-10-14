import React, { useDeferredValue, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Info, Ruler, RotateCcw } from "lucide-react";
import { getOrganizations } from "../endpoints/organizations_GET.schema";
import { getUnitInventory, type OutputType } from "../endpoints/unit-inventory_GET.schema";
import { UNIT_CLASSIFICATION_LABELS, type UnitClassificationKind } from "../helpers/unitVocabulary";
import { Button } from "../components/Button";
import { Skeleton } from "../components/Skeleton";
import inputStyles from "../components/Input.module.css";
import styles from "./organizacoes.$organizationId.unidades.module.css";

type Row = OutputType["rows"][number];
type SourceId = Row["source"];

const occ = (n: number) => `${n} ${n === 1 ? "ocorrência" : "ocorrências"}`;

const KINDS: UnitClassificationKind[] = ["canonica", "alias", "ambigua", "desconhecida", "ausente"];

/** Mostra o valor como está gravado; vazio/espaços ficam explícitos para não parecerem "sumidos". */
function RawValue({ value }: { value: string | null }) {
  if (value === null) return <span className={styles.rawMuted}>(não informada)</span>;
  if (value.trim() === "") return <span className={styles.rawMuted}>(só espaços)</span>;
  const padded = value !== value.trim();
  return (
    <span className={styles.raw}>
      “{value}”{padded && <span className={styles.rawMuted}> (com espaços nas pontas)</span>}
    </span>
  );
}

export default function OrganizationUnitsPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = Number(params.organizationId);

  const [source, setSource] = useState<"" | SourceId>("");
  const [classification, setClassification] = useState<"" | UnitClassificationKind>("");
  const [valueText, setValueText] = useState("");
  const value = useDeferredValue(valueText.trim());

  const orgsQuery = useQuery({ queryKey: ["organizations"], queryFn: () => getOrganizations() });
  const org = orgsQuery.data?.organizations.find((o) => o.id === organizationId);
  // Mesma permissão do servidor (organizacao.gerencie). A UI nunca é a autoridade: o endpoint recusa (403) quem não a tem.
  const canView = org && (org.myRole === "proprietario" || org.myRole === "administrador");

  const query = useQuery({
    queryKey: ["unit-inventory", organizationId, source, classification, value],
    queryFn: () => getUnitInventory({ organizationId, source: source || undefined, classification: classification || undefined, value: value || undefined }),
    enabled: Number.isFinite(organizationId) && !!canView,
    retry: false, // 401/403/erro de rede não melhoram sozinhos: mostra o erro de uma vez, com "Tentar novamente"
  });

  const data = query.data;
  const hasFilters = source !== "" || classification !== "" || valueText.trim() !== "";
  const clearFilters = () => {
    setSource("");
    setClassification("");
    setValueText("");
  };

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.backLink}>
        <ArrowLeft size={16} /> Voltar ao painel
      </Link>

      <nav className={styles.tabNav}>
        <Link to={`/organizacoes/${organizationId}`} className={styles.tabNavItem}>Visão geral</Link>
        <Link to={`/organizacoes/${organizationId}/inventario`} className={styles.tabNavItem}>Inventário</Link>
        <Link to={`/organizacoes/${organizationId}/necessidades`} className={styles.tabNavItem}>Necessidades</Link>
        <Link to={`/organizacoes/${organizationId}/oportunidades`} className={styles.tabNavItem}>Oportunidades</Link>
        <Link to={`/organizacoes/${organizationId}/atribuicoes`} className={styles.tabNavItem}>Rede Levora</Link>
        <Link to={`/organizacoes/${organizationId}/prestacao-contas`} className={styles.tabNavItem}>Prestação de contas</Link>
        <Link to={`/organizacoes/${organizationId}/matching`} className={styles.tabNavItem}>Configurações de Matching</Link>
        <span className={styles.tabNavItemActive} aria-current="page">Unidades</span>
      </nav>

      <div className={styles.titleRow}>
        <div>
          <h1 className={styles.title}>Diagnóstico de unidades</h1>
          <p className={styles.subtitle}>
            Mostra quais valores de unidade a sua organização realmente tem cadastrados e quais já são reconhecidos com segurança. Tela somente de leitura.
          </p>
        </div>
      </div>

      <div className={styles.infoBanner} role="note">
        <Info size={16} aria-hidden="true" />
        <p>
          <strong>Classificar não é converter nem corrigir.</strong> Nenhum valor cadastrado é alterado, nenhuma quantidade é convertida e nenhum saldo muda. Valores
          desconhecidos ou ambíguos continuam exatamente como foram gravados e aguardam revisão humana para a regularização de unidades (Fase 99C).
        </p>
      </div>

      {org && !canView ? (
        <div className={styles.emptyState} role="status">
          <Ruler size={20} aria-hidden="true" />
          <p>Seu papel nesta organização ({org.myRole}) não permite ver este diagnóstico. Somente proprietário e administrador têm acesso.</p>
        </div>
      ) : (
        <>
          <section className={styles.summary} aria-label="Resumo da classificação">
            {query.isLoading || !data ? (
              query.isError ? null : <Skeleton className={styles.summarySkeleton} />
            ) : (
              <>
                <div className={styles.stat}>
                  <span className={styles.statValue}>{data.summary.distinctValues}</span>
                  <span className={styles.statLabel}>{data.summary.distinctValues === 1 ? "valor distinto" : "valores distintos"} em {occ(data.summary.totalOccurrences)}</span>
                </div>
                {KINDS.map((k) => (
                  <div key={k} className={styles.stat}>
                    <span className={styles.statValue}>{data.summary.byClassification[k].distinctValues}</span>
                    <span className={styles.statLabel}>
                      {UNIT_CLASSIFICATION_LABELS[k]} · {occ(data.summary.byClassification[k].occurrences)}
                    </span>
                  </div>
                ))}
                <div className={`${styles.stat} ${data.summary.pendingReviewValues > 0 ? styles.statAttention : ""}`}>
                  <span className={styles.statValue}>{data.summary.pendingReviewValues}</span>
                  <span className={styles.statLabel}>aguardando classificação (ambíguos + desconhecidos)</span>
                </div>
              </>
            )}
          </section>

          <section className={styles.section} aria-labelledby="filtros-titulo">
            <h2 id="filtros-titulo" className={styles.sectionTitle}>Filtros</h2>
            <div className={styles.filters}>
              <div className={styles.filterField}>
                <label htmlFor="filtro-origem" className={styles.filterLabel}>Origem</label>
                <select id="filtro-origem" className={`${inputStyles.input} ${styles.select}`} value={source} onChange={(e) => setSource(e.target.value as "" | SourceId)}>
                  <option value="">Todas as origens</option>
                  {(data?.sources ?? []).map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div className={styles.filterField}>
                <label htmlFor="filtro-classe" className={styles.filterLabel}>Classificação</label>
                <select id="filtro-classe" className={`${inputStyles.input} ${styles.select}`} value={classification} onChange={(e) => setClassification(e.target.value as "" | UnitClassificationKind)}>
                  <option value="">Todas as classificações</option>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>{UNIT_CLASSIFICATION_LABELS[k]}</option>
                  ))}
                </select>
              </div>
              <div className={styles.filterField}>
                <label htmlFor="filtro-valor" className={styles.filterLabel}>Valor contém</label>
                <input id="filtro-valor" type="search" maxLength={100} className={inputStyles.input} value={valueText} onChange={(e) => setValueText(e.target.value)} placeholder="ex.: kg" autoComplete="off" />
              </div>
              <div className={styles.filterActions}>
                <Button variant="outline" size="sm" onClick={clearFilters} disabled={!hasFilters}>
                  <RotateCcw size={14} /> Limpar filtros
                </Button>
              </div>
            </div>
          </section>

          <section className={styles.section} aria-labelledby="valores-titulo" aria-live="polite" aria-busy={query.isFetching}>
            <h2 id="valores-titulo" className={styles.sectionTitle}>Valores encontrados</h2>

            {query.isError ? (
              <div className={styles.errorState} role="alert">
                <p>Não foi possível carregar o diagnóstico de unidades. Seus dados não foram alterados.</p>
                <Button variant="outline" size="sm" onClick={() => query.refetch()}>Tentar novamente</Button>
              </div>
            ) : query.isLoading || !data ? (
              <Skeleton className={styles.listSkeleton} />
            ) : data.rows.length === 0 ? (
              <p className={styles.emptyText} role="status">
                {hasFilters
                  ? "Nenhum valor corresponde aos filtros aplicados."
                  : "Esta organização ainda não tem nenhum valor de unidade cadastrado."}
              </p>
            ) : (
              <>
                <p className={styles.resultCount}>{data.rows.length} {data.rows.length === 1 ? "linha" : "linhas"}{hasFilters ? " (filtradas)" : ""}</p>
                <table className={styles.table}>
                  <caption className={styles.srOnly}>Valores de unidade por origem, com a classificação e a unidade canônica proposta</caption>
                  <thead>
                    <tr>
                      <th scope="col">Origem</th>
                      <th scope="col">Valor armazenado</th>
                      <th scope="col">Ocorrências</th>
                      <th scope="col">Classificação</th>
                      <th scope="col">Unidade canônica</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr key={`${row.source}::${row.rawValue ?? "\u0000"}`}>
                        <td data-label="Origem">{row.sourceLabel}</td>
                        <td data-label="Valor armazenado"><RawValue value={row.rawValue} /></td>
                        <td data-label="Ocorrências" className={styles.num}>{row.occurrences}</td>
                        <td data-label="Classificação">
                          <span className={styles.kind} data-kind={row.classification}>{UNIT_CLASSIFICATION_LABELS[row.classification]}</span>
                          <p className={styles.explanation}>{row.explanation}</p>
                        </td>
                        <td data-label="Unidade canônica">
                          {row.canonicalLabel ? (
                            <span>{row.canonicalLabel}</span>
                          ) : row.candidates.length > 0 ? (
                            <span className={styles.rawMuted}>nenhuma (possíveis leituras: {row.candidates.join(", ")} — não aplicadas)</span>
                          ) : (
                            <span className={styles.rawMuted}>nenhuma</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data.truncated && (
                  <p className={styles.truncNotice} role="status">Há mais valores distintos do que o limite exibido; alguns não aparecem nesta lista.</p>
                )}
              </>
            )}
          </section>

          {data && (
            <section className={styles.section} aria-labelledby="origens-titulo">
              <h2 id="origens-titulo" className={styles.sectionTitle}>De onde vêm os valores</h2>
              <p className={styles.helperText}>Cada campo de unidade tem um significado diferente. O mesmo texto em campos diferentes nunca é tratado como a mesma quantidade.</p>
              <ul className={styles.sourceList}>
                {data.sources.map((s) => (
                  <li key={s.id} className={styles.sourceItem}>
                    <strong>{s.label}</strong> — {s.distinctValues} {s.distinctValues === 1 ? "valor distinto" : "valores distintos"}, {s.occurrences} {s.occurrences === 1 ? "ocorrência" : "ocorrências"}
                    <span className={styles.sourceMeaning}>{s.meaning}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
