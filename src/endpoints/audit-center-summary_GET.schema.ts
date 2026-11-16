import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({ organizationId: z.coerce.number().int().positive(), from: z.coerce.date().optional(), to: z.coerce.date().optional() });
type Counted = { count: number; capped: boolean };
export type OutputType = {
  period: { from: string | null; to: string | null };
  operations: Counted;
  /** Por resultado EXPLÍCITO. `naoRegistrado` não é sucesso: é o histórico e as operações ainda não instrumentadas. */
  byOutcome: { concluida: Counted; recusada: Counted; falhou: Counted; pendente: Counted; naoRegistrado: Counted };
  /** Histórico TOTAL (todas as datas) — separado dos totais do período. */
  history: Counted;
  /** null = o perfil não lê a automação (desconhecido, não zero). */
  automation: null | {
    agentDecisions: { total: number; byStatus: Record<string, number> };
    exceptionsCreated: number;
    exceptionsResolved: number;
    reevaluations: { total: number; byOutcome: Record<string, number> };
  };
};

export const getAuditCenterSummary = async (query: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const v = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(v.organizationId) });
  if (v.from) params.set("from", v.from.toISOString());
  if (v.to) params.set("to", v.to.toISOString());
  const result = await fetch(`/_api/v1/audit-center-summary?${params.toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar o resumo");
  }
  return superjson.parse<OutputType>(await result.text());
};
