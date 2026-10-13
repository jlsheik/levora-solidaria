import superjson from "superjson";
import { ApiRequestError } from "./apiRequestError.js";

/**
 * Cliente fetch comum dos endpoints de autenticação/plataforma (Fases 90–91): superjson, cookies, e erro tipado com status e `code`
 * estável. `path` é relativo a `/_api/v1/`.
 */
export async function apiRequest<T>(method: "GET" | "POST", path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const result = await fetch(`/_api/v1/${path}`, {
    method,
    ...(body !== undefined ? { body: superjson.stringify(body) } : {}),
    ...init,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) },
    credentials: "include",
  });
  const text = await result.text();
  if (!result.ok) {
    let data: { message?: string; code?: string } = {};
    try {
      data = superjson.parse<{ message?: string; code?: string }>(text);
    } catch {
      // corpo não-superjson (ex.: erro do proxy): segue com a mensagem genérica
    }
    throw new ApiRequestError(data.message || "Não foi possível concluir a operação", result.status, data.code ?? null);
  }
  return superjson.parse<T>(text);
}

export const authRequest = <T,>(method: "GET" | "POST", path: string, body?: unknown, init?: RequestInit) => apiRequest<T>(method, `auth/${path}`, body, init);
