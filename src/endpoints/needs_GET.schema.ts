import { z } from "zod";
import superjson from "superjson";
import type { NeedPriority, NeedStatus } from "../helpers/schema";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
});

export type OutputType = {
  needs: Array<{
    id: number;
    title: string;
    description: string | null;
    itemId: number | null;
    itemName: string | null;
    quantityNeeded: number;
    unit: string;
    priority: NeedPriority;
    status: NeedStatus;
    createdByDisplayName: string;
    createdAt: string;
  }>;
};

export const getNeeds = async (
  query: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(validated.organizationId) });
  const result = await fetch(`/_api/v1/needs?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar as necessidades");
  }

  return superjson.parse<OutputType>(await result.text());
};
