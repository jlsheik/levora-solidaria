import { createHash } from "node:crypto";
import { sql } from "kysely";
import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import { attachProof, auditProof, removeProof } from "../helpers/destinationProofs.js";
import { schema, type OutputType } from "./stock-destination-proof_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

const json = (status: number, body: unknown) => new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Fase 99J — vínculo (evento imutável) entre uma destinação e um comprovante já enviado. Autorização: `inventario.lance`; anexar = quem registrou a destinação (e enviou o arquivo) ou
 * proprietário/administrador; remover a referência = só proprietário/administrador. Sem efeito em estoque, atendimento ou relatório de saldo. Idempotente por chave.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const input = schema.parse(superjson.parse(await request.text()));
    const membership = await requirePermission(user.id, input.organizationId, "inventario.lance");
    const actor = { userId: user.id, canManage: roleHasPermission(membership.role, "organizacao.gerencie") };
    const hash = createHash("sha256").update(JSON.stringify({ op: "proof", o: input.organizationId, d: input.destinationId, a: input.action, f: input.fileId, r: input.reason.trim() })).digest("hex");

    const result = await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`destcorr:${input.organizationId}:${input.idempotencyKey}`}))`.execute(trx);
      const existing = await trx.selectFrom("destinationCorrectionRequests").select(["payloadHash", "eventDestinationId"]).where("organizationId", "=", input.organizationId).where("idempotencyKey", "=", input.idempotencyKey).executeTakeFirst();
      if (existing) {
        if (existing.payloadHash !== hash) return { type: "key_reuse" as const };
        return { type: "replay" as const, eventId: String(existing.eventDestinationId) };
      }
      const args = { organizationId: input.organizationId, destinationId: input.destinationId, fileId: input.fileId, reason: input.reason };
      const applied = input.action === "anexar" ? await attachProof(trx, args, actor) : await removeProof(trx, args, actor);
      if (applied.type === "error") return applied;
      await trx
        .insertInto("destinationCorrectionRequests")
        .values({ organizationId: input.organizationId, idempotencyKey: input.idempotencyKey, payloadHash: hash, stockDestinationId: applied.destinationId, eventDestinationId: applied.eventId, requestedByUserId: user.id } as never)
        .execute();
      await auditProof(trx, input.organizationId, user.id, applied, input.reason, input.idempotencyKey);
      return { type: "executed" as const, applied };
    });

    switch (result.type) {
      case "error":
        return json(result.status, { message: result.message, code: result.code });
      case "key_reuse":
        return json(409, { message: "Esta chave de idempotência já foi usada com um conteúdo diferente. Gere uma nova chave.", code: "chave_reutilizada" });
      case "replay":
        return json(200, { replayed: true, event: { id: result.eventId, action: input.action === "anexar" ? "anexado" : "removido", fileId: input.fileId } } satisfies OutputType);
      case "executed":
        return json(200, { replayed: false, event: { id: result.applied.eventId, action: result.applied.action, fileId: result.applied.file.id } } satisfies OutputType);
    }
  } catch (error: unknown) {
    console.error("Erro ao atualizar comprovante da destinação:", error);
    return buildErrorResponse(error, "Não foi possível atualizar o comprovante");
  }
}
