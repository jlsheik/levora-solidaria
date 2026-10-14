import { z } from "zod";
import superjson from "superjson";
import type { ApprovalStatus, Json } from "../helpers/schema.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
});

export type OutputType = {
  requests: Array<{
    id: number;
    actionType: string;
    payload: Json;
    reason: string;
    status: ApprovalStatus;
    requestedByUserId: number;
    requestedByDisplayName: string;
    decidedByDisplayName: string | null;
    decisionNotes: string | null;
    createdAt: string;
    decidedAt: string | null;
  }>;
};

export const getApprovalRequests = async (
  query: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(validated.organizationId) });
  const result = await fetch(`/_api/v1/approval-requests?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar os pedidos de aprovação");
  }

  return superjson.parse<OutputType>(await result.text());
};

