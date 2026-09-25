import { db } from "../helpers/db";
import { getServerUserSession } from "../helpers/getServerUserSession";
import { requirePermissionToRead } from "../helpers/organizationAccess";
import { schema } from "./approval-requests_GET.schema";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({ organizationId: url.searchParams.get("organizationId") });

    // É leitura: não exige organização já aprovada.
    await requirePermissionToRead(user.id, input.organizationId, "aprovacoes.leia");

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
    return buildErrorResponse(error, "Falha ao carregar pedidos de aprovação");
  }
}
