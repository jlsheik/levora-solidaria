import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
});

export type OutputType = {
  period: { startDate: string; endDate: string };
  organizationName: string;
  itemMovements: Array<{
    itemId: number;
    itemName: string;
    unit: string;
    entradas: number;
    saidas: number;
    ajustes: number;
    netChange: number;
    currentStock: number;
  }>;
  receivedTransactions: Array<{
    id: string;
    itemName: string;
    delta: number;
    unit: string;
    reason: string | null;
    createdAt: string;
  }>;
  needsSummary: {
    abertasNoPeriodo: number;
    atendidasNoPeriodo: number;
    canceladasNoPeriodo: number;
  };
  auditEventCount: number;
};

export const getImpactReport = async (
  query: z.infer<typeof schema>,
  init?: RequestInit
): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({
    organizationId: String(validated.organizationId),
    startDate: validated.startDate.toISOString(),
    endDate: validated.endDate.toISOString(),
  });
  const result = await fetch(`/_api/v1/impact-report?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível gerar o relatório");
  }

  return superjson.parse<OutputType>(await result.text());
};
