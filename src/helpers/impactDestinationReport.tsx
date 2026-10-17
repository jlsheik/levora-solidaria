/**
 * Fase 99H — bloco "Destinação" da prestação de contas (CAMADA DE LEITURA; nada aqui escreve). Fonte única: `stock_destinations` (destinação final) e `stock_transactions` (físico).
 * Regras (docs/DESTINACAO_E_PRESTACAO_DE_CONTAS_ESPECIFICACAO.md, seções 8, 14.5 e 15; critérios E-01..E-07, U-10):
 *   - físico × contabilizável SEMPRE em colunas separadas e agregados por finalidade × item × UNIDADE (nunca se somam unidades diferentes);
 *   - o atendimento (aplicado) usa a mesma regra da 99F: LEAST(aplicada, física − revertida) só para originais contabilizáveis; o excedente autorizado é mostrado à parte;
 *   - indicadores de operação, terceiros, devoluções ao doador, perdas e descartes ficam fora do atendimento e fora uns dos outros;
 *   - saídas SEM destinação estruturada em duas subclasses: baixa automática histórica (resolução da necessidade) e sem destinação (herdadas); nada é reclassificado;
 *   - data de REGISTRO (`created_at`) ou data EFETIVA (`delivered_on`, calendário do fuso de negócio) — escolha explícita do chamador, nunca misturadas;
 *   - o revertido de cada original é o acumulado até agora (as reversões têm data própria e aparecem contadas à parte, por data de registro).
 */
import { sql, type Kysely } from "kysely";
import type { DB } from "./schema.js";
import { businessDateOf } from "./businessDate.js";
import type { DestinationType } from "./destinationRules.js";

export type DestinationDateBasis = "registro" | "efetiva";

export const INDICATOR_GROUPS = ["atendimento", "operacao", "terceiros", "devolucao_ao_doador", "perdas", "descartes"] as const;
export type IndicatorGroup = (typeof INDICATOR_GROUPS)[number];

export const INDICATOR_GROUP_OF: Record<DestinationType, IndicatorGroup> = {
  atendimento_coletivo: "atendimento",
  distribuicao_familias: "atendimento",
  entrega_instituicao_parceira: "atendimento",
  uso_operacional_instituicao: "operacao",
  doacao_a_terceiro: "terceiros",
  devolucao_ao_doador: "devolucao_ao_doador",
  perda: "perdas",
  descarte: "descartes",
};

export interface DestinationParams {
  organizationId: number;
  startDate: Date;
  /** EXCLUSIVO. */
  endDate: Date;
  itemId: number | null;
  needId: number | null;
  destinationType: DestinationType | null;
  basis: DestinationDateBasis;
}

export interface DestinationPurposeRow {
  destinationType: DestinationType;
  itemId: number;
  itemName: string;
  unit: string;
  records: number;
  /** Físico que saiu (soma das originais). */
  physical: number;
  reverted: number;
  physicalNet: number;
  /** Contabilizável: aplicado ao atendimento de necessidades, líquido de reversões (mesma regra da 99F). */
  appliedNet: number;
  /** Excedente físico autorizado ainda existente (não conta como atendimento). */
  surplusNet: number;
  /** Físico ligado a necessidade em unidade incompatível (não conta). */
  incompatibleNet: number;
  /** Soma das quantidades DECLARADAS nos registros ainda não revertidos por inteiro (não é número de pessoas distintas). */
  declaredPeople: { pessoas: number; familias: number };
}

export interface WithoutDestinationRow {
  itemId: number;
  itemName: string;
  unit: string;
  count: number;
  quantity: number;
}

export interface DestinationReport {
  basis: DestinationDateBasis;
  filters: { destinationType: DestinationType | null };
  /** Originais dentro do período (e filtros). */
  records: number;
  correctedRecords: number;
  revertedRecords: number;
  byPurpose: DestinationPurposeRow[];
  /** Indicadores separados por grupo e unidade (físico líquido). Nunca somam unidades diferentes. */
  indicators: Array<{ group: IndicatorGroup; unit: string; physicalNet: number }>;
  /** Eventos corretivos criados no período (data de registro), à parte dos registros acima. */
  eventsInPeriod: { corrections: number; estornoDocumental: number; devolucaoFisica: number; correcaoQuantidade: number };
  withoutStructuredDestination: {
    windowBasis: "registro";
    automaticHistorical: WithoutDestinationRow[];
    notClassified: WithoutDestinationRow[];
  };
}

const num = (v: unknown) => Number(v ?? 0);

