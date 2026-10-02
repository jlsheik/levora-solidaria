import { z } from "zod";
import superjson from "superjson";
import type { LogisticsEventType } from "../helpers/schema.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  allocationId: z.coerce.number().int().positive(),
});

export type OutputType = {
  events: Array<{
    id: string;
    eventType: LogisticsEventType;
    scheduledFor: string | null;
    notes: string | null;
    proofUrl: string | null;
    actorDisplayName: string | null;
    occurredAt: string;
  }>;
};

export const getAllocationsLogistics = async (
  query: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(validated.organizationId), allocationId: String(validated.allocationId) });
  const result = await fetch(`/_api/v1/allocations-logistics?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar a linha do tempo");
  }

  return superjson.parse<OutputType>(await result.text());
};
