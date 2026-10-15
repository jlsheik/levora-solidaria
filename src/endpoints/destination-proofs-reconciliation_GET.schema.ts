import { z } from "zod";
import superjson from "superjson";
import type { ProofFileListing } from "../helpers/destinationProofs.js";

export const schema = z.object({ organizationId: z.coerce.number().int().positive() });
export type OutputType = { pendentes: ProofFileListing[]; removidos: ProofFileListing[]; retidosPorAnalise: ProofFileListing[]; limit: number };

export const getProofReconciliation = async (organizationId: number, init?: RequestInit): Promise<OutputType> => {
  const result = await fetch(`/_api/v1/destination-proofs-reconciliation?organizationId=${organizationId}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const e = superjson.parse<{ message: string }>(await result.text());
    throw new Error(e.message || "Não foi possível listar os comprovantes");
  }
  return superjson.parse<OutputType>(await result.text());
};
