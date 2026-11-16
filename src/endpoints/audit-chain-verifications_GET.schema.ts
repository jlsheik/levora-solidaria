import { z } from "zod";
import superjson from "superjson";
import type { AuditChainVerificationStatus } from "../helpers/schema.js";

/** `organizationId` opcional: sem ele a consulta é de plataforma (exige acesso de plataforma). Com ele, exige `auditoria.leia` na organização. */
export const schema = z.object({ organizationId: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(20).default(10) });

export type VerificationView = {
  id: string;
  status: AuditChainVerificationStatus;
  startedAt: string;
  finishedAt: string | null;
  requestedByName: string | null;
  coveredUpToEventId: string | null;
  totalEvents: number | null;
  verifiedEvents: number | null;
  unhashedEvents: number | null;
  divergenceCount: number | null;
  divergences: Array<{ id: string; reason: string }> | null;
  divergencesInYourOrganization: number | null;
  durationMs: number | null;
  errorKind: string | null;
};
export type OutputType = {
  /** A cadeia é GLOBAL: só a equipe da plataforma pode executar a verificação. As organizações veem o último resultado (sem ids de outras organizações). */
  canRun: boolean;
  isPlatformAdmin: boolean;
  scope: "global_chain";
  verifications: VerificationView[];
};

export const getAuditChainVerifications = async (query: z.input<typeof schema> = {}, init?: RequestInit): Promise<OutputType> => {
  const v = schema.parse(query);
  const params = new URLSearchParams({ limit: String(v.limit) });
  if (v.organizationId) params.set("organizationId", String(v.organizationId));
  const result = await fetch(`/_api/v1/audit-chain-verifications?${params.toString()}`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message: string }>(await result.text());
    throw new Error(errorData.message || "Não foi possível carregar as verificações da trilha");
  }
  return superjson.parse<OutputType>(await result.text());
};
