import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  allocationId: z.coerce.number().int().positive(),
  decision: z.enum(["aceita", "recusada"]),
});

export type OutputType = {
  allocation: { id: number; status: string };
};

export const postAllocationsDecide = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/allocations-decide`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível registrar a decisão");
  }

  return superjson.parse<OutputType>(await result.text());
};
