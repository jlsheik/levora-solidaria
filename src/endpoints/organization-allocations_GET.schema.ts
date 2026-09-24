import { z } from "zod";
import superjson from "superjson";
import type { AllocationStatus, OpportunityUrgency } from "../helpers/schema";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
});

export type OutputType = {
  allocations: Array<{
    id: number;
    status: AllocationStatus;
    quantityAllocated: number;
    notes: string | null;
    createdAt: string;
    opportunityId: number;
    opportunityTitle: string;
    opportunityDescription: string | null;
    opportunityCategory: string | null;
    opportunityUnit: string | null;
    opportunityUrgency: OpportunityUrgency;
    opportunityLocationCity: string | null;
    opportunityLocationState: string | null;
    sourceName: string;
  }>;
};

export const getOrganizationAllocations = async (
  query: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(validated.organizationId) });
  const result = await fetch(`/_api/organization-allocations?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar as atribuições");
  }

  return superjson.parse<OutputType>(await result.text());
};
