import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  realizaColeta: z.boolean(),
  // Só informativo por enquanto — não entra em nenhum cálculo de distância
  // real ainda (ver docs/plano-implementacao.md, Fase 21).
  raioColetaKm: z.coerce.number().int().positive().optional().nullable(),
  observacoesLogisticas: z.string().max(1000).optional().nullable(),
  observacoesHorarios: z.string().max(1000).optional().nullable(),
});

export type OutputType = {
  settings: {
    realizaColeta: boolean;
    raioColetaKm: number | null;
    observacoesLogisticas: string | null;
    observacoesHorarios: string | null;
  };
};

export const postOrganizationMatchingSettings = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/organization-matching-settings`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível salvar a configuração de logística");
  }

  return superjson.parse<OutputType>(await result.text());
};
