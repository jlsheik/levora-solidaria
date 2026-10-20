import { z } from "zod";
import superjson from "superjson";
import { ApiRequestError } from "../../helpers/apiRequestError.js";

export const schema = z.object({ sessionHandle: z.string().regex(/^[0-9a-f]{16}$/, "Sessão inválida") }).strict();

export type OutputType = { message: string };

export const postSessionRevoke = async (body: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/auth/sessions-revoke`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const errorData = superjson.parse<{ message?: string; code?: string }>(await result.text());
    throw new ApiRequestError(errorData.message || "Não foi possível encerrar a sessão", result.status, errorData.code ?? null);
  }
  return superjson.parse<OutputType>(await result.text());
};
