import { db } from "../../helpers/db.js";
import { buildErrorResponse, ConflictError } from "../../helpers/errorResponse.js";
import { NotAuthenticatedError } from "../../helpers/getSetServerSession.js";
import { getServerUserSession } from "../../helpers/getServerUserSession.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../helpers/rateLimit.js";
import { recordAuditLogEntry } from "../../helpers/auditLog.js";
import { auditLoginSuccess } from "../../helpers/loginAudit.js";
import { consumeChallenge, loadPendingChallengeForUpdate, peekChallengeUserId, readChallengeSecret, recordChallengeFailure, clearChallengeCookie } from "../../helpers/authChallenges.js";
import { activatePendingMethod, getMfaMethod, verifyPendingSetup } from "../../helpers/mfa.js";
import { decryptSecret } from "../../helpers/identityKeys.js";
import { matchTotp } from "../../helpers/totp.js";
import { BootstrapFinalizeError, finalizeBootstrap } from "../../helpers/bootstrapFinalize.js";
import { lockUsersInOrder } from "../../helpers/lockOrder.js";
import { createSession, rotateSessionInTx } from "../../helpers/sessionLifecycle.js";
import { invalidChallengeResponse, jsonResponse, loadUserPayload, sessionCookieResponse } from "../../helpers/authResponses.js";
import { schema } from "./mfa-setup-confirm_POST.schema.js";
import superjson from "superjson";

const LIMIT = { limit: 20, windowMs: 15 * 60 * 1000 };

/**
 * Confirma o TOTP: só com um código VÁLIDO o método vira `active` e os recovery codes são emitidos (UMA vez, na resposta).
 * Código errado ⇒ continua pendente (5 erros descartam o pendente). Contextos:
 *  - challenge de inscrição (login do titular de plataforma sem MFA): ativa + cria a sessão (id novo, mfa_verified_at);
 *  - challenge de bootstrap/recuperação do owner: executa a TRANSAÇÃO FINAL única (users, senha, platform_access, MFA,
 *    recovery codes, token consumido, sessão, auditoria — tudo ou nada);
 *  - sessão completa: ativa, revoga as OUTRAS sessões e ROTACIONA a atual (id novo) na mesma transação.
 */
