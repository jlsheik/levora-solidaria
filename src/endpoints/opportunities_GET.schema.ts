import { z } from "zod";
import superjson from "superjson";
import type { OpportunityStatus } from "../helpers/schema";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
});

export type OutputType = {
  opportunities: Array<{
    id: number;
    title: string;
    description: string | null;
    category: string | null;
    quantityOffered: number | null;
    unit: string | null;
    donorName: string;
    donorContact: string | null;
    linkedNeedId: number | null;
    linkedNeedTitle: string | null;
    status: OpportunityStatus;
    createdByDisplayName: string;
    createdAt: string;
  }>;
};

export const getOpportunities = async (
  query: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(validated.organizationId) });
  const result = await fetch(`/_api/opportunities?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar as oportunidades");
  }

  return superjson.parse<OutputType>(await result.text());
};
