import { z } from "zod";
import superjson from "superjson";
import { ApiRequestError } from "../helpers/apiRequestError.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  allocationId: z.coerce.number().int().positive(),
});

export type ReceiptHistoryRow = {
  id: string;
  entryType: "original" | "correction" | "reversal";
  quantity: number;
  unit: string;
  isCountable: boolean;
  /** Efeito contado desta linha no saldo da necessidade (+q, −q ou 0). */
  countedEffect: number;
  reversesFulfillmentId: string | null;
  /** `vigente` | `substituida` | `estornada` | `estorno`. */
  state: "vigente" | "substituida" | "estornada" | "estorno";
  /** Reversal que faz par com uma correção (substituição), não um estorno puro. */
  pairedWithCorrection: boolean;
  createdByDisplayName: string | null;
  createdAt: string;
  /** Motivo da operação (vem da trilha de auditoria; o ledger em si não tem coluna de motivo). */
  reason: string | null;
  approvalRequestId: number | null;
};

export type OutputType = {
  allocation: { id: number; status: string };
  need: { id: number; title: string; unit: string; quantityNeeded: number } | null;
  rows: ReceiptHistoryRow[];
  /** Token de precondição: enviar como `expectedVigenteFulfillmentId`. `null` se não há recebimento. */
  vigenteFulfillmentId: string | null;
  chainState: "ativa" | "estornada" | null;
  /** Efeito líquido contado desta atribuição (0 se estornada). */
  netCountedEffect: number;
  progress: { fulfilled: number; requiredRemaining: number; surplus: number } | null;
  pendingRequest: {
    id: number;
    actionType: string;
    reason: string;
    requestedByUserId: number;
    requestedByDisplayName: string;
    createdAt: string;
  } | null;
  viewer: { userId: number; canRequest: boolean; canDecide: boolean };
};

export const getAllocationsReceiptHistory = async (query: z.infer<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(validated.organizationId), allocationId: String(validated.allocationId) });
  const result = await fetch(`/_api/v1/allocations-receipt-history?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string; code?: string }>(await result.text());
    throw new ApiRequestError(errorData.message || "Não foi possível carregar o histórico do recebimento", result.status, errorData.code ?? null);
  }

  return superjson.parse<OutputType>(await result.text());
};
