import { z } from "zod";
import superjson from "superjson";
import type { Json } from "../helpers/schema";

export const schema = z.object({
  opportunityId: z.coerce.number().int().positive(),
});

export type OutputType = {
  evaluations: Array<{
    id: string;
    organizationId: number;
    organizationName: string;
    needId: number | null;
    needTitle: string | null;
    criteria: Json;
    finalScore: number;
    algorithmVersion: string;
    aiModelUsed: string | null;
    decision: string;
    allocationId: number | null;
    createdAt: string;
  }>;
};

export const getMatchEvaluations = async (
  query: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ opportunityId: String(validated.opportunityId) });
  const result = await fetch(`/_api/v1/match-evaluations?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar as avaliações de matching");
  }

  return superjson.parse<OutputType>(await result.text());
};
