import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  city: z.string().min(2, "Informe a cidade").max(100),
  state: z
    .string()
    .length(2, "Use a sigla do estado, ex: MG")
    .transform((s) => s.toUpperCase()),
});

export type OutputType = {
  serviceArea: { id: number; city: string; state: string };
};

export const postOrganizationServiceAreas = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/organization-service-areas`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível adicionar a área de atendimento");
  }

  return superjson.parse<OutputType>(await result.text());
};
