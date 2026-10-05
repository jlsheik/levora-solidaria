// adapt this to your database schema
import { db } from "../../helpers/db.js";
import { sql } from "kysely";
import { z } from "zod";
import { schema } from "./login_with_password_POST.schema.js";
import { compare } from "bcryptjs";
import { setServerSession } from "../../helpers/getSetServerSession.js";
import { createSession } from "../../helpers/sessionLifecycle.js";
import { auditLoginFailure, auditLoginSuccess, auditLoginSuspicious, ipPrefix } from "../../helpers/loginAudit.js";
import { createChallenge, setChallengeCookie } from "../../helpers/authChallenges.js";
import { getMfaMethod } from "../../helpers/mfa.js";
import { isPlatformMfaRequired } from "../../helpers/identityKeys.js";
import { recordAuditLogEntry } from "../../helpers/auditLog.js";
import { lockUsersInOrder } from "../../helpers/lockOrder.js";
import { User } from "../../helpers/User.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../helpers/rateLimit.js";
import superjson from "superjson";

// Fase 51 (SEC-04): hash bcrypt fixo, pré-computado uma única vez (nunca
// gerado por request, nunca configurável), usado só para que o caminho de
// "usuário não existe" pague o MESMO custo de CPU que `compare()` contra
// um hash real pagaria — sem isto, medimos uma diferença real e
// consistente de ~59ms entre os dois caminhos (150 amostras, desvio-padrão
// <2ms nos dois cenários, ver relatório da Fase 51), porque o caminho
// "não existe" simplesmente nunca chamava bcrypt. Mesmo custo (saltRounds
// 10) de `generatePasswordHash.tsx`, para que o tempo de CPU gasto seja
// equivalente nos dois ramos. Nunca precisa corresponder a nenhuma senha
// real — só existe para a comparação ser chamada.
const DUMMY_PASSWORD_HASH_FOR_TIMING_EQUALIZATION =
  "$2b$10$P5TW/tRpgKhmoNqyNmfS5O8W.A5vnV1knJ4hRoOLxQEZOYfUv.aSa";

// Configuration constants
const RATE_LIMIT_CONFIG = {
  maxFailedAttempts: 5,
  lockoutWindowMinutes: 15,
  lockoutDurationMinutes: 15,
  cleanupProbability: 0.1,
} as const;

// Limite por IP, além do bloqueio por e-mail acima: o bloqueio por e-mail
// protege uma CONTA específica sendo atacada; este protege o servidor de
// alguém varrendo muitos e-mails diferentes a partir do mesmo IP.
const IP_RATE_LIMIT = { limit: 20, windowMs: 15 * 60 * 1000 };

// Fase 90 — ESTRATÉGIA DO LOCK (docs/IDENTIDADE_FASE90_AUDITORIA.md §login lock). O bloqueio por e-mail (qualquer origem) deixava
// qualquer pessoa travar o login do Platform Owner. Agora, para contas PROTEGIDAS por segundo fator (MFA ativo ou titular de
// platform_access) o bloqueio é por (e-mail, rede /24): quem erra senha de outra rede NÃO trava o dono; a força bruta continua
// limitada por rede (5/15 min), por IP (20/15 min) e, sobretudo, pelo TOTP (que exige o 2º fator mesmo com a senha certa, com
// bloqueio progressivo próprio). Contas SEM 2º fator mantêm o bloqueio por e-mail (a senha é a única defesa). Falhas somadas
// de várias redes (>= 20 em 15 min) geram um evento de auditoria "login_suspeito" — alerta, não bloqueio.
const SUSPICIOUS_FAILURES_THRESHOLD = 20;

// Helper function to safely convert union type to Date
function safeToDate(
  value: string | number | bigint | Date | null | undefined
): Date | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "bigint") {
    // Convert bigint to number (assuming it's a timestamp in milliseconds)
    return new Date(Number(value));
  }

  return new Date(value);
}

