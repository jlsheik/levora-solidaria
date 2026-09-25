import { z } from "zod";
import superjson from "superjson";

const RECORDABLE_EVENTS = ["coleta_agendada", "coleta_concluida", "transporte_iniciado", "cancelado"] as const;

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  allocationId: z.coerce.number().int().positive(),
  eventType: z.enum(RECORDABLE_EVENTS),
  scheduledFor: z.coerce.date().optional(),
  notes: z.string().optional(),
});

export type OutputType = { allocation: { id: number; status: string } };

export const postAllocationsLogistics = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/allocations-logistics`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível registrar o evento de logística");
  }

  return superjson.parse<OutputType>(await result.text());
};
