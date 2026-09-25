import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { buildErrorResponse } from "../helpers/errorResponse";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);

    // Isolamento entre organizações: a consulta parte SEMPRE de memberships
    // do usuário autenticado — nunca é possível listar uma organização da
    // qual o usuário não é membro ativo.
    const rows = await db
      .selectFrom("memberships")
      .innerJoin("organizations", "organizations.id", "memberships.organizationId")
      .select([
        "organizations.id",
        "organizations.name",
        "organizations.slug",
        "organizations.type",
        "organizations.status",
        "organizations.city",
        "organizations.state",
        "organizations.createdAt",
        "memberships.role as myRole",
        (eb) =>
          eb
            .selectFrom("memberships as m2")
            .select((eb2) => eb2.fn.countAll().as("count"))
            .whereRef("m2.organizationId", "=", "organizations.id")
            .where("m2.status", "=", "ativo")
            .as("memberCount"),
      ])
      .where("memberships.userId", "=", user.id)
      .where("memberships.status", "=", "ativo")
      .orderBy("organizations.createdAt", "desc")
      .execute();

    return new Response(
      superjson.stringify({
        organizations: rows.map((r) => ({
          id: r.id,
          name: r.name,
          slug: r.slug,
          type: r.type,
          status: r.status,
          city: r.city,
          state: r.state,
          createdAt: r.createdAt.toString(),
          myRole: r.myRole,
          memberCount: Number(r.memberCount ?? 0),
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar organizações:", error);
    return buildErrorResponse(error, "Falha ao carregar organizações");
  }
}
