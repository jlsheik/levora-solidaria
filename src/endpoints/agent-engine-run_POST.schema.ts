import { z } from "zod";
import superjson from "superjson";
import type { AgentEventRunStatus } from "../helpers/schema.js";

export const schema = z.object({ organizationId: z.coerce.number().int().positive() });

export type OutputType = { registered: number; advanced: number; byStatus: Partial<Record<AgentEventRunStatus, number>>; conflicts: number; simulated: true };

export const postAgentEngineRun = async (body: z.infer<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(body);
  const result = await fetch(`/_api/v1/agent-engine-run`, { method: "POST", body: superjson.stringify(validated), ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível processar os eventos");
  }
  return superjson.parse<OutputType>(await result.text());
};
