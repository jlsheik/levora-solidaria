import { z } from "zod";
import superjson from "superjson";
import { positiveQuantity } from "../helpers/quantityRules.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  caseId: z.coerce.number().int().positive(),
  /** Quantidade CONTADA/MEDIDA na unidade canônica do item (observação física, não conversão). */
  checkedQuantity: positiveQuantity("Informe a quantidade conferida"),
  reason: z.string().trim().min(10, "Explique a divergência (mínimo de 10 caracteres)").max(500),
  /** Conferir e validar no mesmo ato: só vale para o único proprietário/administrador ativo (a conferência fica marcada "sem segunda validação"). */
  validateNow: z.boolean().optional(),
});

export type OutputType = { status: "conferido" | "resolvido"; stockTransactionId: string | null };

export const postUnitRegularizationConfer = async (body: z.infer<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(body);
  const result = await fetch(`/_api/v1/unit-regularization-confer`, {
    method: "POST",
    body: superjson.stringify(validated),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível registrar a conferência");
  }
  return superjson.parse<OutputType>(await result.text());
};
