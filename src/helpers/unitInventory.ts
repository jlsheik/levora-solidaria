/**
 * Fase 99B — inventário de valores de unidade de UMA organização (somente leitura).
 *
 * Agrega NO BANCO (GROUP BY) cada campo de unidade conhecido, escopado por `organization_id`,
 * e classifica cada valor distinto com `unitVocabulary`. Não devolve IDs de registros nem
 * conteúdo de registros: só (origem, valor bruto, ocorrências). Não escreve em nada.
 */
import { sql } from "kysely";
import { db } from "./db.js";
import { classifyUnit, UNIT_CLASSIFICATION_KINDS, type UnitClassification, type UnitClassificationKind } from "./unitVocabulary.js";

export interface UnitSourceDefinition {
  readonly id: string;
  readonly label: string;
  /** Semântica de negócio do campo (quando a unidade adquire significado). */
  readonly meaning: string;
  readonly table: string;
  readonly column: string;
  readonly nullable: boolean;
}

/**
 * TODOS os campos de unidade do schema (db/schema.sql). `stock_transactions` não tem coluna de
 * unidade: o saldo é expresso na unidade do item (`inventory_items.unit`).
 * `opportunity_registry.unit` é global (sem organização): só entra pelas atribuições da própria
 * organização, para não expor ofertas de outras.
 */
export const UNIT_SOURCES: readonly UnitSourceDefinition[] = [
  { id: "inventory_items", label: "Item de estoque", meaning: "Unidade do saldo do item: todas as movimentações são expressas nela.", table: "inventory_items", column: "unit", nullable: false },
  { id: "needs", label: "Necessidade", meaning: "Unidade em que a quantidade necessária foi pedida; comparada à do item por texto normalizado.", table: "needs", column: "unit", nullable: false },
  { id: "donation_opportunities", label: "Doação local", meaning: "Unidade informada pela organização na doação local (opcional); hoje não é lida no recebimento.", table: "donation_opportunities", column: "unit", nullable: true },
  { id: "opportunity_registry", label: "Oferta da rede (atribuída)", meaning: "Unidade da oferta da rede atribuída à organização (opcional); hoje não é lida no recebimento.", table: "opportunity_registry", column: "unit", nullable: true },
  { id: "organization_capacities", label: "Capacidade de armazenamento", meaning: "Unidade da capacidade declarada; usada pelo matching junto da categoria.", table: "organization_capacities", column: "unit", nullable: false },
  { id: "need_fulfillments", label: "Suprimento recebido (ledger)", meaning: "Unidade copiada do item no recebimento da rede; registro imutável.", table: "need_fulfillments", column: "unit", nullable: false },
] as const;

export const UNIT_SOURCE_IDS = UNIT_SOURCES.map((s) => s.id) as [string, ...string[]];

/** Limite de valores distintos por origem (defesa; uma organização real tem poucos). */
const MAX_DISTINCT_PER_SOURCE = 500;

export interface UnitInventoryRow extends UnitClassification {
  readonly source: string;
  readonly sourceLabel: string;
  readonly occurrences: number;
}

export interface UnitInventory {
  readonly rows: UnitInventoryRow[];
  readonly truncated: boolean;
}

interface RawAggregate {
  source: string;
  raw: string | null;
  occurrences: number;
}

