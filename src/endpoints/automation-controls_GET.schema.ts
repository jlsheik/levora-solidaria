import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
});

export type ControlState = { paused: boolean; emergency: boolean; reason: string | null };

export type OutputType = {
  global: ControlState;
  organization: ControlState;
  /** Efetivo: qualquer escopo pausado ou em emergência. */
  paused: boolean;
  emergency: boolean;
};

export const getAutomationControls = async (
  query: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(validated.organizationId) });
  const result = await fetch(`/_api/v1/automation-controls?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar o estado da automação");
  }

  return superjson.parse<OutputType>(await result.text());
};
