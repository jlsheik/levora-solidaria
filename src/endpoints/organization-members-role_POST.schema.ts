import { z } from "zod";
import superjson from "superjson";
import { ApiRequestError } from "../helpers/apiRequestError.js";
import { MembershipRoleArrayValues, type MembershipRole } from "../helpers/schema.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  membershipId: z.coerce.number().int().positive(),
  role: z.enum(MembershipRoleArrayValues),
});

export type OutputType = {
  member: { membershipId: number; userId: number; role: MembershipRole; status: string };
};

export const postOrganizationMembersRole = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/organization-members-role`, {
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
    let message = "";
    try {
      message = superjson.parse<{ message?: string }>(await result.text()).message ?? "";
    } catch {
      // corpo que não é JSON (ex.: 502 do proxy): o status continua sendo repassado
    }
    throw new ApiRequestError(message || "Não foi possível alterar o papel", result.status);
  }

  return superjson.parse<OutputType>(await result.text());
};
