import { z } from "zod";
import superjson from "superjson";
import type { DestinationView } from "../helpers/destinationCorrections.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive().optional(),
  needId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  beforeId: z.string().regex(/^\d{1,18}$/).optional(),
});

export type InputType = z.input<typeof schema>;
/** Destinações originais com correções e reversões, saldo reversível e efeito físico de cada evento (Fase 99G). */
export type OutputType = { destinations: DestinationView[]; hasMore: boolean; canReverse: boolean };

export const getStockDestinations = async (params: InputType, init?: RequestInit): Promise<OutputType> => {
  const q = new URLSearchParams();
  q.set("organizationId", String(params.organizationId));
  if (params.itemId) q.set("itemId", String(params.itemId));
  if (params.needId) q.set("needId", String(params.needId));
  if (params.limit) q.set("limit", String(params.limit));
  if (params.beforeId) q.set("beforeId", params.beforeId);
  const result = await fetch(`/_api/v1/stock-destinations?${q.toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar as destinações");
  }
  return superjson.parse<OutputType>(await result.text());
};
