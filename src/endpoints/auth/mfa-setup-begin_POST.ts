import { compare } from "bcryptjs";
import { db } from "../../helpers/db.js";
import { buildErrorResponse, ConflictError } from "../../helpers/errorResponse.js";
import { NotAuthenticatedError } from "../../helpers/getSetServerSession.js";
import { getServerUserSession } from "../../helpers/getServerUserSession.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../helpers/rateLimit.js";
import { recordAuditLogEntry } from "../../helpers/auditLog.js";
import { loadPendingChallengeForUpdate, peekChallengeUserId, readChallengeSecret } from "../../helpers/authChallenges.js";
import { beginTotpSetup, getMfaMethod } from "../../helpers/mfa.js";
import { encryptSecret } from "../../helpers/identityKeys.js";
import { buildOtpauthUri, base32Encode, generateTotpSecret } from "../../helpers/totp.js";
import { lockUsersInOrder } from "../../helpers/lockOrder.js";
import { invalidChallengeResponse, jsonResponse } from "../../helpers/authResponses.js";
import { schema } from "./mfa-setup-begin_POST.schema.js";
import superjson from "superjson";

const LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };

/**
 * Inicia a configuração do TOTP. NADA fica ativo aqui ("QR gerado" ≠ "MFA ativo"): o segredo nasce CIFRADO como `pending`
 * (ou no challenge, no bootstrap/recuperação do owner) e só vira ativo em mfa-setup-confirm, com um código válido.
 * Três contextos: (1) challenge de INSCRIÇÃO (titular de plataforma sem MFA que acabou de provar a senha); (2) challenge de
 * bootstrap/recuperação do owner (o usuário/MFA ainda não existe: o segredo pendente fica no challenge); (3) sessão completa
 * (ativação voluntária; exige reconfirmar a senha).
 */
export async function handle(request: Request) {
  try {
    const ip = getClientIp(request);
    const limit = checkRateLimit({ bucket: "mfa-setup-begin", identifier: ip, ...LIMIT });
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds, "Muitas tentativas. Aguarde antes de tentar de novo.");
    const raw = (await request.text()) || superjson.stringify({});
    const input = schema.parse(superjson.parse(raw));
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
          const user = await trx.selectFrom("users").select("email").where("id", "=", challenge.userId!).executeTakeFirstOrThrow();
          if (await getMfaMethod(trx, challenge.userId!, "active")) return { type: "ja_ativo" as const };
          const setup = await beginTotpSetup(trx, { userId: challenge.userId!, accountLabel: user.email, now });
          await recordAuditLogEntry({ organizationId: null, actorUserId: challenge.userId, action: "mfa.configuracao_iniciada", entityType: "user", entityId: String(challenge.userId), metadata: { tipo: "totp", contexto: "inscricao_no_login" } }, trx);
          return { type: "ok" as const, ...setup };
        }

        // bootstrap_owner / owner_recovery: o segredo pendente fica no challenge (cifrado, AAD = id do challenge).
        if (challenge.purpose === "bootstrap_owner" && (!challenge.pendingPasswordHash || !challenge.pendingDisplayName)) return { type: "credenciais_pendentes" as const };
        const token = await trx.selectFrom("platformBootstrapTokens").select("expectedEmail").where("id", "=", challenge.bootstrapTokenId!).executeTakeFirst();
        const totpSecret = generateTotpSecret();
        const { ciphertext, keyId } = encryptSecret(totpSecret, `bootstrap:${challenge.id}`);
        await trx.updateTable("authChallenges").set({ pendingSecretCiphertext: ciphertext, pendingSecretKeyId: keyId, pendingSecretStep: null }).where("id", "=", challenge.id).execute();
        await recordAuditLogEntry({ organizationId: null, actorUserId: challenge.userId, action: "mfa.configuracao_iniciada", entityType: "user", entityId: challenge.userId === null ? null : String(challenge.userId), metadata: { tipo: "totp", contexto: challenge.purpose } }, trx);
        return { type: "ok" as const, otpauthUri: buildOtpauthUri({ secret: totpSecret, accountLabel: token?.expectedEmail ?? "owner" }), manualKey: base32Encode(totpSecret) };
      });
      if (outcome.type === "invalido") return invalidChallengeResponse();
      if (outcome.type === "ja_ativo") throw new ConflictError("O segundo fator já está ativo.", "mfa_ja_ativo");
      if (outcome.type === "credenciais_pendentes") return jsonResponse(409, { message: "Defina nome e senha antes de configurar o autenticador.", code: "credenciais_pendentes" });
      return jsonResponse(200, { otpauthUri: outcome.otpauthUri, manualKey: outcome.manualKey });
    }

    // Contexto 3: sessão completa. Reautenticação por senha (quando a conta tem senha) ANTES de gerar o segredo.
    const { user } = await getServerUserSession(request);
    const userLimit = checkRateLimit({ bucket: "mfa-setup-begin-user", identifier: String(user.id), ...LIMIT });
    if (!userLimit.allowed) return rateLimitResponse(userLimit.retryAfterSeconds, "Muitas tentativas. Aguarde antes de tentar de novo.");
    const passwordRow = await db.selectFrom("userPasswords").select("passwordHash").where("userId", "=", user.id).executeTakeFirst();
    if (passwordRow) {
      if (!input.password || !(await compare(input.password, passwordRow.passwordHash))) {
        return jsonResponse(401, { message: "Senha incorreta", code: "senha_incorreta" });
      }
    }
    const setup = await db.transaction().execute(async (trx) => {
      await lockUsersInOrder(trx, [user.id]);
      if (await getMfaMethod(trx, user.id, "active")) throw new ConflictError("O segundo fator já está ativo.", "mfa_ja_ativo");
      const result = await beginTotpSetup(trx, { userId: user.id, accountLabel: user.email, now });
      await recordAuditLogEntry({ organizationId: null, actorUserId: user.id, action: "mfa.configuracao_iniciada", entityType: "user", entityId: String(user.id), metadata: { tipo: "totp", contexto: "sessao" } }, trx);
      return result;
    });
    return jsonResponse(200, { otpauthUri: setup.otpauthUri, manualKey: setup.manualKey });
  } catch (error: unknown) {
    if (error instanceof NotAuthenticatedError) return jsonResponse(401, { error: "Not authenticated" });
    console.error("Erro ao iniciar configuração de MFA:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível iniciar a configuração");
  }
}
