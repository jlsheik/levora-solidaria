import superjson from "superjson";
import { ApiRequestError } from "../../helpers/apiRequestError.js";

export type UserSessionInfo = {
  /** Identificador opaco (nunca o id real da sessão). */
  sessionHandle: string;
  createdAt: Date | null;
  lastAccessed: Date | null;
  /** Teto absoluto da sessão (30 dias para usuários comuns): nunca é estendido por uso. */
  absoluteExpiresAt: Date;
  /** Como a sessão foi aberta: "password", "google" ou "microsoft". */
  primaryMethod: string | null;
  current: boolean;
};

export type OutputType = { sessions: UserSessionInfo[] };

export const getSessions = async (init?: RequestInit): Promise<OutputType> => {
  const result = await fetch(`/_api/v1/auth/sessions`, { method: "GET", ...init, credentials: "include" });
  if (!result.ok) {
    const errorData = superjson.parse<{ message?: string; code?: string }>(await result.text());
    throw new ApiRequestError(errorData.message || "Não foi possível carregar as sessões", result.status, errorData.code ?? null);
  }
  return superjson.parse<OutputType>(await result.text());
};
