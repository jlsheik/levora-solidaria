import { z } from "zod";
import { requiredUnitInput } from "../helpers/unitInput.js";
import superjson from "superjson";
import { nonNegativeQuantity } from "../helpers/quantityRules.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  name: z.string().min(2, "Informe o nome do item"),
  unit: requiredUnitInput("unidade de medida"),
  category: z.string().optional(),
  initialQuantity: nonNegativeQuantity("Quantidade inicial inválida").optional(),
});

export type OutputType = {
  item: {
    id: number;
    name: string;
    unit: string;
    category: string | null;
    currentStock: number;
    createdAt: string;
  };
};

export const postInventoryItems = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/inventory-items`, {
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
    throw new Error(errorData.message || "Não foi possível cadastrar o item");
  }

  return superjson.parse<OutputType>(await result.text());
};
