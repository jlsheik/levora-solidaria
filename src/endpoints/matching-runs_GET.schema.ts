import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({ opportunityId: z.coerce.number().int().positive(), limit: z.coerce.number().int().min(1).max(100).default(30) });

export type MatchingRunRecord = {
  id: string; correlationId: string; origin: string; status: "em_andamento" | "concluida_com_correspondencia" | "concluida_sem_correspondencia" | "falhou";
  startedAt: string; finishedAt: string | null;
  /** NULL = não calculado (execução que falhou). Zero é um valor calculado. */
  candidatesConsidered: number | null; candidatesRelated: number | null; validMatches: number | null;
  /** Código SEGURO da falha (SQLSTATE ou genérico), nunca a mensagem. */
  errorCode: string | null; algorithmVersion: string; repeatCount: number; lastRepeatedAt: string | null; triggeredByName: string | null;
};
export type OutputType = { runs: MatchingRunRecord[] };

export const getMatchingRuns = async (query: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const v = schema.parse(query);
  const result = await fetch(`/_api/v1/matching-runs?${new URLSearchParams({ opportunityId: String(v.opportunityId), limit: String(v.limit) }).toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Falha ao carregar as execuções de matching");
  }
  return superjson.parse<OutputType>(await result.text());
};
