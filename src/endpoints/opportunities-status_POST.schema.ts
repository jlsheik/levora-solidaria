import { z } from "zod";
import superjson from "superjson";
import { OpportunityStatusArrayValues } from "../helpers/schema.js";

const nonReceiveStatuses = OpportunityStatusArrayValues.filter((s) => s !== "recebida");

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  opportunityId: z.coerce.number().int().positive(),
  status: z.enum(nonReceiveStatuses as [string, ...string[]]).optional(),
  linkedNeedId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
});

export type OutputType = {
  opportunity: { id: number; status: string; linkedNeedId: number | null };
};

export const postOpportunitiesStatus = async (
  body: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/v1/opportunities-status`, {
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
    throw new Error(errorData.message || "Não foi possível atualizar a oportunidade");
  }

  return superjson.parse<OutputType>(await result.text());
};
