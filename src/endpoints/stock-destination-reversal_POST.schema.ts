import { z } from "zod";
import superjson from "superjson";
import { positiveQuantity } from "../helpers/quantityRules.js";

export const REVERSAL_KINDS = ["estorno_documental", "devolucao_fisica", "correcao_quantidade"] as const;

/**
 * Fase 99G — reverte (total ou parcialmente) uma destinação: estorno documental (sem movimento), devolução física (cria ENTRADA) ou correção de quantidade (cria AJUSTE positivo). O servidor
 * recalcula quanto ainda é reversível, o atendimento da necessidade e quem pode agir; nada disso vem do navegador. A chave de idempotência é obrigatória.
 */
export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  destinationId: z.string().regex(/^\d{1,18}$/, "Destinação inválida"),
  kind: z.enum(REVERSAL_KINDS, { error: "Escolha o tipo da reversão" }),
  quantity: positiveQuantity("Informe a quantidade a reverter"),
  reason: z.string().trim().min(5, "Explique o motivo (mínimo de 5 caracteres)").max(500, "No máximo 500 caracteres"),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "Chave de idempotência inválida"),
});

export type InputType = z.input<typeof schema>;

export type OutputType = {
  replayed: boolean;
  reversal: { id: string; kind: (typeof REVERSAL_KINDS)[number]; quantity: number; unit: string; reversedTotal: number; reversibleAfter: number };
  /** Movimento físico criado (entrada/ajuste) ou null no estorno documental. */
  stockMovement: { id: string; type: "entrada" | "ajuste"; delta: number } | null;
  newStock: number | null;
  need: { id: number; title: string; attendedBefore: number; attendedAfter: number; requested: number; remainingAfter: number; reopened: boolean } | null;
};

export const postStockDestinationReversal = async (body: InputType, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(body);
  const result = await fetch(`/_api/v1/stock-destination-reversal`, {
    method: "POST",
    body: superjson.stringify(validated),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível reverter a destinação");
  }
  return superjson.parse<OutputType>(await result.text());
};
