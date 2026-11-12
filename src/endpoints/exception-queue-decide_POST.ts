import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { decideException } from "../helpers/exceptionQueue.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { schema } from "./exception-queue-decide_POST.schema.js";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "automacao.gerencie");

    const result = await db.transaction().execute((trx) =>
      decideException(trx, {
        organizationId: input.organizationId,
        exceptionId: input.exceptionId,
        userId: user.id,
        decision: input.decision,
        notes: input.notes,
      })
    );

    if (!result) {
      return new Response(superjson.stringify({ message: "Exceção não encontrada nesta organização" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(superjson.stringify({ exception: { id: input.exceptionId, ...result } }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao decidir exceção:", error);
    return buildErrorResponse(error, "Não foi possível registrar a decisão");
  }
}
