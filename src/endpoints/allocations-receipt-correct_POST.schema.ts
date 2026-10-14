import { z } from "zod";
import superjson from "superjson";
import { ApiRequestError } from "../helpers/apiRequestError.js";

/** Tamanho máximo do motivo (a trilha de auditoria é imutável: curto e sem dado pessoal). */
export const LEDGER_REASON_MAX_LENGTH = 200;

export const fulfillmentIdSchema = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(z.string().regex(/^\d{1,18}$/, "Identificador inválido"));

export const reasonSchema = z.string().trim().min(3, "Informe o motivo").max(LEDGER_REASON_MAX_LENGTH, `Motivo de até ${LEDGER_REASON_MAX_LENGTH} caracteres`);

export const schema = z
  .object({
    organizationId: z.coerce.number().int().positive(),
    allocationId: z.coerce.number().int().positive(),
    // Controle otimista de estado (NÃO é idempotência): o id da linha vigente
    // que o cliente viu no histórico (`vigenteFulfillmentId`).
    expectedVigenteFulfillmentId: fulfillmentIdSchema,
    quantity: z.coerce
      .number()
      .positive("A quantidade precisa ser maior que zero")
      .max(999999999)
      .refine((v) => Math.round(v * 1000) / 1000 === v, "No máximo 3 casas decimais")
      .optional(),
    unit: z.string().trim().min(1).max(40).optional(),
    reason: reasonSchema,
  })
  .refine((v) => v.quantity !== undefined || v.unit !== undefined, { message: "Informe a nova quantidade ou a nova unidade" });

export type OutputType =
  | {
      status: "executada";
      reversalFulfillmentId: string | null;
      fulfillmentId: string;
      /** Movimento físico criado (null quando só contábil). */
      stockTransactionId: string | null;
      deltaFisico: number | null;
      progress: { fulfilled: number; requiredRemaining: number; surplus: number } | null;
    }
  | { status: "pendente_aprovacao"; approvalRequestId: number };

export const postAllocationsReceiptCorrect = async (body: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/allocations-receipt-correct`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string; code?: string }>(await result.text());
    throw new ApiRequestError(errorData.message || "Não foi possível corrigir o recebimento", result.status, errorData.code ?? null);
  }

  return superjson.parse<OutputType>(await result.text());
};