export async function handle(request: Request) {
  try {
    const ip = getClientIp(request);
    const limit = checkRateLimit({ bucket: "mfa-setup-confirm", identifier: ip, ...LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitas tentativas. Aguarde antes de tentar de novo.");
    const input = schema.parse(superjson.parse(await request.text()));
    const now = new Date();

    const secret = readChallengeSecret(request);
    if (secret) {
      const outcome = await db.transaction().execute(async (trx) => {
        const ownerId = await peekChallengeUserId(trx, secret);
        if (ownerId === undefined) return { type: "invalido" as const };
        if (ownerId !== null) await lockUsersInOrder(trx, [ownerId]);
        const challenge = await loadPendingChallengeForUpdate(trx, secret, ["mfa_enroll", "bootstrap_owner", "owner_recovery"], now);
        if (!challenge) return { type: "invalido" as const };

        if (challenge.purpose === "mfa_enroll") {
          const pending = await getMfaMethod(trx, challenge.userId!, "pending", { forUpdate: true });
          if (!pending) return { type: "sem_pendente" as const };
          const check = await verifyPendingSetup(trx, pending, input.code, now);
          if (!check.ok) {
            const { exhausted } = await recordChallengeFailure(trx, challenge);
            await recordAuditLogEntry({ organizationId: null, actorUserId: challenge.userId, action: "mfa.tentativa_falhou", entityType: "user", entityId: String(challenge.userId), metadata: { tipo: "totp", contexto: "configuracao", desafioEsgotado: exhausted } }, trx);
            return { type: "falha" as const, exhausted: exhausted || check.discarded };
          }
          const recoveryCodes = await activatePendingMethod(trx, { method: pending, step: check.step, now });
          if (!(await consumeChallenge(trx, challenge.id, now))) return { type: "invalido" as const };
          const session = await createSession(trx, { userId: challenge.userId!, primaryMethod: "password", mfaVerified: true, now });
          const user = await loadUserPayload(trx, challenge.userId!);
          await recordAuditLogEntry({ organizationId: null, actorUserId: user.id, action: "mfa.ativado", entityType: "user", entityId: String(user.id), metadata: { tipo: "totp", contexto: "inscricao_no_login" } }, trx);
          await recordAuditLogEntry({ organizationId: null, actorUserId: user.id, action: "mfa.recovery_codes_regenerados", entityType: "user", entityId: String(user.id), metadata: { quantidade: recoveryCodes.length } }, trx);
          await auditLoginSuccess(trx, { userId: user.id, method: "senha", ip });
          return { type: "ok" as const, recoveryCodes, session, user };
        }

        // bootstrap_owner / owner_recovery
        if (!challenge.pendingSecretCiphertext || challenge.pendingSecretKeyId === null) return { type: "sem_pendente" as const };
        const totpSecret = decryptSecret(challenge.pendingSecretCiphertext, challenge.pendingSecretKeyId, `bootstrap:${challenge.id}`);
        const step = matchTotp(totpSecret, input.code, now.getTime(), null);
        if (step === null) {
          const { exhausted } = await recordChallengeFailure(trx, challenge);
          return { type: "falha" as const, exhausted };
        }
        try {
          const result = await finalizeBootstrap(trx, { challenge, step, now });
          const user = await loadUserPayload(trx, result.userId);
          return { type: "ok" as const, recoveryCodes: result.recoveryCodes, session: result.session, user };
        } catch (error) {
          if (error instanceof BootstrapFinalizeError) throw error; // ROLLBACK total; tratado abaixo
          throw error;
        }
      });

      if (outcome.type === "invalido") return invalidChallengeResponse();
      if (outcome.type === "sem_pendente") return jsonResponse(409, { message: "Inicie a configuração do autenticador antes de confirmar.", code: "sem_configuracao_pendente" });
      if (outcome.type === "falha") {
        const response = jsonResponse(401, { message: outcome.exhausted ? "Código incorreto. Esta etapa foi encerrada; recomece." : "Código incorreto.", code: outcome.exhausted ? "challenge_esgotado" : "codigo_invalido" });
        if (outcome.exhausted) clearChallengeCookie(response);
        return response;
      }
      return sessionCookieResponse({ user: outcome.user, recoveryCodes: outcome.recoveryCodes }, outcome.session, now);
    }

    // Contexto: sessão completa.
    const { user, session } = await getServerUserSession(request);
    const outcome = await db.transaction().execute(async (trx) => {
      await lockUsersInOrder(trx, [user.id]);
      if (await getMfaMethod(trx, user.id, "active")) throw new ConflictError("O segundo fator já está ativo.", "mfa_ja_ativo");
      const pending = await getMfaMethod(trx, user.id, "pending", { forUpdate: true });
      if (!pending) return { type: "sem_pendente" as const };
      const check = await verifyPendingSetup(trx, pending, input.code, now);
      if (!check.ok) {
        await recordAuditLogEntry({ organizationId: null, actorUserId: user.id, action: "mfa.tentativa_falhou", entityType: "user", entityId: String(user.id), metadata: { tipo: "totp", contexto: "configuracao", descartado: check.discarded } }, trx);
        return { type: "falha" as const, discarded: check.discarded };
      }
      const recoveryCodes = await activatePendingMethod(trx, { method: pending, step: check.step, now });
      // Mudança de credencial: revoga as OUTRAS sessões e rotaciona a atual (id novo; teto absoluto herdado).
      const revoked = await trx.deleteFrom("sessions").where("userId", "=", user.id).where("id", "<>", session.id).returning("id").execute();
      const rotated = await rotateSessionInTx(trx, session.id, { mfaVerified: true });
      await recordAuditLogEntry({ organizationId: null, actorUserId: user.id, action: "mfa.ativado", entityType: "user", entityId: String(user.id), metadata: { tipo: "totp", contexto: "sessao", outrasSessoesRevogadas: revoked.length } }, trx);
      await recordAuditLogEntry({ organizationId: null, actorUserId: user.id, action: "mfa.recovery_codes_regenerados", entityType: "user", entityId: String(user.id), metadata: { quantidade: recoveryCodes.length } }, trx);
      return { type: "ok" as const, recoveryCodes, session: { id: rotated.newId, createdAt: rotated.createdAt, absoluteExpiresAt: rotated.absoluteExpiresAt } };
    });
    if (outcome.type === "sem_pendente") return jsonResponse(409, { message: "Inicie a configuração do autenticador antes de confirmar.", code: "sem_configuracao_pendente" });
    if (outcome.type === "falha") return jsonResponse(401, { message: outcome.discarded ? "Código incorreto. A configuração foi descartada; recomece." : "Código incorreto.", code: outcome.discarded ? "configuracao_descartada" : "codigo_invalido" });
    return sessionCookieResponse({ recoveryCodes: outcome.recoveryCodes }, outcome.session, now);
  } catch (error: unknown) {
    if (error instanceof NotAuthenticatedError) return jsonResponse(401, { error: "Not authenticated" });
    if (error instanceof BootstrapFinalizeError) {
      // Tudo foi revertido (nenhum usuário/owner/MFA/credencial parcial; o token NÃO foi consumido).
      const response = jsonResponse(409, { message: "Não foi possível concluir a ativação. Gere um novo token no servidor.", code: "ativacao_falhou" });
      return response;
    }
    console.error("Erro ao confirmar MFA:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível confirmar o autenticador");
  }
}