async function aggregateSource(def: UnitSourceDefinition, organizationId: number): Promise<{ rows: RawAggregate[]; truncated: boolean }> {
  // Identificadores vêm da constante acima (nunca de entrada do usuário); o organizationId é parâmetro.
  const table = sql.table(def.table);
  const column = sql.ref(`${def.table}.${def.column}`);
  const result =
    def.id === "opportunity_registry"
      ? await sql<{ raw: string | null; occurrences: string }>`
          SELECT opportunity_registry.unit AS raw, COUNT(DISTINCT opportunity_registry.id) AS occurrences
          FROM opportunity_registry
          WHERE EXISTS (
            SELECT 1 FROM opportunity_allocations a
            WHERE a.opportunity_registry_id = opportunity_registry.id AND a.organization_id = ${organizationId}
          )
          GROUP BY opportunity_registry.unit
          ORDER BY occurrences DESC, raw ASC NULLS FIRST
          LIMIT ${MAX_DISTINCT_PER_SOURCE + 1}`.execute(db)
      : await sql<{ raw: string | null; occurrences: string }>`
          SELECT ${column} AS raw, COUNT(*) AS occurrences
          FROM ${table}
          WHERE ${sql.ref(`${def.table}.organization_id`)} = ${organizationId}
          GROUP BY ${column}
          ORDER BY occurrences DESC, raw ASC NULLS FIRST
          LIMIT ${MAX_DISTINCT_PER_SOURCE + 1}`.execute(db);
  const truncated = result.rows.length > MAX_DISTINCT_PER_SOURCE;
  return {
    rows: result.rows.slice(0, MAX_DISTINCT_PER_SOURCE).map((r) => ({ source: def.id, raw: r.raw, occurrences: Number(r.occurrences) })),
    truncated,
  };
}

export async function loadUnitInventory(organizationId: number): Promise<UnitInventory> {
  const perSource = await Promise.all(UNIT_SOURCES.map((def) => aggregateSource(def, organizationId)));
  const labelBySource = new Map(UNIT_SOURCES.map((s) => [s.id, s.label]));
  const rows: UnitInventoryRow[] = perSource.flatMap((p) =>
    p.rows.map((r) => ({ ...classifyUnit(r.raw), source: r.source, sourceLabel: labelBySource.get(r.source) ?? r.source, occurrences: r.occurrences }))
  );
  return { rows, truncated: perSource.some((p) => p.truncated) };
}

export interface UnitInventorySummary {
  /** Valores brutos distintos (comparação exata, sem normalizar) em todas as origens. */
  readonly distinctValues: number;
  readonly totalOccurrences: number;
  readonly byClassification: Record<UnitClassificationKind, { distinctValues: number; occurrences: number }>;
  /** Valores (distintos) que ainda exigem revisão humana: ambíguos + desconhecidos. */
  readonly pendingReviewValues: number;
}

export function summarizeUnitInventory(rows: readonly UnitInventoryRow[]): UnitInventorySummary {
  const distinctAll = new Set<string>();
  const distinctByKind = new Map<UnitClassificationKind, Set<string>>(UNIT_CLASSIFICATION_KINDS.map((k) => [k, new Set<string>()]));
  const occurrencesByKind = new Map<UnitClassificationKind, number>(UNIT_CLASSIFICATION_KINDS.map((k) => [k, 0]));
  let total = 0;
  for (const row of rows) {
    const id = row.raw === null ? "\u0000null" : `v:${row.raw}`;
    distinctAll.add(id);
    distinctByKind.get(row.kind)!.add(id);
    occurrencesByKind.set(row.kind, occurrencesByKind.get(row.kind)! + row.occurrences);
    total += row.occurrences;
  }
  const byClassification = Object.fromEntries(
    UNIT_CLASSIFICATION_KINDS.map((k) => [k, { distinctValues: distinctByKind.get(k)!.size, occurrences: occurrencesByKind.get(k)! }])
  ) as UnitInventorySummary["byClassification"];
  return {
    distinctValues: distinctAll.size,
    totalOccurrences: total,
    byClassification,
    pendingReviewValues: byClassification.ambigua.distinctValues + byClassification.desconhecida.distinctValues,
  };
}

export interface UnitInventoryFilters {
  source?: string;
  classification?: UnitClassificationKind;
  /** Busca por trecho do valor bruto (sem diferenciar caixa). */
  value?: string;
}

export function filterUnitInventory(rows: readonly UnitInventoryRow[], filters: UnitInventoryFilters): UnitInventoryRow[] {
  const needle = filters.value?.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!filters.source || r.source === filters.source) &&
      (!filters.classification || r.kind === filters.classification) &&
      (!needle || (r.raw !== null && r.raw.toLowerCase().includes(needle)))
  );
}
