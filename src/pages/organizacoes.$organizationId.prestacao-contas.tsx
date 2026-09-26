import React, { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getOrganizations } from "../endpoints/organizations_GET.schema";
import { getImpactReport } from "../endpoints/impact-report_GET.schema";
import { Input } from "../components/Input";
import { Button } from "../components/Button";
import { Skeleton } from "../components/Skeleton";
import { ArrowLeft, FileText, Printer, ShieldAlert } from "lucide-react";
import styles from "./organizacoes.$organizationId.prestacao-contas.module.css";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function ImpactReportPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = Number(params.organizationId);

  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const [startDate, setStartDate] = useState(isoDate(firstOfMonth));
  const [endDate, setEndDate] = useState(isoDate(today));

  const orgsQuery = useQuery({ queryKey: ["organizations"], queryFn: () => getOrganizations() });
  const org = orgsQuery.data?.organizations.find((o) => o.id === organizationId);
  const canView = org && (org.myRole === "proprietario" || org.myRole === "administrador");

  const reportQuery = useQuery({
    queryKey: ["impact-report", organizationId, startDate, endDate],
    queryFn: () =>
      getImpactReport({
        organizationId,
        startDate: new Date(`${startDate}T00:00:00`),
        endDate: new Date(`${endDate}T23:59:59`),
      }),
    enabled: Number.isFinite(organizationId) && !!canView,
  });

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
        <span className={styles.tabNavItemActive}>Prestação de contas</span>
        <Link to={`/organizacoes/${organizationId}/matching`} className={styles.tabNavItem}>Configurações de Matching</Link>
      </nav>

      <div className={styles.titleRow}>
        <div>
          <h1 className={styles.title}><FileText size={20} /> Prestação de contas</h1>
          <p className={styles.subtitle}>
            Calculado ao vivo a partir do histórico real de estoque e auditoria
            — não é um número guardado à parte, é sempre a soma do que
            realmente aconteceu no período.
          </p>
        </div>
        {reportQuery.data && (
          <Button variant="outline" size="sm" onClick={() => window.print()} className={styles.noPrint}>
            <Printer size={14} /> Imprimir / salvar PDF
          </Button>
        )}
      </div>

      {org && !canView ? (
        <div className={styles.notAllowed}>
          <ShieldAlert size={28} />
          <p>Prestação de contas é visível só para proprietário e administrador desta organização.</p>
        </div>
      ) : (
        <>
          <div className={styles.filters}>
            <div>
              <label className={styles.filterLabel}>De</label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className={styles.filterLabel}>Até</label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>

          {reportQuery.isFetching && !reportQuery.data ? (
            <Skeleton className={styles.reportSkeleton} />
          ) : reportQuery.data ? (
            <div className={styles.report}>
              <h2 className={styles.reportTitle}>{reportQuery.data.organizationName}</h2>
              <p className={styles.reportPeriod}>
                Período: {new Date(reportQuery.data.period.startDate).toLocaleDateString("pt-BR")} a{" "}
                {new Date(reportQuery.data.period.endDate).toLocaleDateString("pt-BR")}
              </p>

              <div className={styles.summaryGrid}>
                <div className={styles.summaryCard}>
                  <span className={styles.summaryValue}>{reportQuery.data.needsSummary.abertasNoPeriodo}</span>
                  <span className={styles.summaryLabel}>Necessidades cadastradas</span>
                </div>
                <div className={styles.summaryCard}>
                  <span className={styles.summaryValue}>{reportQuery.data.needsSummary.atendidasNoPeriodo}</span>
                  <span className={styles.summaryLabel}>Necessidades atendidas</span>
                </div>
                <div className={styles.summaryCard}>
                  <span className={styles.summaryValue}>{reportQuery.data.receivedTransactions.length}</span>
                  <span className={styles.summaryLabel}>Recebimentos registrados</span>
                </div>
                <div className={styles.summaryCard}>
                  <span className={styles.summaryValue}>{reportQuery.data.auditEventCount}</span>
                  <span className={styles.summaryLabel}>Eventos na trilha de auditoria</span>
                </div>
              </div>

              <h3 className={styles.sectionTitle}>Movimentação de estoque por item</h3>
              {reportQuery.data.itemMovements.length === 0 ? (
                <p className={styles.emptyText}>Nenhuma movimentação de estoque neste período.</p>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Entradas</th>
                      <th>Saídas</th>
                      <th>Ajustes</th>
                      <th>Saldo no período</th>
                      <th>Saldo atual</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportQuery.data.itemMovements.map((m) => (
                      <tr key={m.itemId}>
                        <td>{m.itemName} ({m.unit})</td>
                        <td>+{m.entradas}</td>
                        <td>-{m.saidas}</td>
                        <td>{m.ajustes >= 0 ? "+" : ""}{m.ajustes}</td>
                        <td>{m.netChange >= 0 ? "+" : ""}{m.netChange}</td>
                        <td>{m.currentStock}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <h3 className={styles.sectionTitle}>Doações recebidas no período</h3>
              {reportQuery.data.receivedTransactions.length === 0 ? (
                <p className={styles.emptyText}>Nenhum recebimento registrado neste período.</p>
              ) : (
                <ul className={styles.receivedList}>
                  {reportQuery.data.receivedTransactions.map((t) => (
                    <li key={t.id} className={styles.receivedRow}>
                      <strong>+{t.delta} {t.unit}</strong> de {t.itemName} — {t.reason} —{" "}
                      {new Date(t.createdAt).toLocaleDateString("pt-BR")}
                    </li>
                  ))}
                </ul>
              )}

              <p className={styles.disclaimer}>
                Este relatório mostra quantidades e unidades, não valores
                monetários — o cadastro de itens não tem preço associado, e
                inventar um valor seria menos honesto do que não mostrar
                nenhum. "Necessidades atendidas/canceladas no período" usa a
                data da última alteração de status como aproximação.
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
