import { randomBytes } from "node:crypto";
import type { Transaction } from "kysely";
import { db } from "./db.js";
import type { DB } from "./schema.js";
import { NotAuthenticatedError } from "./getSetServerSession.js";
import { absoluteExpiryForNewSession } from "./sessionPolicy.js";

export type PrimaryMethod = "password" | "google" | "microsoft" | "apple" | "passkey";

export interface CreatedSession {
  id: string;
  createdAt: Date;
  absoluteExpiresAt: Date;
}

/**
 * Cria a linha de sessão (única definição de "sessão plena"). O id é aleatório de 256 bits gerado no servidor
 * (impede session fixation: nunca se aceita id vindo do cliente).
 */
export async function createSession(
  trx: Transaction<DB>,
  params: { userId: number; primaryMethod: PrimaryMethod; now?: Date }
): Promise<CreatedSession> {
  const now = params.now ?? new Date();
  const id = randomBytes(32).toString("hex");
  const absoluteExpiresAt = absoluteExpiryForNewSession(now);
  await trx
    .insertInto("sessions")
    .values({
      id,
      userId: params.userId,
      createdAt: now,
      lastAccessed: now,
      expiresAt: absoluteExpiresAt,
      absoluteExpiresAt,
      primaryMethod: params.primaryMethod,
    })
    .execute();
  return { id, createdAt: now, absoluteExpiresAt };
}

/**
 * Rotação do id da sessão (§25.15): após login, conclusão de MFA, troca de credencial, vínculo/desvínculo de método,
 * ativação/desativação de MFA e step-up. Cria um id novo e REMOVE o antigo na mesma transação; o teto absoluto e o
 * `created_at` lógico são herdados (rotacionar nunca prolonga a sessão). `reauth: true` marca `last_reauth_at`.
 *
 * Concorrência: a linha antiga é travada (`FOR UPDATE`) — duas rotações simultâneas do mesmo id: a primeira vence, a
 * segunda não encontra a linha e recebe `NotAuthenticatedError` (o id antigo já foi invalidado).
 */
export async function rotateSession(
  currentSessionId: string,
  options: { reauth?: boolean } = {}
): Promise<CreatedSession & { newId: string }> {
  return db.transaction().execute(async (trx) => {
    const old = await trx.selectFrom("sessions").selectAll().where("id", "=", currentSessionId).forUpdate().executeTakeFirst();
    if (!old) throw new NotAuthenticatedError();

    const now = new Date();
    const newId = randomBytes(32).toString("hex");
    await trx
      .insertInto("sessions")
      .values({
        id: newId,
        userId: old.userId,
        createdAt: old.createdAt,
        lastAccessed: now,
        expiresAt: old.expiresAt,
        absoluteExpiresAt: old.absoluteExpiresAt,
        primaryMethod: old.primaryMethod,
        mfaVerifiedAt: old.mfaVerifiedAt,
        lastReauthAt: options.reauth ? now : old.lastReauthAt,
      })
      .execute();
    await trx.deleteFrom("sessions").where("id", "=", currentSessionId).execute();
    return { id: newId, newId, createdAt: old.createdAt ?? now, absoluteExpiresAt: old.absoluteExpiresAt };
  });
}
