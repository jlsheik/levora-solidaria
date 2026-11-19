import { z } from "zod";
import superjson from "superjson";

/** Escopo único: a cadeia de auditoria é global. Corpo estrito — qualquer outro campo é recusado. */
export const schema = z.object({ scope: z.literal("global_chain").default("global_chain") }).strict();
export type OutputType = { id: string; startedAt: string; status: "em_andamento" };

export const postAuditChainVerify = async (body: z.input<typeof schema> = {}, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(body);
  const result = await fetch(`/_api/v1/audit-chain-verify`, { method: "POST", body: superjson.stringify(validated), ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string; code?: string }>(await result.text());
    const err = new Error(errorData.message || "Não foi possível iniciar a verificação") as Error & { code?: string };
    err.code = errorData.code;
    throw err;
  }
  return superjson.parse<OutputType>(await result.text());
};
