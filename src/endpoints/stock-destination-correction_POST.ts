import { sql } from "kysely";
import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import { auditCorrection, correctDestination, hashCorrectionInput, type CorrectionInput } from "../helpers/destinationCorrections.js";
import { schema, type OutputType } from "./stock-destination-correction_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

const json = (status: number, body: unknown) => new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Fase 99G — correção DOCUMENTAL (data efetiva, pessoas atendidas, observações) de uma destinação: evento novo em `stock_destinations`, original intacta, NENHUM movimento de estoque e
 * nenhuma mudança de atendimento. Autorização: `inventario.lance`; quem não é proprietário/administrador só corrige o que ele mesmo registrou; data retroativa (> 7 dias) exige
 * `organizacao.gerencie` e justificativa. Idempotente por chave (mesma tabela de pedidos das reversões).
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));
    const membership = await requirePermission(user.id, input.organizationId, "inventario.lance");
    const actorCanManage = roleHasPermission(membership.role, "organizacao.gerencie");

    const correctionInput: CorrectionInput = {
      organizationId: input.organizationId,
      destinationId: input.destinationId,
      deliveredOn: input.deliveredOn ?? null,
      peopleServed: input.peopleServed ?? null,
      peopleUnit: input.peopleUnit ?? null,
      notes: input.notes ?? null,
      lateRegistrationReason: input.lateRegistrationReason && input.lateRegistrationReason.length > 0 ? input.lateRegistrationReason : null,
      reason: input.reason,
    };
    const hash = hashCorrectionInput(correctionInput);

    const result = await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`destcorr:${input.organizationId}:${input.idempotencyKey}`}))`.execute(trx);
      const existing = await trx
        .selectFrom("destinationCorrectionRequests")
        .select(["payloadHash", "eventDestinationId"])
        .where("organizationId", "=", input.organizationId)
        .where("idempotencyKey", "=", input.idempotencyKey)
        .executeTakeFirst();
      if (existing) {
        if (existing.payloadHash !== hash) return { type: "key_reuse" as const };
        return { type: "replay" as const, eventId: String(existing.eventDestinationId) };
      }
      const applied = await correctDestination(trx, correctionInput, { actorUserId: user.id, actorCanManage });
      if (applied.type === "error") return applied;
      await trx
        .insertInto("destinationCorrectionRequests")
        .values({ organizationId: input.organizationId, idempotencyKey: input.idempotencyKey, payloadHash: hash, stockDestinationId: applied.target.id, eventDestinationId: applied.eventId, requestedByUserId: user.id } as never)
        .execute();
      await auditCorrection(trx, input.organizationId, user.id, applied, correctionInput, input.idempotencyKey);
      return { type: "executed" as const, applied };
    });

    switch (result.type) {
      case "error":
        return json(result.status, { message: result.message, code: result.code, ...(result.details ?? {}) });
      case "key_reuse":
        return json(409, { message: "Esta chave de idempotência já foi usada com um conteúdo diferente. Gere uma nova chave para uma nova correção.", code: "chave_reutilizada" });
      case "replay":
        return json(200, { replayed: true, correction: { id: result.eventId, changes: {} } } satisfies OutputType);
      case "executed":
        return json(200, { replayed: false, correction: { id: result.applied.eventId, changes: result.applied.changes } } satisfies OutputType);
    }
  } catch (error: unknown) {
    console.error("Erro ao corrigir destinação:", error);
    return buildErrorResponse(error, "Não foi possível corrigir a destinação");
  }
}
