import { z } from "zod";
import superjson from "superjson";
import { ExceptionStatusArrayValues, type ExceptionStatus } from "../helpers/schema.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  // Omitido = só as pendentes.
  status: z.enum(ExceptionStatusArrayValues).default("pendente"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export type OutputType = {
  exceptions: Array<{
    id: string;
    toolName: string;
    ruleCode: string;
    approvalsRequired: number;
    approvals: number;
    status: ExceptionStatus;
    request: unknown;
    agentName: string;
    createdAt: string;
    consumedAt: string | null;
    myDecision: "aprovar" | "rejeitar" | null;
    /** M34: execução do motor de eventos que originou a exceção (ausente/nulo = exceção criada fora do motor). */
    run?: { id: string; eventType: string; status: string } | null;
    /** M33: histórico de decisões (quem, quando, justificativa). A nota é texto livre já limitado a 500 caracteres no registro. */
    decisions: Array<{ decision: "aprovar" | "rejeitar"; decidedAt: string; notes: string | null; byYou: boolean; userDisplayName: string }>;
  }>;
};

export const getExceptionQueue = async (
  query: z.input<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({
    organizationId: String(validated.organizationId),
    status: validated.status,
    limit: String(validated.limit),
  });
  const result = await fetch(`/_api/v1/exception-queue?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar a fila de exceções");
  }

  return superjson.parse<OutputType>(await result.text());
};
