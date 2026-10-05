import { db } from "./db.js";
import { User } from "./User.js";
import { isPlatformMfaRequired } from "./identityKeys.js";
import { evaluateSession, SESSION_POLICY, type SessionTier } from "./sessionPolicy.js";

import {
  CleanupProbability,
  getServerSessionOrThrow,
  NotAuthenticatedError,
} from "./getSetServerSession.js";

export async function getServerUserSession(request: Request) {
  const session = await getServerSessionOrThrow(request);

  // Limpeza oportunista (só coleta de lixo — a imposição real é a validação abaixo): remove sessões fora do teto
  // absoluto ou ociosas há mais que o maior limite ocioso. Sessões de plataforma (60 min) são encerradas na validação.
  if (Math.random() < CleanupProbability) {
    const now = new Date();
    const idleCutoff = new Date(now.getTime() - SESSION_POLICY.standard.idleMs);
    try {
      await db
        .deleteFrom("sessions")
        .where((eb) => eb.or([eb("lastAccessed", "<", idleCutoff), eb("absoluteExpiresAt", "<", now)]))
        .execute();
    } catch (cleanupError) {
      // Log but don't fail the request if cleanup fails
      console.error("Session cleanup error:", cleanupError);
    }
  }

  // Sessão + usuário + acesso de plataforma ATIVO (se houver) numa única consulta. O poder de plataforma é relido do
  // banco a cada requisição (nunca confiado ao cookie/JWT).
  const results = await db
    .selectFrom("sessions")
    .innerJoin("users", "sessions.userId", "users.id")
    .leftJoin("platformAccess", (join) =>
      join.onRef("platformAccess.userId", "=", "users.id").on("platformAccess.status", "=", "active")
    )
    .select([
      "sessions.id as sessionId",
      "sessions.createdAt as sessionCreatedAt",
      "sessions.lastAccessed as sessionLastAccessed",
      "sessions.absoluteExpiresAt as sessionAbsoluteExpiresAt",
      "sessions.primaryMethod as sessionPrimaryMethod",
      "sessions.mfaVerifiedAt as sessionMfaVerifiedAt",
      "sessions.lastReauthAt as sessionLastReauthAt",
      "sessions.primaryReauthAt as sessionPrimaryReauthAt",
      "users.id",
      "users.email",
      "users.displayName",
      "users.avatarUrl",
      "platformAccess.level as platformLevel",
    ])
    .where("sessions.id", "=", session.id)
    .limit(1)
    .execute();

  if (results.length === 0) {
    throw new NotAuthenticatedError();
  }

  const result = results[0];
  const platformLevel = result.platformLevel ?? null;
  const tier: SessionTier = platformLevel ? "platform" : "standard";
  const now = new Date();

  // Fase 90: titular de platform_access (owner/admin) NUNCA tem sessão válida sem MFA concluído. Sessões antigas (anteriores à
  // fase) ou criadas por qualquer caminho sem segundo fator deixam de valer para quem tem poder de plataforma — a pessoa entra
  // de novo e cai no desafio de MFA (ou na inscrição, se ainda não tem TOTP). O estado parcial vive em auth_challenges.
  if (platformLevel && isPlatformMfaRequired() && !result.sessionMfaVerifiedAt) {
    throw new NotAuthenticatedError();
  }

  const evaluation = evaluateSession({
    tier,
    createdAt: result.sessionCreatedAt,
    lastAccessed: result.sessionLastAccessed,
    absoluteExpiresAt: result.sessionAbsoluteExpiresAt,
    now,
  });
  if (!evaluation.valid) {
    // Expirada (ociosa ou teto absoluto): a linha é removida e o JWT, ainda que válido, deixa de valer.
    try {
      await db.deleteFrom("sessions").where("id", "=", session.id).execute();
    } catch (error) {
      console.error("Session expiry cleanup error:", error);
    }
    throw new NotAuthenticatedError();
  }

  const user = {
    id: result.id,
    email: result.email,
    displayName: result.displayName,
    avatarUrl: result.avatarUrl,
    // `role` é derivado (compatibilidade com o frontend): a autorização de plataforma é `platformAccess`.
    role: platformLevel ? ("admin" as const) : ("user" as const),
    platformLevel,
  };

  // Update the session's lastAccessed timestamp
  await db
    .updateTable("sessions")
    .set({ lastAccessed: now })
    .where("id", "=", session.id)
    .execute();

  return {
    user: user satisfies User,
    // make sure to update the session in cookie
    session: {
      ...session,
      lastAccessed: now,
      absoluteExpiresAt: evaluation.effectiveAbsoluteExpiresAt,
      primaryMethod: result.sessionPrimaryMethod,
      mfaVerifiedAt: result.sessionMfaVerifiedAt,
      lastReauthAt: result.sessionLastReauthAt,
      primaryReauthAt: result.sessionPrimaryReauthAt,
    },
  };
}
