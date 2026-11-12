import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  /** Simulação: quantos registros teriam mais que N dias. Nada é apagado, qualquer que seja o valor. */
  olderThanDays: z.coerce.number().int().min(1).max(3650).optional(),
});

export type RetentionRow = {
  key: string;
  label: string;
  group: "operacional" | "decisao" | "alerta" | "auditoria";
  total: number;
  oldestAt: string | null;
  /** Só preenchido quando `olderThanDays` foi informado: quantos registros passariam do prazo SIMULADO. */
  olderThanSimulated: number | null;
  note: string;
};

export type OutputType = { rows: RetentionRow[]; retentionDefined: false; deletionEnabled: false; olderThanDays: number | null; decisionsPending: string[] };

export const getRetentionPreview = async (query: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const v = schema.parse(query);
  const params = new URLSearchParams({ organizationId: String(v.organizationId) });
  if (v.olderThanDays) params.set("olderThanDays", String(v.olderThanDays));
  const result = await fetch(`/_api/v1/retention-preview?${params.toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar a classificação de retenção");
  }
  return superjson.parse<OutputType>(await result.text());
};
