import { z } from "zod";
import { apiRequest } from "../helpers/authClient.js";

export const AccessCodeStatusValues = ["active", "redeemed", "revoked", "expired"] as const;
export type AccessCodeStatus = (typeof AccessCodeStatusValues)[number];

export const schema = z.object({
  status: z.enum(AccessCodeStatusValues).optional(),
  /** Descrição, últimos 4 caracteres do código ou usuário que o consumiu (nome/e-mail). */
  q: z.string().trim().min(1).max(100).optional(),
  createdFrom: z.coerce.date().optional(),
  /** Exclusivo (instante). */
  createdTo: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type AccessCodeRow = {
  id: number;
  masked: string;
  last4: string;
  label: string | null;
  status: AccessCodeStatus;
  createdAt: Date;
  expiresAt: Date;
  createdBy: { id: number; displayName: string };
  redeemedAt: Date | null;
  redeemedBy: { id: number; displayName: string; email: string } | null;
  revokedAt: Date | null;
  revokedBy: string | null;
};

export type OutputType = { total: number; codes: AccessCodeRow[] };

export const getPlatformAccessCodes = (params: z.input<typeof schema> = {}) => {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    qs.set(key, value instanceof Date ? value.toISOString() : String(value));
  }
  const query = qs.toString();
  return apiRequest<OutputType>("GET", `platform-access-codes${query ? `?${query}` : ""}`);
};
