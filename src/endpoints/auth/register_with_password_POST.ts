import { sql } from "kysely";
import { schema } from "./register_with_password_POST.schema.js";
import { generatePasswordHash } from "../../helpers/generatePasswordHash.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../helpers/rateLimit.js";
import { ACCESS_CODE_UNAVAILABLE_MESSAGE, auditInvalidCodeAttempt, provisionUserWithAccessCode } from "../../helpers/registrationCodes.js";
import { ipPrefix } from "../../helpers/loginAudit.js";
import superjson from "superjson";


// Limita criação de contas em massa (bots/spam) a partir de um mesmo IP.
const IP_RATE_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 };

// Fase 51 (SEC-03): resposta pública única, nunca distinguindo "e-mail já
// cadastrado" de "conta nova criada agora" — ver docs/SECURITY.md para a
// análise completa. Escrita para ser verdadeira nos dois casos ao mesmo
// tempo, sem confirmar nenhum deles.
const REGISTRATION_RESPONSE_MESSAGE =
  "Cadastro recebido. Se este e-mail ainda não tinha conta na Levora Solidária, ela foi criada agora com a senha informada. Se já tinha, nada foi alterado — use a senha já cadastrada. Entre para continuar.";

/**
 * Cadastro público por senha — Fase 91: exige um CÓDIGO DE ACESSO válido emitido pela plataforma (provisionamento). O código é
 * validado e CONSUMIDO na mesma transação que cria a conta (provisionUserWithAccessCode): sem código válido, nenhuma conta; com
 * e-mail já existente, nada é criado e o código NÃO é consumido. A conta nasce sempre como usuário comum (nunca platform_access).
 */
export async function handle(request: Request) {
  try {
    const ip = getClientIp(request);
    const ipLimit = checkRateLimit({ bucket: "register", identifier: ip, ...IP_RATE_LIMIT });
    if (!ipLimit.allowed) {
      return rateLimitResponse(ipLimit.retryAfterSeconds, "Muitas contas criadas a partir deste dispositivo em pouco tempo. Aguarde antes de tentar de novo.");
    }

    const json = superjson.parse(await request.text());
    const { email, password, displayName, accessCode } = schema.parse(json);

    // E-mail é identidade global do usuário, sem variação por capitalização
    // — mesma convenção já usada em login_with_password_POST (LOWER(email))
    // e em organization-invites_POST (normalizedEmail = email.toLowerCase()).
    const normalizedEmail = email.toLowerCase();

    // Fase 51 (SEC-03): o hash é calculado SEMPRE, antes de saber se o e-mail já existe e antes de olhar o código, e o branch
    // de "já existe" descarta o resultado sem nunca persistir nada (o TEMPO de resposta não pode virar oráculo de enumeração).
    const passwordHash = await generatePasswordHash(password);

    const result = await provisionUserWithAccessCode(accessCode, async (trx, { codeId }) => {
      // Comparação case-insensitive (idx_users_email_lower) — só a checagem de UX antes de inserir; a barreira final contra duas
      // requisições concorrentes é o índice único no banco (a violação é tratada em provisionUserWithAccessCode, com rollback).
      const existingUser = await trx.selectFrom("users").select("id").where(sql`LOWER(email)`, "=", normalizedEmail).limit(1).execute();
      // Nunca sobrescreve nome/senha de conta existente e NÃO consome o código.
      if (existingUser.length > 0) return null;

      const [user] = await trx
        .insertInto("users")
        .values({
          email: normalizedEmail,
          displayName,
          role: "user", // sempre usuário comum — o código nunca cria platform_access nem papel de organização
          registeredViaCodeId: codeId, // UNIQUE: prova no banco que 1 código cria no máximo 1 usuário
        })
        .returning(["id"])
        .execute();

      await trx.insertInto("userPasswords").values({ userId: user.id, passwordHash }).execute();
      return user.id;
    });

    if (!result.ok && result.reason !== "email_em_uso" && result.reason !== "identidade_em_uso") {
      // Motivo exato só na auditoria (volume limitado); a resposta pública é sempre a mesma.
      await auditInvalidCodeAttempt({ reason: result.reason, ipPrefix: ipPrefix(ip) });
      return new Response(superjson.stringify({ message: ACCESS_CODE_UNAVAILABLE_MESSAGE, code: "codigo_indisponivel" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // Resposta ÚNICA para conta criada e para "e-mail já existia (nada mudou, código preservado)" — nunca cria sessão (um Set-Cookie
    // só quando a conta é criada de fato reabriria o oráculo de enumeração).
    return new Response(superjson.stringify({ message: REGISTRATION_RESPONSE_MESSAGE }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (error: unknown) {
    // Entrada malformada (Zod, corpo que nem é JSON/superjson) é erro do CLIENTE (400) e nunca depende de o e-mail já existir.
    // Falha inesperada (banco etc.) é 500 genérico, sem detalhe interno.
    if (error instanceof Error && (error.name === "ZodError" || error instanceof SyntaxError)) {
      return new Response(superjson.stringify({ message: error.name === "ZodError" ? error.message : "Corpo da requisição inválido" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("Registration error:", error instanceof Error ? error.name : "erro");
    return new Response(superjson.stringify({ message: "Não foi possível processar o cadastro" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
