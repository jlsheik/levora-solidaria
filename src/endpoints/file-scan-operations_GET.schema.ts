import superjson from "superjson";
import type { FileScanOperations } from "../helpers/fileScanOperations.js";

export type OutputType = FileScanOperations;

export const getFileScanOperations = async (init?: RequestInit): Promise<OutputType> => {
  const result = await fetch(`/_api/v1/file-scan-operations`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const e = superjson.parse<{ message: string }>(await result.text());
    throw new Error(e.message || "Não foi possível carregar os indicadores da análise de arquivos");
  }
  return superjson.parse<OutputType>(await result.text());
};
