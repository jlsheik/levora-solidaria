import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { schema } from "./organization-members_GET.schema";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
    });

    // Só membros ativos da organização podem ver a lista de membros.
    await requireOrganizationMembership(user.id, input.organizationId);

    const rows = await db
      .selectFrom("memberships")
      .innerJoin("users", "users.id", "memberships.userId")
      .select([
        "memberships.id as membershipId",
        "users.id as userId",
        "users.displayName",
        "users.email",
        "users.avatarUrl",
        "memberships.role",
        "memberships.status",
        "memberships.createdAt",
      ])
      .where("memberships.organizationId", "=", input.organizationId)
      .orderBy("memberships.createdAt", "asc")
      .execute();

    return new Response(
      superjson.stringify({
        members: rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toString(),
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar membros:", error);
    const message = error instanceof Error ? error.message : "Falha ao carregar membros";
    const status = message.includes("acesso") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
