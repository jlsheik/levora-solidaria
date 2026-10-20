import { createHash } from "node:crypto";
import type { Transaction } from "kysely";
import type { DB } from "./schema.js";
import { NotAuthenticatedError } from "./getSetServerSession.js";

/**
 * Conta do usuário (Fase 88) — sessões. NÃO é um segundo mecanismo de sessão: a sessão continua sendo UMA linha em
 * `sessions` (o cookie assinado carrega só o id); revogar = apagar a linha, exatamente como o logout já faz. O
 * `getServerUserSession` recusa qualquer cookie cuja linha não exista mais.
 *
 * O id real da sessão nunca vai ao cliente: a listagem usa um identificador opaco derivado (SHA-256 truncado). O id é
 * aleatório de 256 bits, então o derivado não o revela, e só vale dentro das sessões do PRÓPRIO usuário.
 */
export function sessionHandle(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

export interface UserSessionRow {
  id: string;
  createdAt: Date | null;
  lastAccessed: Date | null;
}

/**
 * Trava TODAS as sessões do usuário, em ordem de id (ordem fixa = sem deadlock entre duas operações que apagam
 * conjuntos sobrepostos de sessões). Depois do lock, confere que a sessão ATUAL ainda existe: se ela foi
 * revogada/encerrada enquanto esta requisição esperava, a operação é recusada (401) — nada "ressuscita" uma sessão
 * revogada.
 *
 * Ordem de locks desta frente: user_passwords → sessions → users (a mesma de `account-delete_POST`).
 */
export async function lockUserSessions(trx: Transaction<DB>, userId: number, currentSessionId: string): Promise<UserSessionRow[]> {
  const rows = await trx
    .selectFrom("sessions")
    .select(["id", "createdAt", "lastAccessed"])
    .where("userId", "=", userId)
    .orderBy("id", "asc")
    .forUpdate()
    .execute();
  if (!rows.some((r) => r.id === currentSessionId)) throw new NotAuthenticatedError();
  return rows;
}
