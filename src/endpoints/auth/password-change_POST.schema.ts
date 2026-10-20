import { z } from "zod";
import superjson from "superjson";
import { ApiRequestError } from "../../helpers/apiRequestError.js";

/**
 * Política da nova senha (Fase 88): a MESMA do cadastro (mínimo de 8 caracteres) mais o teto técnico do bcrypt — 72
 * BYTES (acima disso o bcrypt ignora o resto em silêncio). Nada de regras de complexidade novas. A nova senha também
 * precisa ser diferente da atual (verificado no servidor, contra o hash).
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `A nova senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres`)
  .refine((v) => new TextEncoder().encode(v).length <= PASSWORD_MAX_BYTES, `A nova senha pode ter no máximo ${PASSWORD_MAX_BYTES} bytes`);

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
