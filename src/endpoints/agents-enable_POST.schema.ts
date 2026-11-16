import { z } from "zod";
import superjson from "superjson";

export const ENGINE_AGENT_VALUES = ["sentinela-integridade", "risk-engine"] as const;
export const schema = z.object({ organizationId: z.coerce.number().int().positive(), agent: z.enum(ENGINE_AGENT_VALUES), enabled: z.boolean() });
export type OutputType = { agent: string; enabled: boolean; scope: "organizacao" };

export const postAgentsEnable = async (body: z.infer<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(body);
  const result = await fetch(`/_api/v1/agents-enable`, { method: "POST", body: superjson.stringify(validated), ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível alterar o agente");
  }
  return superjson.parse<OutputType>(await result.text());
};
