import { z } from "zod";
import superjson from "superjson";
import { ApiRequestError } from "../helpers/apiRequestError.js";
import { fulfillmentIdSchema, reasonSchema } from "./allocations-receipt-correct_POST.schema.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  allocationId: z.coerce.number().int().positive(),
  expectedVigenteFulfillmentId: fulfillmentIdSchema,
  reason: reasonSchema,
  // Retirada física opcional (P-L4): só o saldo físico REAL da allocation. Padrão: estorno só contábil.
  withdrawStock: z.boolean().optional(),
});

// Todo estorno é dupla autorização (P-L6): a resposta é sempre um pedido.
export type OutputType = { status: "pendente_aprovacao"; approvalRequestId: number };

export const postAllocationsReceiptReverse = async (body: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/allocations-receipt-reverse`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string; code?: string }>(await result.text());
    throw new ApiRequestError(errorData.message || "Não foi possível solicitar o estorno", result.status, errorData.code ?? null);
  }

  return superjson.parse<OutputType>(await result.text());
};
