import { z } from "zod";
import superjson from "superjson";
import { MAX_RESPONSE_DEADLINE_HOURS, MIN_RESPONSE_DEADLINE_HOURS } from "../helpers/assignmentSettings.js";

export const schema = z.object({
  responseDeadlineHours: z.coerce
    .number()
    .int("Informe um número inteiro de horas")
    .min(MIN_RESPONSE_DEADLINE_HOURS, `O prazo mínimo é ${MIN_RESPONSE_DEADLINE_HOURS} hora`)
    .max(MAX_RESPONSE_DEADLINE_HOURS, `O prazo máximo é ${MAX_RESPONSE_DEADLINE_HOURS} horas`),
});

export type OutputType = { responseDeadlineHours: number; previousHours: number; changed: boolean };

export const postAssignmentSettings = async (body: z.infer<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/assignment-settings`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível salvar o prazo");
  }
  return superjson.parse<OutputType>(await result.text());
};
