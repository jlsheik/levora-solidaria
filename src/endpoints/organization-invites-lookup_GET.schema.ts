import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  token: z.string().min(1),
});

export type OutputType = {
  valid: boolean;
  reason?: "nao_encontrado" | "expirado" | "ja_usado" | "revogado";
  organizationName?: string;
  email?: string;
  role?: string;
};

export const getOrganizationInvitesLookup = async (
  query: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(query);
  const searchParams = new URLSearchParams({ token: validatedInput.token });
  const result = await fetch(`/_api/v1/organization-invites-lookup?${searchParams.toString()}`, {
    method: "GET",
    ...init,
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível consultar o convite");
  }

  return superjson.parse<OutputType>(await result.text());
};
