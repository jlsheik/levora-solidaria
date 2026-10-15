import { z } from "zod";
import superjson from "superjson";
import { nonZeroQuantity } from "../helpers/quantityRules.js";
import { StockTransactionTypeArrayValues } from "../helpers/schema.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive(),
  // Fase 99E: a saída física NÃO é mais lançada aqui — ela nasce junto da destinação (POST /stock-destinations). Entrada e ajuste continuam neste fluxo.
  type: z.enum(StockTransactionTypeArrayValues).refine((t) => t !== "saida", "Saídas de estoque exigem destinação: use o registro de destinação (finalidade, data e, quando houver, a necessidade)"),
  quantity: nonZeroQuantity("Informe uma quantidade diferente de zero"),
  reason: z.string().min(2, "Descreva o motivo do lançamento"),
});

export type OutputType =
  | {
      requiresApproval: true;
      message: string;
      approvalRequestId: number;
    }
  | {
      requiresApproval: false;
      transaction: {
        id: string;
        itemId: number;
        type: string;
        delta: number;
        reason: string | null;
        createdAt: string;
      };
      newStock: number;
    };

export const postStockTransactions = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/stock-transactions`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });

  if (result.status === 202) {
    const data = superjson.parse<{ message: string; approvalRequestId: number }>(await result.text());
    return { requiresApproval: true, ...data };
  }

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível registrar o lançamento de estoque");
  }

  const data = superjson.parse<{ transaction: OutputType extends { transaction: infer T } ? T : never; newStock: number }>(await result.text());
  return { requiresApproval: false, ...data };
};
