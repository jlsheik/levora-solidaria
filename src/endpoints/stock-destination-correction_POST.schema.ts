import { z } from "zod";
import superjson from "superjson";

/**
 * Fase 99G — correção DOCUMENTAL de uma destinação: só data efetiva, pessoas atendidas e observações. Nunca muda finalidade, quantidade, unidade, necessidade nem atendimento, e nunca
 * movimenta estoque (para isso existe a reversão). Cada campo informado vira um evento novo; o original permanece intacto.
 */
export const schema = z
  .object({
    organizationId: z.coerce.number().int().positive(),
    destinationId: z.string().regex(/^\d{1,18}$/, "Destinação inválida"),
    deliveredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Informe a data no formato AAAA-MM-DD").nullish(),
    peopleServed: z.coerce.number().int().min(0).max(10_000_000).nullish(),
    peopleUnit: z.enum(["familias", "pessoas"]).nullish(),
    notes: z.string().trim().min(1).max(1000, "No máximo 1000 caracteres").nullish(),
    lateRegistrationReason: z.string().trim().max(500).nullish(),
    reason: z.string().trim().min(5, "Explique o motivo da correção (mínimo de 5 caracteres)").max(500, "No máximo 500 caracteres"),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "Chave de idempotência inválida"),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.deliveredOn == null && v.peopleServed == null && v.notes == null) ctx.addIssue({ code: "custom", path: ["deliveredOn"], message: "Informe ao menos um campo a corrigir" });
    if ((v.peopleServed == null) !== (v.peopleUnit == null)) ctx.addIssue({ code: "custom", path: ["peopleUnit"], message: "Informe a quantidade de pessoas ou famílias junto com a unidade" });
  });

export type InputType = z.input<typeof schema>;

export type OutputType = {
  replayed: boolean;
  correction: { id: string; changes: Record<string, { de: unknown; para: unknown }> };
};

export const postStockDestinationCorrection = async (body: InputType, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(body);
  const result = await fetch(`/_api/v1/stock-destination-correction`, {
    method: "POST",
    body: superjson.stringify(validated),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível corrigir a destinação");
  }
  return superjson.parse<OutputType>(await result.text());
};
