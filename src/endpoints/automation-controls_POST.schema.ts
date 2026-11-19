import { z } from "zod";
import superjson from "superjson";
import type { ControlState } from "./automation-controls_GET.schema.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  paused: z.boolean(),
  emergency: z.boolean(),
  reason: z.string().trim().max(300).optional(),
});

export type OutputType = { control: ControlState };

export const postAutomationControls = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/automation-controls`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível alterar a automação");
  }

  return superjson.parse<OutputType>(await result.text());
};
