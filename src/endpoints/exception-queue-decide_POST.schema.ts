import { z } from "zod";
import superjson from "superjson";
import type { ExceptionStatus } from "../helpers/schema.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  exceptionId: z.string().regex(/^\d{1,18}$/, "Identificador de exceção inválido"),
  decision: z.enum(["aprovar", "rejeitar"]),
  notes: z.string().trim().max(500).optional(),
});

export type OutputType = {
  exception: { id: string; status: ExceptionStatus; approvals: number; approvalsRequired: number };
};

export const postExceptionQueueDecide = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/exception-queue-decide`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível registrar a decisão");
  }

  return superjson.parse<OutputType>(await result.text());
};
