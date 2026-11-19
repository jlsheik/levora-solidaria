import { z } from "zod";
import superjson from "superjson";

/** `organizationId` opcional: sem ele a consulta é de plataforma. Com ele exige `auditoria.leia`; organizações veem só existência, data e estado (sem hashes). */
export const schema = z.object({ organizationId: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(20).default(10) });

export type ReceiptComparisonStatus = "conferido" | "divergencia" | "malformado" | "nao_suportado" | "escopo_diferente";
export type ReceiptView = {
  id: string; capturedAt: string; lastEventId: string; eventCount: string; verificationId: string; createdByName: string | null;
  headHash: string | null; receiptDigest: string | null; canonical: string | null;
  lastComparison: null | { status: ReceiptComparisonStatus; reason: string | null; comparedAt: string; eventsSinceReceipt: number | null };
};
export type OutputType = {
  canManage: boolean;
  receipts: ReceiptView[];
  /** SEMPRE false nesta versão: nenhuma âncora independente (serviço externo, assinatura, carimbo de tempo) está configurada. */
  independentAnchorConfigured: false;
};

export const getAuditChainReceipts = async (query: z.input<typeof schema> = {}, init?: RequestInit): Promise<OutputType> => {
  const v = schema.parse(query);
  const params = new URLSearchParams({ limit: String(v.limit) });
  if (v.organizationId) params.set("organizationId", String(v.organizationId));
  const result = await fetch(`/_api/v1/audit-chain-receipts?${params.toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar os comprovantes");
  }
  return superjson.parse<OutputType>(await result.text());
};
