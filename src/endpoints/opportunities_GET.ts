import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { schema } from "./opportunities_GET.schema";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
    });

    await requireOrganizationMembership(user.id, input.organizationId);

    const rows = await db
      .selectFrom("donationOpportunities")
      .innerJoin("users", "users.id", "donationOpportunities.createdByUserId")
      .leftJoin("needs", "needs.id", "donationOpportunities.linkedNeedId")
      .select([
        "donationOpportunities.id",
        "donationOpportunities.title",
        "donationOpportunities.description",
        "donationOpportunities.category",
        "donationOpportunities.quantityOffered",
        "donationOpportunities.unit",
        "donationOpportunities.donorName",
        "donationOpportunities.donorContact",
        "donationOpportunities.linkedNeedId",
        "needs.title as linkedNeedTitle",
        "donationOpportunities.status",
        "users.displayName as createdByDisplayName",
        "donationOpportunities.createdAt",
      ])
      .where("donationOpportunities.organizationId", "=", input.organizationId)
      .orderBy("donationOpportunities.createdAt", "desc")
      .execute();

    return new Response(
      superjson.stringify({
        opportunities: rows.map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          category: r.category,
          quantityOffered: r.quantityOffered !== null ? Number(r.quantityOffered) : null,
          unit: r.unit,
          donorName: r.donorName,
          donorContact: r.donorContact,
          linkedNeedId: r.linkedNeedId,
          linkedNeedTitle: r.linkedNeedTitle,
          status: r.status,
          createdByDisplayName: r.createdByDisplayName,
          createdAt: r.createdAt.toString(),
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar oportunidades:", error);
    const message = error instanceof Error ? error.message : "Falha ao carregar oportunidades";
    const status = message.includes("acesso") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
