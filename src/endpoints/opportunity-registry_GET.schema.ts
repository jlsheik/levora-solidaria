import { z } from "zod";
import superjson from "superjson";
import type { OpportunityRegistryStatus, OpportunityUrgency } from "../helpers/schema";

export const schema = z.object({
  status: z.string().optional(),
});

export type OutputType = {
  opportunities: Array<{
    id: number;
    sourceId: number;
    sourceName: string;
    title: string;
    description: string | null;
    category: string | null;
    quantity: number | null;
    unit: string | null;
    condition: string | null;
    locationCity: string | null;
    locationState: string | null;
    urgency: OpportunityUrgency;
    confidence: number | null;
    status: OpportunityRegistryStatus;
    statusReason: string | null;
    allocatedQuantity: number;
    createdAt: string;
  }>;
};

export const getOpportunityRegistry = async (
  query: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams();
  if (validated.status) params.set("status", validated.status);
  const result = await fetch(`/_api/v1/opportunity-registry?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar o registro central");
  }

  return superjson.parse<OutputType>(await result.text());
};
