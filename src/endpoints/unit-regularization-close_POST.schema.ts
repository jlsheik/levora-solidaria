import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  caseId: z.coerce.number().int().positive(),
  /** Por que o caso não pôde ser resolvido: depende de uma conversão que o sistema não faz, ou faltam informações. */
  category: z.enum(["conversao_nao_suportada", "informacao_insuficiente"]),
  reason: z.string().trim().min(10, "Explique o motivo do encerramento (mínimo de 10 caracteres)").max(500),
});

export type OutputType = { status: "encerrado" };

export const postUnitRegularizationClose = async (body: z.infer<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(body);
  const result = await fetch(`/_api/v1/unit-regularization-close`, {
    method: "POST",
    body: superjson.stringify(validated),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível encerrar o caso");
  }
  return superjson.parse<OutputType>(await result.text());
};
