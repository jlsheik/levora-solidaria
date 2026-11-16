import { z } from "zod";
import superjson from "superjson";
import type { AuditEntryView } from "./audit-center_GET.schema.js";

export const schema = z.object({ organizationId: z.coerce.number().int().positive(), id: z.string().regex(/^[0-9]{1,18}$/) });
export type OutputType = { entry: AuditEntryView & { metadata: unknown; correlated: AuditEntryView[]; sameEntity: AuditEntryView[] } };

export const getAuditCenterEntry = async (query: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const v = schema.parse(query);
  const result = await fetch(`/_api/v1/audit-center-entry?${new URLSearchParams({ organizationId: String(v.organizationId), id: v.id }).toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar o registro");
  }
  return superjson.parse<OutputType>(await result.text());
};
