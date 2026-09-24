import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requireOrganizationMembership } from "../helpers/organizationAccess";
import { schema } from "./approval-requests_GET.schema";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ organizationId: url.searchParams.get("organizationId") });

    await requireOrganizationMembership(user.id, input.organizationId, ["proprietario", "administrador"]);

    const rows = await db
      .selectFrom("approvalRequests")
      .innerJoin("users as requester", "requester.id", "approvalRequests.requestedByUserId")
      .leftJoin("users as decider", "decider.id", "approvalRequests.decidedByUserId")
      .select([
        "approvalRequests.id",
        "approvalRequests.actionType",
        "approvalRequests.payload",
        "approvalRequests.reason",
        "approvalRequests.status",
        "approvalRequests.requestedByUserId",
        "requester.displayName as requestedByDisplayName",
        "decider.displayName as decidedByDisplayName",
        "approvalRequests.decisionNotes",
        "approvalRequests.createdAt",
        "approvalRequests.decidedAt",
      ])
      .where("approvalRequests.organizationId", "=", input.organizationId)
      .orderBy("approvalRequests.createdAt", "desc")
      .execute();

    return new Response(
      superjson.stringify({
        requests: rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toString(),
          decidedAt: r.decidedAt ? r.decidedAt.toString() : null,
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar pedidos de aprovação:", error);
    const message = error instanceof Error ? error.message : "Falha ao carregar pedidos de aprovação";
    const status = message.includes("acesso") || message.includes("papel") ? 403 : message.toLowerCase().includes("auth") ? 401 : 400;
    return new Response(superjson.stringify({ message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
