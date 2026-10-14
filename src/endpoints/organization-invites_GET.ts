import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { expirePendingInvitesForOrganization } from "../helpers/organizationInvites.js";
import { schema } from "./organization-invites_GET.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ organizationId: url.searchParams.get("organizationId") });

    // Só proprietário/administrador veem convites (contêm e-mail de quem
    // ainda não é membro — não é informação para operador/voluntário). É
    // leitura: não exige organização já aprovada (quem está montando a
    // equipe antes da aprovação continua vendo os convites já enviados).
    await requirePermissionToRead(user.id, input.organizationId, "membros.gerencie");

    // Marca como expirado, na leitura, qualquer convite pendente cujo prazo
    // já passou — mesmo padrão oportunista usado na limpeza de sessões
    // (getServerUserSession), sem precisar de um cron dedicado só para isto.
    await expirePendingInvitesForOrganization(input.organizationId);

    const rows = await db
      .selectFrom("organizationInvites")
      .innerJoin("users", "users.id", "organizationInvites.invitedByUserId")
      .select([
        "organizationInvites.id",
        "organizationInvites.email",
        "organizationInvites.role",
        "organizationInvites.status",
        "users.displayName as invitedByDisplayName",
        "organizationInvites.expiresAt",
        "organizationInvites.createdAt",
        "organizationInvites.acceptedAt",
        "organizationInvites.revokedAt",
      ])
      .where("organizationInvites.organizationId", "=", input.organizationId)
      .orderBy("organizationInvites.createdAt", "desc")
      .execute();

    return new Response(
      superjson.stringify({
        invites: rows.map((r) => ({
          ...r,
          expiresAt: r.expiresAt.toString(),
          createdAt: r.createdAt.toString(),
          acceptedAt: r.acceptedAt?.toString() ?? null,
          revokedAt: r.revokedAt?.toString() ?? null,
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar convites:", error);
    return buildErrorResponse(error, "Falha ao carregar convites");
  }
}
