// adapt this to the database schema and helpers if necessary
import { db } from "../../helpers/db.js";
import { sql } from "kysely";
import { schema } from "./register_with_password_POST.schema.js";
import { generatePasswordHash } from "../../helpers/generatePasswordHash.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../helpers/rateLimit.js";
import superjson from "superjson";

// Limita criação de contas em massa (bots/spam) a partir de um mesmo IP.
const IP_RATE_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 };

// Fase 51 (SEC-03): resposta pública única, nunca distinguindo "e-mail já
// cadastrado" de "conta nova criada agora" — ver docs/SECURITY.md para a
// análise completa (achado da auditoria de segurança da Fase 47:
// endpoint de cadastro revelava diretamente quais e-mails já tinham conta,
// via mensagem "Este e-mail já está em uso" + 409). Escrita para ser
// verdadeira nos dois casos ao mesmo tempo, sem confirmar nenhum deles.
const REGISTRATION_RESPONSE_MESSAGE =
  "Cadastro recebido. Se este e-mail ainda não tinha conta na Levora Solidária, ela foi criada agora com a senha informada. Se já tinha, nada foi alterado — use a senha já cadastrada. Entre para continuar.";

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}

export async function handle(request: Request) {
  try {
    const ip = getClientIp(request);
    const ipLimit = checkRateLimit({ bucket: "register", identifier: ip, ...IP_RATE_LIMIT });
    if (!ipLimit.allowed) {
      return rateLimitResponse(ipLimit.retryAfterSeconds, "Muitas contas criadas a partir deste dispositivo em pouco tempo. Aguarde antes de tentar de novo.");
    }

    const json = superjson.parse(await request.text());
    const { email, password, displayName } = schema.parse(json);

    // E-mail é identidade global do usuário, sem variação por capitalização
    // — mesma convenção já usada em login_with_password_POST (LOWER(email))
    // e em organization-invites_POST (normalizedEmail = email.toLowerCase()).
    const normalizedEmail = email.toLowerCase();

    // Fase 51 (SEC-03): o hash é calculado SEMPRE, antes de saber se o
    // e-mail já existe, e o branch de "já existe" descarta o resultado sem
    // nunca persistir nada — se o custo de bcrypt só fosse pago quando a
    // conta é realmente criada, o TEMPO de resposta viraria o mesmo tipo
    // de oráculo de enumeração que a mensagem distinta era antes (mesmo
    // raciocínio do dummy-hash em login_with_password_POST para SEC-04).
    const passwordHash = await generatePasswordHash(password);

    try {
      await db.transaction().execute(async (trx) => {
        // Comparação case-insensitive (idx_users_email_lower, Fase 48) —
        // só a checagem de UX antes de tentar inserir; a proteção real
        // contra duas requisições concorrentes é o índice único no banco,
        // tratado no catch abaixo.
        const existingUser = await trx
          .selectFrom("users")
          .select("id")
          .where(sql`LOWER(email)`, "=", normalizedEmail)
          .limit(1)
          .execute();

        if (existingUser.length > 0) {
          // Nada a fazer: nunca sobrescreve nome/senha de uma conta já
          // existente só porque alguém re-enviou o cadastro com esse
          // e-mail — isso seria uma forma de um terceiro alterar a conta
          // de outra pessoa, não só um problema de enumeração.
          return;
        }

        const [user] = await trx
          .insertInto("users")
          .values({
            email: normalizedEmail,
            displayName,
            role: "user", // Default role
          })
          .returning(["id"])
          .execute();

        await trx
          .insertInto("userPasswords")
          .values({
            userId: user.id,
            passwordHash,
          })
          .execute();
      });
    } catch (error: unknown) {
      // Duas requisições concorrentes podem passar ambas pela checagem
      // acima antes de qualquer uma inserir — o índice único em
      // LOWER(email) é a barreira final, e o Postgres rejeita a segunda
      // inserção com unique_violation (23505). Tratado como o mesmo "nada
      // a fazer" do branch acima — nunca um 500 genérico, e nunca um sinal
      // diferente do caminho sem concorrência.
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }

    // Resposta ÚNICA, independente de ter criado uma conta nova ou não —
    // nunca cria sessão aqui (nem no caso de conta nova): logar
    // automaticamente só quando a conta é criada de fato seria, por si só,
    // um sinal distinguível (Set-Cookie presente só às vezes), reabrindo o
    // mesmo problema que esta resposta unificada resolve.
    return new Response(
      superjson.stringify({ message: REGISTRATION_RESPONSE_MESSAGE }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error: unknown) {
    // Erros de validação (schema.parse) acontecem ANTES de qualquer
    // consulta ao banco — portanto nunca dependem de o e-mail já existir,
    // e continuar devolvendo a mensagem real aqui não reabre SEC-03.
    console.error("Registration error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Não foi possível processar o cadastro";
    return new Response(
      superjson.stringify({ message: errorMessage }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
}
