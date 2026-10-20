import { createHash } from "node:crypto";
import type { Transaction } from "kysely";
import type { DB } from "./schema.js";
import { NotAuthenticatedError } from "./getSetServerSession.js";
import { lockUsersInOrder } from "./lockOrder.js";

/**
 * Conta do usuário (Fase 88, adaptada à identidade) — sessões. NÃO é um segundo mecanismo de sessão: a sessão continua sendo UMA linha em
 * `sessions` (sessionLifecycle.tsx/sessionPolicy.tsx são a autoridade do ciclo de vida); revogar = apagar a linha, exatamente como o logout.
 * `getServerUserSession` recusa qualquer cookie cuja linha não exista mais.
 *
 * O id real da sessão nunca vai ao cliente: a listagem usa um identificador opaco derivado (SHA-256 truncado). O id é aleatório de 256 bits,
 * então o derivado não o revela, e só vale dentro das sessões do PRÓPRIO usuário.
 */
export function sessionHandle(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

export interface UserSessionRow {
  id: string;
  createdAt: Date | null;
  lastAccessed: Date | null;
  absoluteExpiresAt: Date;
  primaryMethod: string | null;
  mfaVerifiedAt: Date | null;
  lastReauthAt: Date | null;
}

/**
 * ORDEM CANÔNICA DE LOCKS (lockOrder.tsx, §25.18): organizations → users → platform_access → credenciais → sessions → audit. O chamador trava
 * ANTES o usuário (`lockUserAndSessions` faz as duas coisas) e, se mexer em credenciais (user_passwords), trava-as entre o usuário e as sessões.
 * Antes da adaptação, `profile_POST` travava sessions → users, o inverso do login (users → sessions): um ciclo de deadlock real.
 *
 * Trava TODAS as sessões do usuário, em ordem de id. Depois do lock, confere que a sessão ATUAL ainda existe: se ela foi revogada/encerrada
 * enquanto esta requisição esperava, a operação é recusada (401) — nada "ressuscita" uma sessão revogada.
 */
export async function lockSessionsOf(trx: Transaction<DB>, userId: number, currentSessionId: string): Promise<UserSessionRow[]> {
  const rows = await trx
    .selectFrom("sessions")
    .select(["id", "createdAt", "lastAccessed", "absoluteExpiresAt", "primaryMethod", "mfaVerifiedAt", "lastReauthAt"])
    .where("userId", "=", userId)
    .orderBy("id", "asc")
    .forUpdate()
    .execute();
  if (!rows.some((r) => r.id === currentSessionId)) throw new NotAuthenticatedError();
  return rows;
}

/** Passos 2 e 5 da ordem canônica: a linha do usuário (e a confirmação de que a conta não foi excluída) e depois as sessões. */
export async function lockUserAndSessions(trx: Transaction<DB>, userId: number, currentSessionId: string): Promise<UserSessionRow[]> {
  const locked = await lockUsersInOrder(trx, [userId]);
  if (locked.length === 0) throw new NotAuthenticatedError();
  const owner = await trx.selectFrom("users").select("anonymizedAt").where("id", "=", userId).executeTakeFirst();
  if (!owner || owner.anonymizedAt) throw new NotAuthenticatedError();
  return lockSessionsOf(trx, userId, currentSessionId);
}
