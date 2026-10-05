import superjson from "superjson";
import type { Kysely, Transaction } from "kysely";
import type { DB } from "./schema.js";
import type { User } from "./User.js";
import { clearChallengeCookie } from "./authChallenges.js";
import { setServerSession } from "./getSetServerSession.js";

type Executor = Kysely<DB> | Transaction<DB>;

export const jsonResponse = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/** Resposta ÚNICA para qualquer challenge inexistente/expirado/consumido/cancelado/de outro propósito (sem distinguir). */
export const invalidChallengeResponse = () => {
  const response = jsonResponse(401, { message: "A verificação expirou ou é inválida. Entre novamente.", code: "challenge_invalido" });
  clearChallengeCookie(response);
  return response;
};

/** Usuário no formato do cliente, com o nível de plataforma ATIVO relido do banco. */
export async function loadUserPayload(db: Executor, userId: number): Promise<User> {
  const row = await db
    .selectFrom("users")
    .leftJoin("platformAccess", (join) => join.onRef("platformAccess.userId", "=", "users.id").on("platformAccess.status", "=", "active"))
    .select(["users.id", "users.email", "users.displayName", "users.avatarUrl", "platformAccess.level as platformLevel"])
    .where("users.id", "=", userId)
    .executeTakeFirstOrThrow();
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    role: row.platformLevel ? "admin" : "user",
    platformLevel: row.platformLevel ?? null,
  };
}

/** Resposta de login COMPLETO: cookie de sessão (limitado ao teto absoluto) e cookie de challenge apagado. */
export async function sessionCookieResponse(
  body: Record<string, unknown>,
  session: { id: string; createdAt: Date; absoluteExpiresAt: Date },
  now: Date = new Date()
): Promise<Response> {
  const response = jsonResponse(200, body);
  await setServerSession(response, { id: session.id, createdAt: session.createdAt.getTime(), lastAccessed: now.getTime() }, { absoluteExpiresAt: session.absoluteExpiresAt });
  clearChallengeCookie(response);
  return response;
}
