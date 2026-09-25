import { db } from "../helpers/db";
import { hashInviteToken } from "../helpers/organizationInvites";
import { schema } from "./organization-invites-lookup_GET.schema";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../helpers/rateLimit";
import superjson from "superjson";

// Endpoint público, sem sessão: é a maior superfície de força bruta de
// token deste sistema (qualquer um pode chamar com qualquer token, sem
// estar logado). Limite generoso o bastante para o fluxo normal (uma
// consulta por acesso ao link) mas baixo o bastante para travar varredura
// de tokens.
const IP_RATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };

// Endpoint público (sem sessão) — quem recebeu o link do convite ainda pode
// não ter conta na Levora Solidária. Só revela o mínimo necessário para
// montar a tela de aceite (nome da organização, e-mail e papel), nunca
// dados internos da organização.
export async function handle(request: Request) {
  try {
    const ip = getClientIp(request);
    const ipLimit = checkRateLimit({ bucket: "organization-invites-lookup", identifier: ip, ...IP_RATE_LIMIT });
    if (!ipLimit.allowed) {
      return rateLimitResponse(ipLimit.retryAfterSeconds);
    }

    const url = new URL(request.url);
    const input = schema.parse({ token: url.searchParams.get("token") });
    const tokenHash = hashInviteToken(input.token);

    const invite = await db
      .selectFrom("organizationInvites")
      .innerJoin("organizations", "organizations.id", "organizationInvites.organizationId")
      .select([
        "organizationInvites.id",
        "organizationInvites.status",
        "organizationInvites.email",
        "organizationInvites.role",
        "organizationInvites.expiresAt",
        "organizations.name as organizationName",
      ])
      .where("organizationInvites.tokenHash", "=", tokenHash)
      .executeTakeFirst();

    if (!invite) {
      return new Response(superjson.stringify({ valid: false, reason: "nao_encontrado" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (invite.status === "revogado") {
      return new Response(superjson.stringify({ valid: false, reason: "revogado" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (invite.status === "aceito") {
      return new Response(superjson.stringify({ valid: false, reason: "ja_usado" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (invite.status === "expirado" || invite.expiresAt.getTime() < Date.now()) {
      return new Response(superjson.stringify({ valid: false, reason: "expirado" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      superjson.stringify({
        valid: true,
        organizationName: invite.organizationName,
        email: invite.email,
        role: invite.role,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao consultar convite:", error);
    return new Response(superjson.stringify({ valid: false }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}
