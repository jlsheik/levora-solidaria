// adapt this to your database schema
import { db } from "../../helpers/db.js";
import { sql } from "kysely";
import { z } from "zod";
import { schema } from "./login_with_password_POST.schema.js";
import { compare } from "bcryptjs";
import { randomBytes } from "crypto";
import {
  setServerSession,
  SessionExpirationSeconds,
} from "../../helpers/getSetServerSession.js";
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

      // Get rate limiting info efficiently - use COUNT and MAX instead of SELECT *
      const rateLimitQuery = await trx
        .selectFrom("loginAttempts")
        .select([
          trx.fn.countAll<number>().as("failedCount"),
          trx.fn.max(trx.dynamic.ref("attemptedAt")).as("lastFailedAt"),
        ])
        .where("email", "=", normalizedEmail)
        .where("success", "=", false)
        .where("attemptedAt", ">=", windowStart)
        .where("attemptedAt", "is not", null) // Ensure null safety
        .executeTakeFirst();

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
          "users.role",
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
          })
          .execute();

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
          })
          .execute();

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
        })
        .execute();

      // Create session inside the same transaction to ensure atomicity
      const sessionId = randomBytes(32).toString("hex");
      const expiresAt = new Date(
        now.getTime() + SessionExpirationSeconds * 1000
      );

      await trx
        .insertInto("sessions")
        .values({
          id: sessionId,
          userId: user.id,
          createdAt: now,
          lastAccessed: now,
          expiresAt: expiresAt,
        })
        .execute();

      // Reset failed attempts counter by deleting previous failed attempts
      // This preserves audit trail of successful logins
      await trx
        .deleteFrom("loginAttempts")
        .where("email", "=", normalizedEmail)
        .where("success", "=", false)
        .execute();

      return {
        type: "success" as const,
        user,
        sessionId,
        sessionCreatedAt: now,
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

    // Success case - session was already created in transaction
    const user = result.user;

    // Create response with user data (excluding sensitive information)
    const userData: User = {
      id: user.id,
      email: user.email,
      avatarUrl: user.avatarUrl,
      displayName: user.displayName,
      role: user.role,
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
    await setServerSession(response, {
      id: result.sessionId,
      createdAt: result.sessionCreatedAt.getTime(),
      lastAccessed: result.sessionCreatedAt.getTime(),
    });

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
