import { z } from "zod";
import superjson from "superjson";
import { NeedPriorityArrayValues } from "../helpers/schema.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  title: z.string().min(3, "Informe um título para a necessidade"),
  description: z.string().optional(),
  itemId: z.coerce.number().int().positive().optional(),
  quantityNeeded: z.coerce.number().positive("Informe uma quantidade maior que zero"),
  unit: z.string().min(1, "Informe a unidade de medida"),
  priority: z.enum(NeedPriorityArrayValues).default("media"),
});

export type OutputType = {
  need: {
    id: number;
    title: string;
    status: string;
    createdAt: string;
  };
};

export const postNeeds = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/needs`, {
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
    throw new Error(errorData.message || "Não foi possível cadastrar a necessidade");
  }

  return superjson.parse<OutputType>(await result.text());
};
