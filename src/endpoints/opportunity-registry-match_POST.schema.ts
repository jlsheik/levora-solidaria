import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  opportunityId: z.coerce.number().int().positive(),
});

export type OutputType = {
  skipped: boolean;
  reason?: string;
  allocationsCreated: Array<{ organizationId: number; quantity: number; status: string; score: number }>;
  discarded: Array<{ organizationId: number; needId: number; score: number }>;
};

export const postOpportunityRegistryMatch = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/opportunity-registry-match`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível rodar o matching");
  }

  return superjson.parse<OutputType>(await result.text());
};
