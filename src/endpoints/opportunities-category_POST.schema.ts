import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  opportunityId: z.coerce.number().int().positive(),
  /** Texto livre validado só na forma (ver opportunityCategory.tsx). Não há categoria padrão. */
  category: z.string().max(200),
  /** Versão do registro que a pessoa viu: se mudou, o servidor recusa (409 conflito_de_versao). */
  expectedVersion: z.coerce.number().int().min(1),
  reason: z.string().trim().max(300).optional(),
});

export type OutputType = {
  opportunity: { id: number; category: string | null; version: number; updatedAt: string };
  /** false quando a categoria enviada já era a atual (nada foi gravado, nenhuma versão consumida). */
  changed: boolean;
  correlationId: string | null;
  /** Só para quem pode ler a automação: se há uma execução em dados insuficientes que agora pode ser reavaliada (a edição NÃO dispara nada). */
  reevaluation: null | { available: boolean; runId: string | null };
};

export type ConflictBody = { message: string; code: "conflito_de_versao" | "estado_nao_permite" | "categoria_invalida"; current?: { version: number; category: string | null; status: string } };

export const postOpportunitiesCategory = async (body: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(body);
  const result = await fetch(`/_api/v1/opportunities-category`, { method: "POST", body: superjson.stringify(validated), ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<ConflictBody>(await result.text());
    const err = new Error(errorData.message || "Não foi possível salvar a categoria") as Error & { code?: string; current?: ConflictBody["current"] };
    err.code = errorData.code; err.current = errorData.current;
    throw err;
  }
  return superjson.parse<OutputType>(await result.text());
};
