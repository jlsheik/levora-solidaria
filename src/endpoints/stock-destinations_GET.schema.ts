import { z } from "zod";
import superjson from "superjson";
import type { DestinationTotals, DestinationView } from "../helpers/destinationCorrections.js";
import { DESTINATION_TYPES } from "../helpers/destinationRules.js";
import { DESTINATION_DATE_BASES, DESTINATION_STATES, validateDateRange } from "../helpers/destinationFilters.js";

const blank = (v: unknown) => (v === null || v === "" || v === undefined ? undefined : v);
const civil = z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use o formato AAAA-MM-DD").optional());

/** Fase 99I — histórico de destinações com filtros. Datas civis (AAAA-MM-DD, fuso America/Sao_Paulo), ambas INCLUSIVAS; `basis` escolhe a data (registro × efetiva). */
export const schema = z
  .object({
    organizationId: z.coerce.number().int().positive(),
    itemId: z.preprocess(blank, z.coerce.number().int().positive().optional()),
    needId: z.preprocess(blank, z.coerce.number().int().positive().optional()),
    destinationType: z.preprocess(blank, z.enum(DESTINATION_TYPES).optional()),
    state: z.preprocess(blank, z.enum(DESTINATION_STATES).optional()),
    basis: z.preprocess(blank, z.enum(DESTINATION_DATE_BASES).default("registro")),
    from: civil,
    to: civil,
    limit: z.preprocess(blank, z.coerce.number().int().min(1).max(100).default(30)),
    beforeId: z.preprocess(blank, z.string().regex(/^\d{1,18}$/).optional()),
  })
  .superRefine((v, ctx) => {
    const err = validateDateRange(v.from, v.to);
    if (err) ctx.addIssue({ code: "custom", path: ["from"], message: err });
  });

export type InputType = z.input<typeof schema>;
/** `totals` cobre TODO o conjunto filtrado, por unidade (unidades diferentes nunca se somam). Exportação não faz parte desta fase. */
export type OutputType = { destinations: DestinationView[]; hasMore: boolean; canReverse: boolean; totals: DestinationTotals; filters: { basis: "registro" | "efetiva"; from: string | null; to: string | null } };

export const getStockDestinations = async (params: InputType, init?: RequestInit): Promise<OutputType> => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const result = await fetch(`/_api/v1/stock-destinations?${q.toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar as destinações");
  }
  return superjson.parse<OutputType>(await result.text());
};
