import { sql } from "kysely";
import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { auditReversal, hashReversalInput, reverseDestination, type ReversalInput } from "../helpers/destinationCorrections.js";
import { roundQuantity } from "../helpers/quantityRules.js";
import { schema, type OutputType } from "./stock-destination-reversal_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

const json = (status: number, body: unknown) => new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Fase 99G — reversão de destinação (estorno documental / devolução física / correção de quantidade). Autorização: `inventario.lance` E `organizacao.gerencie` (proprietário ou
 * administrador — a mesma matriz que a especificação chama de `destinacoes.corrija`; nenhuma permissão nova). Tudo numa ÚNICA transação: movimento compensatório (quando houver),
 * evento de reversão, pedido idempotente, reabertura da necessidade (quando o atendimento estruturado cai abaixo do solicitado) e auditoria. Ver src/helpers/destinationCorrections.tsx.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));
    await requirePermission(user.id, input.organizationId, "inventario.lance");
    await requirePermission(user.id, input.organizationId, "organizacao.gerencie");

    const reversalInput: ReversalInput = { organizationId: input.organizationId, destinationId: input.destinationId, kind: input.kind, quantity: input.quantity, reason: input.reason };
    const hash = hashReversalInput(reversalInput);

    const result = await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`destcorr:${input.organizationId}:${input.idempotencyKey}`}))`.execute(trx);
      const existing = await trx
        .selectFrom("destinationCorrectionRequests")
        .select(["payloadHash", "stockDestinationId", "eventDestinationId"])
        .where("organizationId", "=", input.organizationId)
        .where("idempotencyKey", "=", input.idempotencyKey)
        .executeTakeFirst();
      if (existing) {
        if (existing.payloadHash !== hash) return { type: "key_reuse" as const };
        const ev = await trx
          .selectFrom("stockDestinations as e")
          .leftJoin("stockTransactions as t", "t.id", "e.stockTransactionId")
          .select(["e.id", "e.reversalKind", "e.quantity", "e.unit", "e.stockTransactionId", "t.type as movementType", "t.delta as movementDelta", "e.itemId"])
          .where("e.id", "=", existing.eventDestinationId)
          .executeTakeFirstOrThrow();
        const reversed = await trx
          .selectFrom("stockDestinations")
          .select((eb) => eb.fn.coalesce(eb.fn.sum<string>("quantity"), eb.val("0")).as("t"))
          .where("entryType", "=", "reversal")
          .where("reversesDestinationId", "=", existing.stockDestinationId)
          .executeTakeFirstOrThrow();
        const orig = await trx.selectFrom("stockDestinations").select("quantity").where("id", "=", existing.stockDestinationId).executeTakeFirstOrThrow();
        const bal = await trx
          .selectFrom("stockTransactions")
          .select((eb) => eb.fn.coalesce(eb.fn.sum<string>("delta"), eb.val("0")).as("t"))
          .where("itemId", "=", ev.itemId)
          .executeTakeFirstOrThrow();
        return { type: "replay" as const, ev, reversed: Number(reversed.t), original: Number(orig.quantity), balance: Number(bal.t) };
      }

      const applied = await reverseDestination(trx, reversalInput, user.id);
      if (applied.type === "error") return applied;
      await trx
        .insertInto("destinationCorrectionRequests")
        .values({ organizationId: input.organizationId, idempotencyKey: input.idempotencyKey, payloadHash: hash, stockDestinationId: applied.target.id, eventDestinationId: applied.eventId, requestedByUserId: user.id } as never)
        .execute();
      await auditReversal(trx, input.organizationId, user.id, applied, reversalInput, input.idempotencyKey);
      return { type: "executed" as const, applied };
    });

    switch (result.type) {
      case "error":
        return json(result.status, { message: result.message, code: result.code, ...(result.details ?? {}) });
      case "key_reuse":
        return json(409, { message: "Esta chave de idempotência já foi usada com um conteúdo diferente. Gere uma nova chave para uma nova reversão.", code: "chave_reutilizada" });
      case "replay":
        return json(200, {
          replayed: true,
          reversal: {
            id: String(result.ev.id),
            kind: result.ev.reversalKind as OutputType["reversal"]["kind"],
            quantity: Number(result.ev.quantity),
            unit: result.ev.unit!,
            reversedTotal: roundQuantity(result.reversed),
            reversibleAfter: roundQuantity(result.original - result.reversed),
          },
          stockMovement: result.ev.stockTransactionId ? { id: String(result.ev.stockTransactionId), type: result.ev.movementType as "entrada" | "ajuste", delta: Number(result.ev.movementDelta) } : null,
          newStock: result.ev.stockTransactionId ? result.balance : null,
          need: null,
        } satisfies OutputType);
      case "executed": {
        const a = result.applied;
        return json(200, {
          replayed: false,
          reversal: { id: a.eventId, kind: a.kind, quantity: a.quantity, unit: a.unit, reversedTotal: a.reversedTotal, reversibleAfter: a.reversibleAfter },
          stockMovement: a.physicalMovement ? { id: a.stockTransactionId!, type: a.physicalMovement, delta: a.quantity } : null,
          newStock: a.newStock,
          need: a.need ? { id: a.need.needId, title: a.need.title, attendedBefore: a.need.attendedBefore, attendedAfter: a.need.attendedAfter, requested: a.need.requested, remainingAfter: a.need.remainingAfter, reopened: a.need.reopened } : null,
        } satisfies OutputType);
      }
    }
  } catch (error: unknown) {
    console.error("Erro ao reverter destinação:", error);
    return buildErrorResponse(error, "Não foi possível reverter a destinação");
  }
}
