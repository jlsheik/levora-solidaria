import type { Transaction } from "kysely";
import { sql } from "kysely";
import type { DB } from "./schema.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { consumeChallenge, type ChallengeRow } from "./authChallenges.js";
import { decryptSecret, encryptSecret } from "./identityKeys.js";
import { issueRecoveryCodes } from "./mfa.js";
import { createSession } from "./sessionLifecycle.js";
import { lockPlatformAccessInOrder, lockUsersInOrder } from "./lockOrder.js";

/**
 * TRANSAÇÃO FINAL do bootstrap/recuperação do Platform Owner (Fase 90; §25.2). Tudo ou nada:
 *   users + user_passwords + platform_access(owner) + mfa_methods(active) + recovery codes + token consumido + challenge
 *   consumido + sessão + auditoria. Qualquer falha lança ⇒ ROLLBACK de tudo: nunca owner sem MFA, nunca token consumido sem owner,
 *   nunca owner/usuário/credencial parciais.
 */

export class BootstrapFinalizeError extends Error {
  constructor(readonly reason: "estado_incompleto" | "token_invalido" | "owner_ja_existe" | "email_em_uso" | "sem_owner" | "challenge_invalido") {
    super(`bootstrap: ${reason}`);
    this.name = "BootstrapFinalizeError";
  }
}

const isUniqueViolation = (e: unknown) => Boolean(e && typeof e === "object" && (e as { code?: string }).code === "23505");

export interface FinalizeResult {
  userId: number;
  email: string;
  displayName: string;
  recoveryCodes: string[];
  session: { id: string; createdAt: Date; absoluteExpiresAt: Date };
  recovered: boolean;
}

export async function finalizeBootstrap(trx: Transaction<DB>, params: { challenge: ChallengeRow; step: number; now: Date }): Promise<FinalizeResult> {
  const { challenge: ch, step, now } = params;
  const isRecovery = ch.purpose === "owner_recovery";
  if (ch.purpose !== "bootstrap_owner" && !isRecovery) throw new BootstrapFinalizeError("challenge_invalido");
  if (ch.bootstrapTokenId === null || !ch.pendingSecretCiphertext || ch.pendingSecretKeyId === null) throw new BootstrapFinalizeError("estado_incompleto");
  if (!isRecovery && (!ch.pendingPasswordHash || !ch.pendingDisplayName)) throw new BootstrapFinalizeError("estado_incompleto");

  // Serializa todo bootstrap/recuperação (e os emissores de token) na linha singleton.
  await sql`SELECT 1 FROM platform_state WHERE id = 1 FOR UPDATE`.execute(trx);

  const token = await trx.selectFrom("platformBootstrapTokens").selectAll().where("id", "=", ch.bootstrapTokenId).forUpdate().executeTakeFirst();
  if (!token || token.usedAt || token.revokedAt || token.claimedChallengeId !== ch.id || token.expiresAt.getTime() <= now.getTime()) {
    throw new BootstrapFinalizeError("token_invalido");
  }
  const totpSecret = decryptSecret(ch.pendingSecretCiphertext, ch.pendingSecretKeyId, `bootstrap:${ch.id}`);

  let userId: number;
  let email: string;
  let displayName: string;

  if (!isRecovery) {
    const owner = await trx.selectFrom("platformAccess").select("userId").where("level", "=", "owner").where("status", "=", "active").executeTakeFirst();
    if (owner) throw new BootstrapFinalizeError("owner_ja_existe");
    email = token.expectedEmail ?? "";
    displayName = ch.pendingDisplayName!;
    try {
      const created = await trx.insertInto("users").values({ email, displayName, role: "user" }).returning("id").executeTakeFirstOrThrow();
      userId = created.id;
    } catch (error) {
      if (isUniqueViolation(error)) throw new BootstrapFinalizeError("email_em_uso");
      throw error;
    }
    await trx.insertInto("userPasswords").values({ userId, passwordHash: ch.pendingPasswordHash! }).execute();
    await trx.insertInto("platformAccess").values({ userId, level: "owner", status: "active", grantOrigin: "bootstrap", bootstrapTokenId: token.id, grantedAt: now }).execute();
    await trx.updateTable("platformState").set({ ownerBootstrappedAt: now }).where("id", "=", 1).where("ownerBootstrappedAt", "is", null).execute();
  } else {
    userId = ch.userId!;
    await lockUsersInOrder(trx, [userId]);
    const [access] = await lockPlatformAccessInOrder(trx, [userId]);
    if (!access || access.status !== "active" || access.level !== "owner" || token.targetUserId !== userId) throw new BootstrapFinalizeError("sem_owner");
    const user = await trx.selectFrom("users").select(["email", "displayName"]).where("id", "=", userId).executeTakeFirstOrThrow();
    email = user.email;
    displayName = user.displayName;
    // Troca do método NA MESMA transação (o trigger deferido valida no COMMIT que o owner continua com MFA ativo).
    await trx.updateTable("mfaMethods").set({ status: "disabled", disabledAt: now }).where("userId", "=", userId).where("status", "in", ["active", "pending"]).execute();
    if (ch.pendingPasswordHash) {
      await trx.deleteFrom("userPasswords").where("userId", "=", userId).execute();
      await trx.insertInto("userPasswords").values({ userId, passwordHash: ch.pendingPasswordHash }).execute();
    }
    // Recuperação encerra TODAS as sessões do owner.
    await trx.deleteFrom("sessions").where("userId", "=", userId).execute();
  }

  const { ciphertext, keyId } = encryptSecret(totpSecret, `mfa:${userId}`);
  await trx
    .insertInto("mfaMethods")
    .values({ userId, status: "active", secretCiphertext: ciphertext, secretKeyId: keyId, createdAt: now, confirmedAt: now, lastUsedStep: step, lastUsedAt: now })
    .execute();
  const recoveryCodes = await issueRecoveryCodes(trx, userId, now);

  const used = await trx
    .updateTable("platformBootstrapTokens")
    .set({ usedAt: now })
    .where("id", "=", token.id)
    .where("usedAt", "is", null)
    .where("revokedAt", "is", null)
    .where("expiresAt", ">", now)
    .returning("id")
    .executeTakeFirst();
  if (!used) throw new BootstrapFinalizeError("token_invalido");
  if (!(await consumeChallenge(trx, ch.id, now))) throw new BootstrapFinalizeError("challenge_invalido");

  const session = await createSession(trx, { userId, primaryMethod: "password", mfaVerified: true, now });

  // Auditoria por último (hash-chain). Nenhum segredo: nem token, nem TOTP, nem recovery codes, nem hash.
  await recordAuditLogEntry(
    {
      organizationId: null,
      actorUserId: userId,
      action: isRecovery ? "plataforma.owner_recuperado" : "plataforma.owner_provisionado",
      entityType: "user",
      entityId: String(userId),
      metadata: { origem: "bootstrap", finalidade: token.purpose },
    },
    trx
  );
  await recordAuditLogEntry({ organizationId: null, actorUserId: userId, action: "mfa.ativado", entityType: "user", entityId: String(userId), metadata: { tipo: "totp", origem: "bootstrap" } }, trx);
  await recordAuditLogEntry({ organizationId: null, actorUserId: userId, action: "mfa.recovery_codes_regenerados", entityType: "user", entityId: String(userId), metadata: { quantidade: recoveryCodes.length } }, trx);

  return { userId, email, displayName, recoveryCodes, session, recovered: isRecovery };
}
