import { z } from "zod";
import superjson from "superjson";
import type { Json } from "../helpers/schema";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type OutputType = {
  entries: Array<{
    id: string;
    action: string;
    entityType: string;
    entityId: string | null;
    metadata: Json;
    actorUserId: number | null;
    actorDisplayName: string | null;
    createdAt: string;
  }>;
};

export const getAuditLog = async (
  query: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(validated.organizationId) });
  if (validated.limit) params.set("limit", String(validated.limit));
  const result = await fetch(`/_api/v1/audit-log?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar a trilha de auditoria");
  }

  return superjson.parse<OutputType>(await result.text());
};
