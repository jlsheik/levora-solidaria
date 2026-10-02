import { db } from "../helpers/db.js";
import { schema } from "./organizations_POST.schema.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import superjson from "superjson";

function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    const baseSlug = slugify(input.name) || "organizacao";

    const organization = await db.transaction().execute(async (trx) => {
      // Garante slug único mesmo sob concorrência: tenta o slug base e, em
      // caso de colisão, acrescenta um sufixo numérico incremental.
      let slug = baseSlug;
      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const existing = await trx
          .selectFrom("organizations")
          .select("id")
          .where("slug", "=", slug)
          .executeTakeFirst();
        if (!existing) break;
        attempt += 1;
        slug = `${baseSlug}-${attempt + 1}`;
      }

      const [org] = await trx
        .insertInto("organizations")
        .values({
          name: input.name,
          slug,
          type: input.type,
          city: input.city,
          state: input.state,
          documentId: input.documentId || null,
          createdByUserId: user.id,
          status: "em_analise",
        })
        .returning([
          "id",
          "name",
          "slug",
          "type",
          "status",
          "city",
          "state",
          "createdAt",
        ])
        .execute();

      await trx
        .insertInto("memberships")
        .values({
          organizationId: org.id,
          userId: user.id,
          role: "proprietario",
          status: "ativo",
        })
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: org.id,
          actorUserId: user.id,
          action: "organizacao.criada",
          entityType: "organization",
          entityId: String(org.id),
          metadata: { name: org.name, type: org.type, city: org.city, state: org.state },
        },
        trx
      );

      return org;
    });

    return new Response(
      superjson.stringify({
        organization: {
          ...organization,
          createdAt: organization.createdAt.toString(),
        },
        role: "proprietario" as const,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao criar organização:", error);
    return buildErrorResponse(error, "Não foi possível criar a organização");
  }
}
