import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({});

export type OutputType = {
  totalEventos: number;
  eventosVerificados: number;
  eventosPreExistentesSemHash: number;
  integra: boolean;
  divergencias: Array<{
    id: string;
    reason: string;
    expectedEventHash?: string;
    storedEventHash: string | null;
  }>;
};

export const getAuditLogVerify = async (init?: RequestInit): Promise<OutputType> => {
  const result = await fetch(`/_api/v1/audit-log-verify`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível verificar a trilha de auditoria");
  }

  return superjson.parse<OutputType>(await result.text());
};
