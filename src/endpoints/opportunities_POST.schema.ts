import { z } from "zod";
import { optionalUnitInput } from "../helpers/unitInput.js";
import { positiveQuantity } from "../helpers/quantityRules.js";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  title: z.string().min(3, "Informe um título"),
  description: z.string().optional(),
  category: z.string().optional(),
  quantityOffered: positiveQuantity("Informe uma quantidade maior que zero").optional(),
  unit: optionalUnitInput("unidade da oferta"),
  donorName: z.string().min(2, "Informe o nome ou identificação do doador"),
  donorContact: z.string().optional(),
  linkedNeedId: z.coerce.number().int().positive().optional(),
});

export type OutputType = {
  opportunity: { id: number; title: string; status: string; createdAt: string };
};

export const postOpportunities = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/opportunities`, {
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
    throw new Error(errorData.message || "Não foi possível registrar a oportunidade");
  }

  return superjson.parse<OutputType>(await result.text());
};
