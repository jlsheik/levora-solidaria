import { z } from "zod";
import superjson from "superjson";
import { NeedStatusArrayValues } from "../helpers/schema";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  needId: z.coerce.number().int().positive(),
  status: z.enum(NeedStatusArrayValues),
});

export type OutputType = {
  need: { id: number; status: string };
};

export const postNeedsStatus = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/needs-status`, {
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
    throw new Error(errorData.message || "Não foi possível atualizar a necessidade");
  }

  return superjson.parse<OutputType>(await result.text());
};
