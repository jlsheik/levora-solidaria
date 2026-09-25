import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  runId: z.coerce.number().int().positive(),
});

export type OutputType = { message: string };

export const postBackgroundTasksRetry = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/background-tasks-retry`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível reprocessar a tarefa");
  }

  return superjson.parse<OutputType>(await result.text());
};
