import { z } from "zod";
import superjson from "superjson";

/** Corpo estrito e vazio: o comprovante é sempre gerado a partir da última verificação íntegra, nunca de dados enviados pelo cliente. */
export const schema = z.object({}).strict();
export type OutputType = { id: string; canonical: string; receipt: { format: string; formatVersion: number; scope: string; algorithm: string; capturedAt: string; verificationId: string; lastEventId: string; eventCount: string; headHash: string; unhashedEvents: number; verificationResult: string; receiptDigest: string } };

export const postAuditChainReceipt = async (init?: RequestInit): Promise<OutputType> => {
  const result = await fetch(`/_api/v1/audit-chain-receipt`, { method: "POST", body: superjson.stringify({}), ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string; code?: string }>(await result.text());
    const err = new Error(errorData.message || "Não foi possível gerar o comprovante") as Error & { code?: string };
    err.code = errorData.code;
    throw err;
  }
  return superjson.parse<OutputType>(await result.text());
};
