import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { schema } from "./exception-queue_GET.schema.js";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
      status: url.searchParams.get("status") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });

    await requirePermissionToRead(user.id, input.organizationId, "automacao.leia");

    const rows = await db
      .selectFrom("exceptionQueue")
      .innerJoin("agentPrincipals", "agentPrincipals.id", "exceptionQueue.agentPrincipalId")
      .select([
        "exceptionQueue.id",
        "exceptionQueue.toolName",
        "exceptionQueue.ruleCode",
        "exceptionQueue.approvalsRequired",
        "exceptionQueue.status",
        "exceptionQueue.request",
        "exceptionQueue.createdAt",
        "exceptionQueue.consumedAt",
        "agentPrincipals.name as agentName",
      ])
      .where("exceptionQueue.organizationId", "=", input.organizationId)
      .where("exceptionQueue.status", "=", input.status)
      .orderBy("exceptionQueue.id", "desc")
      .limit(input.limit)
      .execute();

    const ids = rows.map((row) => row.id);
    const decisions = ids.length
      ? await db
          .selectFrom("exceptionDecisions")
          .innerJoin("users", "users.id", "exceptionDecisions.userId")
          .select(["exceptionDecisions.exceptionId", "exceptionDecisions.userId", "exceptionDecisions.decision", "exceptionDecisions.decidedAt", "exceptionDecisions.notes", "users.displayName"])
          .where("exceptionDecisions.exceptionId", "in", ids)
          .orderBy("exceptionDecisions.decidedAt", "asc")
          .execute()
      : [];

    // M34: a execução do motor de eventos ligada a cada exceção (quando a exceção nasceu de um evento).
    const runs = ids.length
      ? await db
          .selectFrom("agentEventRuns")
          .select(["id", "exceptionId", "eventType", "status"])
          .where("organizationId", "=", input.organizationId)
          .where("exceptionId", "in", ids)
          .execute()
      : [];

    return new Response(
      superjson.stringify({
        exceptions: rows.map((row) => {
          const run = runs.find((r) => String(r.exceptionId) === String(row.id));
          const mine = decisions.find((d) => d.exceptionId === row.id && d.userId === user.id);
          return {
            ...row,
            id: String(row.id),
            createdAt: row.createdAt.toString(),
            consumedAt: row.consumedAt?.toString() ?? null,
            run: run ? { id: String(run.id), eventType: run.eventType, status: run.status } : null,
            approvals: decisions.filter((d) => d.exceptionId === row.id && d.decision === "aprovar").length,
            myDecision: mine ? (mine.decision as "aprovar" | "rejeitar") : null,
            decisions: decisions
              .filter((d) => d.exceptionId === row.id)
              .map((d) => ({ decision: d.decision as "aprovar" | "rejeitar", decidedAt: d.decidedAt.toString(), notes: d.notes, byYou: d.userId === user.id, userDisplayName: d.displayName })),
          };
        }),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Erro ao listar fila de exceções:", error);
    return buildErrorResponse(error, "Não foi possível carregar a fila de exceções");
  }
}
