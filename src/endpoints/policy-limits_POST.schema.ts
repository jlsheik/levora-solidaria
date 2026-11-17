import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  // Sem importar o helper do servidor (este arquivo também vai para o navegador): a chave desconhecida é recusada por `setPolicyLimit`.
  key: z.string().trim().min(1).max(80),
  // Número (limites de valor/distância/custo) ou lista de categorias; a validação fina e a regra "só mais restritivo" ficam em `setPolicyLimit`.
  value: z.union([z.number().finite().min(0), z.array(z.string().trim().min(1).max(60)).max(100)]),
});

export type OutputType = { key: string; value: number | string[] };

export const postPolicyLimits = async (body: z.infer<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/policy-limits`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível salvar o limite");
  }
  return superjson.parse<OutputType>(await result.text());
};
