import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  password: z.string().min(1, "Informe sua senha para confirmar"),
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
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível excluir a conta");
  }

  return superjson.parse<OutputType>(await result.text());
};
