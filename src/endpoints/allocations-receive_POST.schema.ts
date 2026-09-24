import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  allocationId: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive(),
  quantityReceived: z.coerce.number().positive("Informe a quantidade realmente recebida"),
  notes: z.string().optional(),
  proofUrl: z.string().optional(),
});

export type OutputType = {
  allocation: { id: number; status: string };
  stockTransactionId: string;
  newStock: number;
};

export const postAllocationsReceive = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/allocations-receive`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível registrar o recebimento");
  }

  return superjson.parse<OutputType>(await result.text());
};
