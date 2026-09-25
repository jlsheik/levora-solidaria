import { z } from "zod";
import superjson from "superjson";
import type { SourceStatus } from "../helpers/schema";

export const schema = z.object({});

export type OutputType = {
  sources: Array<{
    id: number;
    name: string;
    type: string;
    connectorKey: string;
    status: SourceStatus;
    connectionState: string;
    endpointOrAddress: string | null;
    runFrequencyMinutes: number | null;
    lastRunAt: string | null;
    lastValidatedAt: string | null;
    recentErrors: unknown;
    createdAt: string;
  }>;
};

export const getSources = async (init?: RequestInit): Promise<OutputType> => {
  const result = await fetch(`/_api/v1/sources`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar as fontes");
  }
  return superjson.parse<OutputType>(await result.text());
};
