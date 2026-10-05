import { z } from "zod";
import superjson from "superjson";
import { OrganizationStatusArrayValues } from "../helpers/schema.js";
import { ApiRequestError } from "../helpers/apiRequestError.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  status: z.enum(OrganizationStatusArrayValues),
});

export type OutputType = { organization: { id: number; status: string } };

export const postPlatformOrganizationsStatus = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/platform-organizations-status`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string; code?: string }>(await result.text());
    // ApiRequestError carrega o `code` estável (ex.: reauth_required → a tela pede o step-up e repete a ação)
    throw new ApiRequestError(errorData.message || "Não foi possível atualizar a organização", result.status, errorData.code ?? null);
  }

  return superjson.parse<OutputType>(await result.text());
};
