import { z } from "zod";
import superjson from "superjson";

const curatableStatuses = [
  "em_verificacao",
  "validada",
  "aguardando_destinacao",
  "recusada",
  "expirada",
  "cancelada",
  "bloqueada",
  "duplicada",
] as const;

export const schema = z.object({
  opportunityId: z.coerce.number().int().positive(),
  status: z.enum(curatableStatuses),
  reason: z.string().optional(),
});

export type OutputType = {
  opportunity: { id: number; status: string };
  /** Propostas pendentes encerradas junto com a oferta (cancelar/expirar). */
  closedProposals?: number;
};

export const postOpportunityRegistryStatus = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/opportunity-registry-status`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível atualizar a descoberta");
  }

  return superjson.parse<OutputType>(await result.text());
};
