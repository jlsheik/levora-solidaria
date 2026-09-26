import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  category: z.string().min(1, "Informe a categoria").max(100),
  unit: z.string().min(1, "Informe a unidade").max(50),
  maxCapacity: z.coerce.number().nonnegative("Capacidade não pode ser negativa"),
});

export type OutputType = {
  capacity: { id: number; category: string; unit: string; maxCapacity: number };
};

export const postOrganizationCapacities = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/organization-capacities`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível salvar a capacidade");
  }

  return superjson.parse<OutputType>(await result.text());
};
