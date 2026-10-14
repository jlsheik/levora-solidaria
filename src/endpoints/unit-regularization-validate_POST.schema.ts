import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  caseId: z.coerce.number().int().positive(),
  decision: z.enum(["aprovar", "devolver"]),
  /** Obrigatória ao devolver; opcional ao aprovar. */
  note: z.string().trim().max(500).default(""),
}).refine((v) => v.decision !== "devolver" || v.note.length >= 5, { path: ["note"], message: "Explique por que a conferência foi devolvida" });

export type OutputType = { status: "resolvido" | "aberto"; stockTransactionId: string | null };

export const postUnitRegularizationValidate = async (body: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(body);
  const result = await fetch(`/_api/v1/unit-regularization-validate`, {
    method: "POST",
    body: superjson.stringify(validated),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível validar a conferência");
  }
  return superjson.parse<OutputType>(await result.text());
};
