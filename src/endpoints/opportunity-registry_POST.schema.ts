import { z } from "zod";
import superjson from "superjson";
import { OpportunityUrgencyArrayValues } from "../helpers/schema";

export const schema = z.object({
  sourceId: z.coerce.number().int().positive(),
  title: z.string().min(3, "Informe um título"),
  description: z.string().optional(),
  category: z.string().optional(),
  quantity: z.coerce.number().positive().optional(),
  unit: z.string().optional(),
  condition: z.string().optional(),
  locationCity: z.string().optional(),
  locationState: z.string().optional(),
  availability: z.string().optional(),
  originReference: z.string().optional(),
  originContact: z.string().optional(),
  urgency: z.enum(OpportunityUrgencyArrayValues).default("media"),
  evidenceUrl: z.string().optional(),
  confidence: z.coerce.number().int().min(0).max(100).optional(),
  expiresAt: z.coerce.date().optional(),
});

export type OutputType = {
  opportunity: { id: number; title: string; status: string; createdAt: string };
};

export const postOpportunityRegistry = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/opportunity-registry`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível registrar a descoberta");
  }

  return superjson.parse<OutputType>(await result.text());
};
