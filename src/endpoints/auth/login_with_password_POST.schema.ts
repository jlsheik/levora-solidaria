import { z } from "zod";
import { User } from "../../helpers/User.js";
import superjson from "superjson";

// Fase 51: trim() consistente com register_with_password_POST.schema.ts e
// organization-invites_POST.schema.ts — ver comentário lá para a
// justificativa completa.
export const schema = z.object({
  email: z.string().trim().email("Informe um e-mail válido"),
  password: z.string().min(1, "Informe a senha"),
});

/** Resposta do login: sessão completa (`user`) OU segundo fator pendente (`mfaRequired`, cookie de challenge, sem sessão). */
export type OutputType =
  | { user: User; mfaRequired?: undefined }
  | { mfaRequired: true; mfaKind: "verify" | "enroll"; expiresInSeconds: number; user?: undefined };

export const postLogin = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/auth/login_with_password`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    credentials: "include", // Important for cookies to be sent and received
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível entrar");
  }

  return superjson.parse<OutputType>(await result.text());
};
