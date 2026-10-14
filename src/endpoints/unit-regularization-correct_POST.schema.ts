import { z } from "zod";
import superjson from "superjson";

/** Correção cadastral da unidade da DOAÇÃO LOCAL de um caso (a oferta da rede é corrigida pela plataforma: unit-regularization-correct-offer). */
export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  caseId: z.coerce.number().int().positive(),
  newUnit: z.string().trim().min(1, "Informe a unidade correta").max(50),
  reason: z.string().trim().min(10, "Explique o erro de cadastro (mínimo de 10 caracteres)").max(500),
});

export type OutputType = { status: "corrigido"; previousUnit: string | null; newUnit: string };

export const postUnitRegularizationCorrect = async (body: z.infer<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(body);
  const result = await fetch(`/_api/v1/unit-regularization-correct`, {
    method: "POST",
    body: superjson.stringify(validated),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível corrigir a unidade");
  }
  return superjson.parse<OutputType>(await result.text());
};