export async function handle(request: Request) {
  try {
    const ip = getClientIp(request);
    const ipLimit = checkRateLimit({ bucket: "login", identifier: ip, ...IP_RATE_LIMIT });
    if (!ipLimit.allowed) {
      return rateLimitResponse(ipLimit.retryAfterSeconds, "Muitas tentativas de login a partir deste dispositivo. Aguarde antes de tentar de novo.");
    }

    const json = superjson.parse(await request.text());
    const { email, password } = schema.parse(json);

    // Normalize email to lowercase for consistent handling
    const normalizedEmail = email.toLowerCase();
    const now = new Date();
    const windowStart = new Date(
      now.getTime() - RATE_LIMIT_CONFIG.lockoutWindowMinutes * 60 * 1000
    );

    // Start transaction for atomic rate limiting and session creation
    const result = await db.transaction().execute(async (trx) => {
      // Use PostgreSQL advisory lock to serialize access per email
      // This prevents concurrent processing of the same email address
      // The lock is automatically released when the transaction ends
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${normalizedEmail},0))`.execute(
        trx
      );

      // Fase 90: a conta é "protegida" (2º fator ou poder de plataforma)? Define o ESCOPO do bloqueio (ver acima).
      const prefix = ipPrefix(ip);
      const candidate = await trx
        .selectFrom("users")
        .leftJoin("platformAccess", (join) => join.onRef("platformAccess.userId", "=", "users.id").on("platformAccess.status", "=", "active"))
        .select(["users.id", "platformAccess.level as platformLevel"])
        .where(sql`LOWER(users.email)`, "=", normalizedEmail)
        .limit(1)
        .executeTakeFirst();
      const candidateMfa = candidate ? await getMfaMethod(trx, candidate.id, "active") : undefined;
      const protectedAccount = Boolean(candidate && (candidate.platformLevel || candidateMfa));

      // Get rate limiting info efficiently - use COUNT and MAX instead of SELECT *
      let attemptsQuery = trx
        .selectFrom("loginAttempts")
        .select([
          trx.fn.countAll<number>().as("failedCount"),
          trx.fn.max(trx.dynamic.ref("attemptedAt")).as("lastFailedAt"),
        ])
        .where("email", "=", normalizedEmail)
        .where("success", "=", false)
        .where("attemptedAt", ">=", windowStart)
        .where("attemptedAt", "is not", null); // Ensure null safety
      if (protectedAccount) attemptsQuery = attemptsQuery.where("ipPrefix", "=", prefix);
      const rateLimitQuery = await attemptsQuery.executeTakeFirst();

      const { failedCount = 0, lastFailedAt = null } = rateLimitQuery || {};
      const safeLastFailedAt = safeToDate(lastFailedAt);

      // Check if user is locked out
      if (
        rateLimitQuery &&
        failedCount >= RATE_LIMIT_CONFIG.maxFailedAttempts &&
        safeLastFailedAt
      ) {
        const lockoutEnd = new Date(
          safeLastFailedAt.getTime() +
            RATE_LIMIT_CONFIG.lockoutDurationMinutes * 60 * 1000
        );

        if (now < lockoutEnd) {
          const remainingMinutes = Math.ceil(
            (lockoutEnd.getTime() - now.getTime()) / (60 * 1000)
          );
          // DO NOT log blocked attempts to prevent extending lockout indefinitely
          // (loginAttempts). A auditoria é outra trilha: 1 evento por e-mail+IP a cada 10 min (loginAudit).
          await auditLoginFailure(trx, { userId: null, email: normalizedEmail, ip, method: "senha", reason: "bloqueio_temporario" });
          return {
            type: "rate_limited" as const,
            remainingMinutes,
          };
        }
      }

      // Find user by email (normalized). Desde a Fase 48
      // (idx_users_email_lower), existe no máximo UMA linha cujo
      // LOWER(email) bate aqui — o LIMIT 1 deixou de ser uma aposta sobre
      // qual das duas linhas o Postgres devolveria (achado SEC-02 da
      // auditoria de segurança) e passou a ser só defesa em profundidade.
      const userResults = await trx
        .selectFrom("users")
        .innerJoin("userPasswords", "users.id", "userPasswords.userId")
        .select([
          "users.id",
          "users.email",
          "users.displayName",
          "users.avatarUrl",
          "userPasswords.passwordHash",
        ])
        .where(sql`LOWER(users.email)`, "=", normalizedEmail)
        .limit(1)
        .execute();

      if (userResults.length === 0) {
        // Fase 51 (SEC-04): paga o mesmo custo de CPU que o caminho de
        // usuário existente pagaria em compare() — resultado sempre
        // descartado, só existe para equalizar o tempo de resposta (ver
        // DUMMY_PASSWORD_HASH_FOR_TIMING_EQUALIZATION acima).
        await compare(password, DUMMY_PASSWORD_HASH_FOR_TIMING_EQUALIZATION);

        // Log failed attempt for non-existent user
        await trx
          .insertInto("loginAttempts")
          .values({
            email: normalizedEmail,
            attemptedAt: now,
            success: false,
            ipPrefix: prefix,
          })
          .execute();

        await auditLoginFailure(trx, { userId: null, email: normalizedEmail, ip, method: "senha", reason: "credenciais_invalidas" });
        return {
          type: "auth_failed" as const,
        };
      }

      const user = userResults[0];

      // Verify password
      const passwordValid = await compare(password, user.passwordHash);
      if (!passwordValid) {
        // Log failed attempt for invalid password
        await trx
          .insertInto("loginAttempts")
          .values({
            email: normalizedEmail,
            attemptedAt: now,
            success: false,
            ipPrefix: prefix,
          })
          .execute();

        await auditLoginFailure(trx, { userId: user.id, email: normalizedEmail, ip, method: "senha", reason: "credenciais_invalidas" });
        const accountWide = await trx
          .selectFrom("loginAttempts")
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .where("email", "=", normalizedEmail)
          .where("success", "=", false)
          .where("attemptedAt", ">=", windowStart)
          .executeTakeFirstOrThrow();
        if (Number(accountWide.n) >= SUSPICIOUS_FAILURES_THRESHOLD) await auditLoginSuspicious(trx, { userId: user.id });
        return {
          type: "auth_failed" as const,
        };
      }

      // Password is valid - log successful attempt
      await trx
        .insertInto("loginAttempts")
        .values({
          email: normalizedEmail,
          attemptedAt: now,
          success: true,
          ipPrefix: prefix,
        })
        .execute();

      // Reset failed attempts counter by deleting previous failed attempts
      // This preserves audit trail of successful logins. Conta protegida: só as falhas DESTA rede (quem erra de fora não
      // perde o histórico; quem acerta a senha não apaga a evidência de tentativas de outras redes).
      let resetQuery = trx.deleteFrom("loginAttempts").where("email", "=", normalizedEmail).where("success", "=", false);
      if (protectedAccount) resetQuery = resetQuery.where("ipPrefix", "=", prefix);
      await resetQuery.execute();

      // CORRIDA login × ativação/desativação de MFA (e concessão/revogação de plataforma): a decisão "precisa de 2º fator?" e a
      // criação da sessão acontecem SOB o lock da linha do usuário (o mesmo que a ativação do MFA toma). Sem isto, um login que
      // leu "sem MFA" antes do COMMIT da ativação podia inserir uma sessão pré-MFA DEPOIS de a ativação revogar as outras.
      await lockUsersInOrder(trx, [user.id]);
      const freshAccess = await trx.selectFrom("platformAccess").select("level").where("userId", "=", user.id).where("status", "=", "active").executeTakeFirst();
      const freshMfa = await getMfaMethod(trx, user.id, "active");
      const platform = freshAccess ? { level: freshAccess.level } : undefined;

      // Fase 90: senha correta NÃO é login completo para quem tem 2º fator (ou poder de plataforma). Emite-se um
      // auth_challenge (cookie próprio, sem sessão) — a sessão só nasce em mfa-verify / mfa-setup-confirm.
      const needsEnrollment = !freshMfa && Boolean(platform) && isPlatformMfaRequired();
      if (freshMfa || needsEnrollment) {
        const challenge = await createChallenge(trx, {
          purpose: freshMfa ? "mfa_login" : "mfa_enroll",
          userId: user.id,
          primaryMethod: "password",
          now,
        });
        await recordAuditLogEntry(
          { organizationId: null, actorUserId: user.id, action: "mfa.desafio_emitido", entityType: "user", entityId: String(user.id), metadata: { metodo: "senha", tipo: freshMfa ? "verificacao" : "inscricao", ipPrefix: prefix } },
          trx
        );
        return { type: "challenge" as const, user, challenge, kind: freshMfa ? ("verify" as const) : ("enroll" as const) };
      }

      // Create session inside the same transaction to ensure atomicity
      const createdSession = await createSession(trx, { userId: user.id, primaryMethod: "password", now });
      const sessionId = createdSession.id;

      // Auditoria por último (a hash-chain toma um advisory lock global).
      await auditLoginSuccess(trx, { userId: user.id, method: "senha", ip });

      return {
        type: "success" as const,
        user,
        sessionId,
        sessionCreatedAt: now,
        absoluteExpiresAt: createdSession.absoluteExpiresAt,
        platformLevel: platform?.level ?? null,
      };
    });

    // Clean up old login attempts periodically
    // Run cleanup outside transaction to prevent extending transaction time and potential deadlocks
    if (Math.random() < RATE_LIMIT_CONFIG.cleanupProbability) {
      const cleanupBefore = new Date(
        now.getTime() - RATE_LIMIT_CONFIG.lockoutWindowMinutes * 60 * 1000
      );
      try {
        const deleteResult = await db
          .deleteFrom("loginAttempts")
          .where("attemptedAt", "<", cleanupBefore)
          .where("attemptedAt", "is not", null)
          .executeTakeFirst();
      } catch {
        // Don't fail the login if cleanup fails
      }
    }

    // Handle different transaction results
    if (result.type === "rate_limited") {
      return new Response(
        superjson.stringify({
          message: `Muitas tentativas de login sem sucesso. Conta bloqueada por mais ${result.remainingMinutes} minuto(s).`,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    if (result.type === "auth_failed") {
      return new Response(
        superjson.stringify({ message: "E-mail ou senha inválidos" }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    // Fase 90: segundo fator pendente — resposta SEM sessão e SEM dados do usuário (só o necessário para a próxima etapa).
    if (result.type === "challenge") {
      const challengeResponse = new Response(
        superjson.stringify({
          mfaRequired: true as const,
          mfaKind: result.kind,
          expiresInSeconds: Math.max(1, Math.floor((result.challenge.expiresAt.getTime() - now.getTime()) / 1000)),
        }),
        { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
      );
      setChallengeCookie(challengeResponse, result.challenge.secret, result.challenge.expiresAt, now);
      return challengeResponse;
    }

    // Success case - session was already created in transaction
    const user = result.user;

    // Create response with user data (excluding sensitive information)
    const userData: User = {
      id: user.id,
      email: user.email,
      avatarUrl: user.avatarUrl,
      displayName: user.displayName,
      role: result.platformLevel ? "admin" : "user",
      platformLevel: result.platformLevel,
    };

    const response = new Response(
      superjson.stringify({
        user: userData,
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    // Set session cookie
    await setServerSession(
      response,
      {
        id: result.sessionId,
        createdAt: result.sessionCreatedAt.getTime(),
        lastAccessed: result.sessionCreatedAt.getTime(),
      },
      { absoluteExpiresAt: result.absoluteExpiresAt }
    );

    return response;
  } catch (error) {
    // Achado real da Fase 63, corrigido na Fase 64: este catch cobria TUDO
    // que pudesse dar errado aqui — entrada inválida (JSON malformado,
    // schema.parse) e também falhas de infraestrutura genuínas (ex.:
    // PostgreSQL indisponível) — e devolvia sempre o mesmo 400 "Falha na
    // autenticação", sem nenhum log. Reproduzido de verdade (Fase 63,
    // Postgres derrubado em staging): uma falha de banco virava
    // indistinguível de "você digitou a senha errada" tanto para quem usa
    // quanto para quem for investigar um incidente depois — nenhum rastro
    // do erro real existia em lugar nenhum.
    //
    // As falhas de credencial de verdade (e-mail/senha errados, rate
    // limit) já são tratadas ACIMA, fora deste catch, com seus próprios
    // status (401/429) — este catch só é alcançado por entrada
    // malformada ou por uma exceção inesperada. Separar os dois:
    // entrada malformada (schema Zod ou JSON/superjson que nem chega a
    // parsear) é erro do cliente (400); qualquer outra coisa é inesperada.
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return new Response(
        superjson.stringify({ message: "Dados de login inválidos" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    // Erro inesperado (ex.: banco indisponível) — nunca mascarado como
    // falha de autenticação, sempre registrado no log do servidor, e a
    // mensagem pública nunca expõe detalhes internos (stack trace, SQL,
    // host do banco, credenciais).
    console.error("Erro inesperado ao processar login:", error);
    return new Response(
      superjson.stringify({ message: "Erro interno. Tente novamente em instantes." }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
}
