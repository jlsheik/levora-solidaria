import { z } from "zod";
import superjson from "superjson";
import { ApiRequestError } from "../../helpers/apiRequestError.js";

/**
 * Conta COM senha: `password`. Conta SEM senha (só identidade externa, ex.: Google): `confirmation: "EXCLUIR"` (confirmação digitada contra
 * execução acidental/CSRF) + reautenticação recente da identidade (`primary_reauth_at`, ver accountReauth.tsx) — verificada no SERVIDOR.
 */
export const schema = z.object({
  password: z.string().min(1, "Informe sua senha para confirmar").optional(),
  confirmation: z.literal("EXCLUIR").optional(),
});

export type OutputType = {
  message: string;
};

export const postAccountDelete = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/auth/account-delete`, {
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
    const errorData = superjson.parse<{ message: string; code?: string }>(await result.text());
    throw new ApiRequestError(errorData.message || "Não foi possível excluir a conta", result.status, errorData.code ?? null);
  }

  return superjson.parse<OutputType>(await result.text());
};
