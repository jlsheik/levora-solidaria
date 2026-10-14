import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  opportunityId: z.coerce.number().int().positive(),
  organizationId: z.coerce.number().int().positive(),
});

export type OutputType = {
  /** Recusas/cancelamentos EXPLÍCITOS anteriores desta organização para esta oportunidade (vazio = nenhum aviso). */
  refusals: Array<{ allocationId: number; kind: "recusada" | "cancelada"; occurredAt: string }>;
};

export const getOpportunityAllocationRefusals = async (query: z.infer<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ opportunityId: String(validated.opportunityId), organizationId: String(validated.organizationId) });
  const result = await fetch(`/_api/v1/opportunity-allocation-refusals?${params.toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível consultar o histórico de recusas");
  }
  return superjson.parse<OutputType>(await result.text());
};
