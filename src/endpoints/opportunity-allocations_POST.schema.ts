import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  opportunityId: z.coerce.number().int().positive(),
  organizationId: z.coerce.number().int().positive(),
  quantityAllocated: z.coerce.number().positive("Informe uma quantidade maior que zero"),
  notes: z.string().optional(),
});

export type OutputType = {
  allocation: { id: number; status: string };
  opportunityStatus: string;
};

export const postOpportunityAllocations = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/opportunity-allocations`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível atribuir a oportunidade");
  }

  return superjson.parse<OutputType>(await result.text());
};
