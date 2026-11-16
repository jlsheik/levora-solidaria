import { z } from "zod";
import superjson from "superjson";

/** O comprovante chega como TEXTO (até 4 KB): o servidor valida forma, versão, algoritmo, digest e escopo antes de comparar. Corpo estrito. */
export const schema = z.object({ receipt: z.string().min(1).max(4096) }).strict();
export type OutputType = {
  id: string;
  status: "conferido" | "divergencia" | "malformado" | "nao_suportado" | "escopo_diferente";
  reason: string | null;
  receiptId: string | null;
  comparedUpToEventId: string | null;
  eventsSinceReceipt: number | null;
};

export const postAuditChainReceiptCompare = async (body: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(body);
  const result = await fetch(`/_api/v1/audit-chain-receipt-compare`, { method: "POST", body: superjson.stringify(validated), ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível comparar o comprovante");
  }
  return superjson.parse<OutputType>(await result.text());
};