export async function buildDestinationReport(db: Kysely<DB>, p: DestinationParams): Promise<DestinationReport> {
  const org = p.organizationId;
  const s = p.startDate;
  const e = p.endDate;
  const itemCond = p.itemId !== null ? sql`AND d.item_id = ${p.itemId}` : sql``;
  const needCond = p.needId !== null ? sql`AND d.need_id = ${p.needId}` : sql``;
  const typeCond = p.destinationType !== null ? sql`AND d.destination_type = ${p.destinationType}` : sql``;
  const windowCond =
    p.basis === "registro"
      ? sql`AND d.created_at >= ${s} AND d.created_at < ${e}`
      : sql`AND d.delivered_on >= ${businessDateOf(s)}::date AND d.delivered_on < ${businessDateOf(e)}::date`;

  const rows = (
    await sql<{
      destinationType: DestinationType;
      itemId: number;
      itemName: string;
      unit: string;
      records: string;
      physical: string;
      reverted: string;
      physicalNet: string;
      appliedNet: string;
      incompatibleNet: string;
      surplusNet: string;
      persons: string;
      families: string;
      corrected: string;
      revertedRecords: string;
    }>`
    WITH rev AS (
      SELECT reverses_destination_id AS id, SUM(quantity) AS q
        FROM stock_destinations WHERE organization_id = ${org} AND entry_type = 'reversal' GROUP BY reverses_destination_id
    )
    SELECT d.destination_type, d.item_id, i.name AS item_name, d.unit,
           count(*) AS records,
           coalesce(sum(d.quantity), 0) AS physical,
           coalesce(sum(coalesce(r.q, 0)), 0) AS reverted,
           coalesce(sum(d.quantity - coalesce(r.q, 0)), 0) AS physical_net,
           coalesce(sum(CASE WHEN d.is_countable THEN LEAST(coalesce(d.applied_quantity, d.quantity), d.quantity - coalesce(r.q, 0)) ELSE 0 END), 0) AS applied_net,
           coalesce(sum(CASE WHEN d.is_countable THEN (d.quantity - coalesce(r.q, 0)) - LEAST(coalesce(d.applied_quantity, d.quantity), d.quantity - coalesce(r.q, 0)) ELSE 0 END), 0) AS surplus_net,
           coalesce(sum(CASE WHEN d.need_id IS NOT NULL AND NOT d.is_countable THEN d.quantity - coalesce(r.q, 0) ELSE 0 END), 0) AS incompatible_net,
           coalesce(sum(pe.people) FILTER (WHERE pe.people_unit = 'pessoas' AND coalesce(r.q, 0) < d.quantity), 0) AS persons,
           coalesce(sum(pe.people) FILTER (WHERE pe.people_unit = 'familias' AND coalesce(r.q, 0) < d.quantity), 0) AS families,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM stock_destinations c WHERE c.entry_type = 'correction' AND c.reverses_destination_id = d.id)) AS corrected,
           count(*) FILTER (WHERE r.q IS NOT NULL) AS reverted_records
      FROM stock_destinations d
      JOIN inventory_items i ON i.id = d.item_id AND i.organization_id = ${org}
      LEFT JOIN rev r ON r.id = d.id
      LEFT JOIN LATERAL (
        SELECT coalesce(
                 (SELECT c.people_served FROM stock_destinations c WHERE c.entry_type = 'correction' AND c.reverses_destination_id = d.id AND c.people_served IS NOT NULL ORDER BY c.id DESC LIMIT 1),
                 d.people_served) AS people,
               coalesce(
                 (SELECT c.people_unit FROM stock_destinations c WHERE c.entry_type = 'correction' AND c.reverses_destination_id = d.id AND c.people_served IS NOT NULL ORDER BY c.id DESC LIMIT 1),
                 d.people_unit) AS people_unit
      ) pe ON true
     WHERE d.organization_id = ${org} AND d.entry_type = 'original' ${windowCond} ${itemCond} ${needCond} ${typeCond}
     GROUP BY d.destination_type, d.item_id, i.name, d.unit
     ORDER BY d.destination_type, i.name, d.item_id, d.unit
  `.execute(db)
  ).rows;

  const byPurpose: DestinationPurposeRow[] = rows.map((r) => {
    const physicalNet = num(r.physicalNet);
    const appliedNet = num(r.appliedNet);
    const incompatibleNet = num(r.incompatibleNet);
    return {
      destinationType: r.destinationType,
      itemId: r.itemId,
      itemName: r.itemName,
      unit: r.unit,
      records: num(r.records),
      physical: num(r.physical),
      reverted: num(r.reverted),
      physicalNet,
      appliedNet,
      surplusNet: num(r.surplusNet),
      incompatibleNet,
      declaredPeople: { pessoas: num(r.persons), familias: num(r.families) },
    };
  });

  // indicadores por grupo e unidade (físico líquido); atendimento = aplicado, não o físico
  const indicatorMap = new Map<string, { group: IndicatorGroup; unit: string; physicalNet: number }>();
  for (const r of byPurpose) {
    const group = INDICATOR_GROUP_OF[r.destinationType];
    const value = group === "atendimento" ? r.appliedNet : r.physicalNet;
    const k = `${group}|${r.unit}`;
    const cur = indicatorMap.get(k) ?? { group, unit: r.unit, physicalNet: 0 };
    cur.physicalNet = Math.round((cur.physicalNet + value) * 1000) / 1000;
    indicatorMap.set(k, cur);
  }
  const indicators = [...indicatorMap.values()].sort((a, b) => INDICATOR_GROUPS.indexOf(a.group) - INDICATOR_GROUPS.indexOf(b.group) || a.unit.localeCompare(b.unit));

  // eventos corretivos criados no período (data de registro), com os mesmos filtros de item/necessidade (via a original)
  const ev = (
    await sql<{ corrections: string; estorno: string; devolucao: string; quantidade: string }>`
    SELECT count(*) FILTER (WHERE x.entry_type = 'correction') AS corrections,
           count(*) FILTER (WHERE x.reversal_kind = 'estorno_documental') AS estorno,
           count(*) FILTER (WHERE x.reversal_kind = 'devolucao_fisica') AS devolucao,
           count(*) FILTER (WHERE x.reversal_kind = 'correcao_quantidade') AS quantidade
      FROM stock_destinations x
      JOIN stock_destinations d ON d.id = x.reverses_destination_id AND d.organization_id = ${org}
     WHERE x.organization_id = ${org} AND x.entry_type IN ('correction', 'reversal') AND x.created_at >= ${s} AND x.created_at < ${e} ${itemCond} ${needCond} ${typeCond}
  `.execute(db)
  ).rows[0];

  // saídas SEM destinação estruturada (data de registro da saída); duas subclasses
  const itemSt = p.itemId !== null ? sql`AND st.item_id = ${p.itemId}` : sql``;
  const needSt = p.needId !== null ? sql`AND nr.need_id = ${p.needId}` : sql``;
  const withoutRows = (
    await sql<{ itemId: number; itemName: string; unit: string; automatic: boolean; n: string; q: string }>`
    SELECT st.item_id, i.name AS item_name, i.unit, (nr.id IS NOT NULL) AS automatic, count(*) AS n, coalesce(sum(-st.delta), 0) AS q
      FROM stock_transactions st
      JOIN inventory_items i ON i.id = st.item_id AND i.organization_id = ${org}
      LEFT JOIN need_resolutions nr ON nr.stock_transaction_id = st.id
     WHERE st.organization_id = ${org} AND st.type = 'saida' AND st.created_at >= ${s} AND st.created_at < ${e} ${itemSt} ${needSt}
       AND NOT EXISTS (SELECT 1 FROM stock_destinations o WHERE o.stock_transaction_id = st.id AND o.entry_type = 'original' AND o.organization_id = ${org})
     GROUP BY st.item_id, i.name, i.unit, (nr.id IS NOT NULL)
     ORDER BY i.name, st.item_id
  `.execute(db)
  ).rows;
  const toWithout = (automatic: boolean): WithoutDestinationRow[] =>
    withoutRows.filter((r) => r.automatic === automatic).map((r) => ({ itemId: r.itemId, itemName: r.itemName, unit: r.unit, count: num(r.n), quantity: num(r.q) }));

  return {
    basis: p.basis,
    filters: { destinationType: p.destinationType },
    records: byPurpose.reduce((sum, r) => sum + r.records, 0),
    correctedRecords: rows.reduce((sum, r) => sum + num(r.corrected), 0),
    revertedRecords: rows.reduce((sum, r) => sum + num(r.revertedRecords), 0),
    byPurpose,
    indicators,
    eventsInPeriod: { corrections: num(ev.corrections), estornoDocumental: num(ev.estorno), devolucaoFisica: num(ev.devolucao), correcaoQuantidade: num(ev.quantidade) },
    withoutStructuredDestination: { windowBasis: "registro", automaticHistorical: toWithout(true), notClassified: toWithout(false) },
  };
}
