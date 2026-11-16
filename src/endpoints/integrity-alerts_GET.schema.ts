import { z } from "zod";
import superjson from "superjson";
import { IntegrityAlertStatusArrayValues, type IntegrityAlertLevel, type IntegrityAlertStatus } from "../helpers/schema.js";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  // Omitido = alertas em aberto (abertos e reconhecidos).
  status: z.enum(IntegrityAlertStatusArrayValues).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export type OutputType = {
  alerts: Array<{
    id: string;
    level: IntegrityAlertLevel;
    category: string;
    title: string;
    detail: unknown;
    entityType: string | null;
    entityId: string | null;
    status: IntegrityAlertStatus;
    createdAt: string;
    agentName: string | null;
    acknowledgedAt: string | null;
    resolvedAt: string | null;
    resolutionNote: string | null;
  }>;
};

export const getIntegrityAlerts = async (
  query: z.input<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(validated.organizationId), limit: String(validated.limit) });
  if (validated.status) params.set("status", validated.status);
  const result = await fetch(`/_api/v1/integrity-alerts?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar os alertas");
  }

  return superjson.parse<OutputType>(await result.text());
};
