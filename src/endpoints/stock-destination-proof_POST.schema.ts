import { z } from "zod";
import superjson from "superjson";

/**
 * Fase 99J — anexa ou remove a REFERÊNCIA ao comprovante de uma destinação. O arquivo é enviado antes por `files-upload` (propósito `comprovante_destinacao`); aqui só se cria o vínculo, como
 * evento imutável. Remover não apaga o objeto armazenado. Comprovante é opcional. A chave de idempotência é obrigatória (a mesma tabela de pedidos das correções/reversões).
 */
export const schema = z
  .object({
    organizationId: z.coerce.number().int().positive(),
    destinationId: z.string().regex(/^\d{1,18}$/, "Destinação inválida"),
    action: z.enum(["anexar", "remover"], { errorMap: () => ({ message: "Escolha anexar ou remover" }) }),
    fileId: z.coerce.number().int().positive(),
    reason: z.string().trim().min(5, "Explique o motivo (mínimo de 5 caracteres)").max(500, "No máximo 500 caracteres"),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "Chave de idempotência inválida"),
  })
  .strict();

export type InputType = z.input<typeof schema>;
export type OutputType = { replayed: boolean; event: { id: string; action: "anexado" | "removido"; fileId: number } };

export const postStockDestinationProof = async (body: InputType, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(body);
  const result = await fetch(`/_api/v1/stock-destination-proof`, {
    method: "POST",
    body: superjson.stringify(validated),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível atualizar o comprovante");
  }
  return superjson.parse<OutputType>(await result.text());
};
