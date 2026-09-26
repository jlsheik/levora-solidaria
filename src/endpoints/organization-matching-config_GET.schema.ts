import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
});

export type OutputType = {
  capacities: Array<{ id: number; category: string; unit: string; maxCapacity: number }>;
  settings: {
    realizaColeta: boolean;
    raioColetaKm: number | null;
    observacoesLogisticas: string | null;
    observacoesHorarios: string | null;
  } | null;
  serviceAreas: Array<{ id: number; city: string; state: string }>;
};

export const getOrganizationMatchingConfig = async (
  params: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(params);
  const searchParams = new URLSearchParams({ organizationId: String(validatedInput.organizationId) });
  const result = await fetch(`/_api/v1/organization-matching-config?${searchParams.toString()}`, {
    method: "GET",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar a configuração de matching");
  }

  return superjson.parse<OutputType>(await result.text());
};
