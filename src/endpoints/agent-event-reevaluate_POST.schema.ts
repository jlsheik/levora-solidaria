import { z } from "zod";
import superjson from "superjson";
import type { AgentEventRunStatus } from "../helpers/schema.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  runId: z.string().regex(/^[0-9]{1,18}$/),
  /** Motivo livre, opcional e curto (fica no histórico; sem dado pessoal). */
  reason: z.string().trim().max(300).optional(),
});

export type OutputType = {
  correlationId: string;
  /** Estado da execução depois da nova análise (ex.: simulacao_concluida, aguardando_aprovacao, dados_insuficientes). */
  newStatus: AgentEventRunStatus;
  newDecision: string | null;
  /** Sempre true: nada foi executado fora do sistema. */
  simulated: true;
};

export const postAgentEventReevaluate = async (body: z.infer<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(body);
  const result = await fetch(`/_api/v1/agent-event-reevaluate`, { method: "POST", body: superjson.stringify(validated), ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível solicitar a nova análise");
  }
  return superjson.parse<OutputType>(await result.text());
};
