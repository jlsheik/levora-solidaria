import { z } from "zod";
import superjson from "superjson";
import type { UnitClassificationKind, UnitDimension } from "../helpers/unitVocabulary.js";

const classificationValues = ["canonica", "alias", "ambigua", "desconhecida", "ausente"] as const;
const sourceValues = [
  "inventory_items",
  "needs",
  "donation_opportunities",
  "opportunity_registry",
  "organization_capacities",
  "need_fulfillments",
] as const;

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  source: z.enum(sourceValues).optional(),
  classification: z.enum(classificationValues).optional(),
  value: z.string().trim().max(100).optional(),
});

export type InputType = z.infer<typeof schema>;

export type OutputType = {
  /** Linhas já filtradas. Nenhuma contém ID de registro: só origem, valor bruto e contagem. */
  rows: Array<{
    source: (typeof sourceValues)[number];
    sourceLabel: string;
    /** Valor EXATAMENTE como está gravado (null = coluna vazia). */
    rawValue: string | null;
    occurrences: number;
    classification: UnitClassificationKind;
    canonicalId: string | null;
    canonicalLabel: string | null;
    dimension: UnitDimension | null;
    explanation: string;
    candidates: string[];
  }>;
  /** Totais SEM filtros (os filtros só afetam a lista). */
  summary: {
    distinctValues: number;
    totalOccurrences: number;
    pendingReviewValues: number;
    byClassification: Record<UnitClassificationKind, { distinctValues: number; occurrences: number }>;
  };
  /** Campos de unidade conhecidos, com o sentido de negócio de cada um, e quantos valores distintos cada origem tem. */
  sources: Array<{ id: (typeof sourceValues)[number]; label: string; meaning: string; distinctValues: number; occurrences: number }>;
  /** true quando alguma origem passou do limite de valores distintos exibidos. */
  truncated: boolean;
};

export const getUnitInventory = async (params: InputType, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(params);
  const searchParams = new URLSearchParams({ organizationId: String(validated.organizationId) });
  if (validated.source) searchParams.set("source", validated.source);
  if (validated.classification) searchParams.set("classification", validated.classification);
  if (validated.value) searchParams.set("value", validated.value);
  const result = await fetch(`/_api/v1/unit-inventory?${searchParams.toString()}`, {
    method: "GET",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar o inventário de unidades");
  }

  return superjson.parse<OutputType>(await result.text());
};
