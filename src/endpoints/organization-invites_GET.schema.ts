import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
});

export type OutputType = {
  invites: Array<{
    id: number;
    email: string;
    role: string;
    status: string;
    invitedByDisplayName: string;
    expiresAt: string;
    createdAt: string;
    acceptedAt: string | null;
    revokedAt: string | null;
  }>;
};

export const getOrganizationInvites = async (
  query: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(query);
  const searchParams = new URLSearchParams({ organizationId: String(validatedInput.organizationId) });
  const result = await fetch(`/_api/v1/organization-invites?${searchParams.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar os convites");
  }

  return superjson.parse<OutputType>(await result.text());
};
