import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type OutputType = {
  transactions: Array<{
    id: string;
    itemId: number;
    itemName: string;
    type: string;
    delta: number;
    reason: string | null;
    actorDisplayName: string | null;
    createdAt: string;
  }>;
};

export const getStockTransactions = async (
  query: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(validated.organizationId) });
  if (validated.itemId) params.set("itemId", String(validated.itemId));
  if (validated.limit) params.set("limit", String(validated.limit));
  const result = await fetch(`/_api/v1/stock-transactions?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar o histórico de estoque");
  }

  return superjson.parse<OutputType>(await result.text());
};
