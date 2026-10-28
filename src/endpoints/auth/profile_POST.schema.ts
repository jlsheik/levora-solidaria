import { z } from "zod";
import superjson from "superjson";
import type { User } from "../../helpers/User.js";
import { ApiRequestError } from "../../helpers/apiRequestError.js";

export const DISPLAY_NAME_MAX = 80;

/**
 * Perfil (Fase 88): SÓ o nome de exibição. `.strict()` faz qualquer outro campo (e-mail, papel, organização, avatar,
 * id) ser recusado com 400 em vez de ignorado em silêncio.
 */
export const schema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1, "Informe seu nome")
      .max(DISPLAY_NAME_MAX, `O nome pode ter no máximo ${DISPLAY_NAME_MAX} caracteres`),
  })
  .strict();

export type OutputType = { user: User };

export const postProfile = async (body: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/auth/profile`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message?: string; code?: string }>(await result.text());
    throw new ApiRequestError(errorData.message || "Não foi possível salvar o perfil", result.status, errorData.code ?? null);
  }

  return superjson.parse<OutputType>(await result.text());
};
