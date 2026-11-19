import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({ organizationId: z.coerce.number().int().positive(), opportunityId: z.coerce.number().int().positive() });
export type OutputType = { changes: Array<{ id: string; field: "category"; previousValue: string | null; newValue: string | null; versionBefore: number; versionAfter: number; changedByName: string | null; correlationId: string; reason: string | null; createdAt: string }> };

export const getOpportunityChanges = async (query: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const v = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(v.organizationId), opportunityId: String(v.opportunityId) });
  const result = await fetch(`/_api/v1/opportunity-changes?${params.toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar o histórico da oportunidade");
  }
  return superjson.parse<OutputType>(await result.text());
};
