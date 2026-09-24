import { z } from "zod";
import superjson from "superjson";
import { SourceTypeArrayValues } from "../helpers/schema";

export const schema = z.object({
  name: z.string().min(2, "Informe o nome da fonte"),
  type: z.enum(SourceTypeArrayValues),
  connectorKey: z.string().min(1, "Informe a chave do conector (ex: manual)"),
  endpointOrAddress: z.string().optional(),
  accessMethod: z.string().optional(),
  credentialRef: z.string().optional(),
  authorizingOrganizationId: z.coerce.number().int().positive().optional(),
  policyNotes: z.string().optional(),
  runFrequencyMinutes: z.coerce.number().int().positive().optional(),
  rateLimitPerRun: z.coerce.number().int().positive().optional(),
});

export type OutputType = {
  source: { id: number; name: string; status: string };
};

export const postSources = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/sources`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível cadastrar a fonte");
  }

  return superjson.parse<OutputType>(await result.text());
};
