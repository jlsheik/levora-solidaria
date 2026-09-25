import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  token: z.string().min(1),
});

export type OutputType = {
  organizationId: number;
  organizationName: string;
  role: string;
};

export const postOrganizationInvitesAccept = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/organization-invites-accept`, {
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
    throw new Error(errorData.message || "Não foi possível aceitar o convite");
  }

  return superjson.parse<OutputType>(await result.text());
};
