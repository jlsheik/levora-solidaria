import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { createReceipt } from "../helpers/auditChainReceipt.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { newCorrelationId } from "../helpers/correlation.js";
import { db } from "../helpers/db.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { schema, type OutputType } from "./audit-chain-receipt_POST.schema.js";
import superjson from "superjson";

/**
 * M39 — gera o comprovante LOCAL do estado da cadeia a partir da última verificação ÍNTEGRA. Equipe da plataforma (a cadeia é global). Não altera nenhum registro da trilha.
 * A geração é auditada (`auditoria.comprovante_gerado`, resultado `concluida`) numa transação própria, DEPOIS de o comprovante existir: o registro nunca antecede o fato.
 * O arquivo exportado NÃO é âncora independente: vale como referência só se guardado fora do alcance de quem controla o banco.
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);
    const text = await request.text();
    schema.parse(text ? superjson.parse(text) : {});
    const stored = await createReceipt(user.id);
    await db.transaction().execute((trx) => recordAuditLogEntry({ organizationId: null, actorUserId: user.id, action: "auditoria.comprovante_gerado", outcome: "concluida", correlationId: newCorrelationId(), entityType: "audit_chain_receipt", entityId: stored.id, metadata: { escopo: "global_chain", ultimoRegistro: stored.receipt.lastEventId } }, trx));
    const r = stored.receipt;
    const out: OutputType = { id: stored.id, canonical: stored.canonical, receipt: { format: r.format, formatVersion: r.formatVersion, scope: r.scope, algorithm: r.algorithm, capturedAt: r.capturedAt, verificationId: r.verificationId, lastEventId: r.lastEventId, eventCount: r.eventCount, headHash: r.headHash, unhashedEvents: r.unhashedEvents, verificationResult: r.verificationResult, receiptDigest: r.receiptDigest } };
    return new Response(superjson.stringify(out), { status: 201, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    console.error("Erro ao gerar o comprovante:", error);
    return buildErrorResponse(error, "Não foi possível gerar o comprovante");
  }
}
