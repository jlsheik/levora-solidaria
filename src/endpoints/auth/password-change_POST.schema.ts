import { z } from "zod";
import superjson from "superjson";
import { ApiRequestError } from "../../helpers/apiRequestError.js";
import { newPasswordSchema } from "../../helpers/passwordPolicy.js";

export { PASSWORD_MIN_LENGTH, PASSWORD_MAX_BYTES, newPasswordSchema } from "../../helpers/passwordPolicy.js";

export const schema = z
  .object({
    currentPassword: z.string().min(1, "Informe sua senha atual"),
    newPassword: newPasswordSchema,
  })
  .strict();

export type OutputType = { message: string; revokedSessions: number };

export const postPasswordChange = async (body: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/auth/password-change`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message?: string; code?: string }>(await result.text());
    throw new ApiRequestError(errorData.message || "Não foi possível alterar a senha", result.status, errorData.code ?? null);
  }

  return superjson.parse<OutputType>(await result.text());
};
