import { z } from "zod";
import superjson from "superjson";
import type { MembershipRole, MembershipStatus } from "../helpers/schema";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
});

export type OutputType = {
  members: Array<{
    membershipId: number;
    userId: number;
    displayName: string;
    email: string;
    avatarUrl: string | null;
    role: MembershipRole;
    status: MembershipStatus;
    createdAt: string;
  }>;
};

export const getOrganizationMembers = async (
  query: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(validated.organizationId) });
  const result = await fetch(`/_api/organization-members?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar os membros");
  }

  return superjson.parse<OutputType>(await result.text());
};
