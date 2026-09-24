import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  requestId: z.coerce.number().int().positive(),
  decision: z.enum(["aprovada", "rejeitada"]),
  notes: z.string().optional(),
});

export type OutputType = { request: { id: number; status: string } };

export const postApprovalRequestsDecide = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/approval-requests-decide`, {
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
