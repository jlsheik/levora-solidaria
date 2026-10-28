import superjson from "superjson";
import { ApiRequestError } from "../../helpers/apiRequestError.js";

export type OutputType = { revoked: number };

export const postSessionsRevokeOthers = async (init?: RequestInit): Promise<OutputType> => {
  const result = await fetch(`/_api/v1/auth/sessions-revoke-others`, {
    method: "POST",
    body: superjson.stringify({}),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  if (!result.ok) {
    const errorData = superjson.parse<{ message?: string; code?: string }>(await result.text());
    throw new ApiRequestError(errorData.message || "Não foi possível encerrar as outras sessões", result.status, errorData.code ?? null);
  }
  return superjson.parse<OutputType>(await result.text());
};
