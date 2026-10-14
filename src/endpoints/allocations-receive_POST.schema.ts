import { z } from "zod";
import { positiveQuantity } from "../helpers/quantityRules.js";
import superjson from "superjson";
import { isAllowedProofUrl } from "../helpers/proofUrl.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  allocationId: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive(),
  quantityReceived: positiveQuantity("Informe a quantidade realmente recebida"),
  notes: z.string().optional(),
  // só caminho relativo do app ou http(s): um `javascript:` aqui executaria no clique de "ver comprovante" (ver helpers/proofUrl.ts)
  proofUrl: z.string().refine((v) => v === "" || isAllowedProofUrl(v), "Informe um endereço http(s) válido para o comprovante").optional(),
  // Preenchido quando a prova foi um upload real (ver files-upload_POST) —
  // tem prioridade sobre proofUrl se os dois vierem preenchidos.
  proofFileId: z.coerce.number().int().positive().optional(),
});

export type OutputType = {
  allocation: { id: number; status: string };
  stockTransactionId?: string;
  newStock?: number;
  /** Fase 99C: HTTP 202 — nada foi lançado; há um caso de regularização de unidade pendente (o mesmo retorno vale para o retry). */
  pendingRegularization?: { caseId: number; status: string; created: boolean; message: string };
};

export const postAllocationsReceive = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/allocations-receive`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível registrar o recebimento");
  }

  return superjson.parse<OutputType>(await result.text());
};
