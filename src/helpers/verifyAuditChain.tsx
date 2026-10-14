import { db } from "./db.js";
import { computeAuditEventHash } from "./auditLog.js";
import type { Json } from "./schema.js";

/**
 * Percorre audit_log inteira (ordem de id) e recalcula cada event_hash a
 * partir dos campos gravados + previous_event_hash, comparando com o que
 * está salvo. Sem esta rotina, ter as colunas de hash não prova nada — é
 * ela que dá a "evidência de adulteração" que o master prompt (seção 12)
 * pede. Ver docs/AUDIT.md.
 *
 * Linhas anteriores à migração 0003 (event_hash NULL) são tratadas como o
 * início de uma nova cadeia a partir dali, não como corrupção — não há
 * como calcular retroativamente o hash de um evento que não previa isso.
 */
export interface AuditChainMismatch {
  id: string;
  reason: "hash_nao_bate" | "previous_hash_nao_bate_com_evento_anterior";
  expectedEventHash?: string;
  storedEventHash: string | null;
}

export interface AuditChainVerificationResult {
  totalEventos: number;
  eventosVerificados: number;
  eventosPreExistentesSemHash: number;
  integra: boolean;
  divergencias: AuditChainMismatch[];
}

export async function verifyAuditLogChain(): Promise<AuditChainVerificationResult> {
  const rows = await db
    .selectFrom("auditLog")
    .select(["id", "organizationId", "actorUserId", "action", "entityType", "entityId", "metadata", "createdAt", "previousEventHash", "eventHash"])
    .orderBy("id", "asc")
    .execute();

  const divergencias: AuditChainMismatch[] = [];
  let lastKnownHash: string | null = null;
  let eventosPreExistentesSemHash = 0;
  let eventosVerificados = 0;

  for (const row of rows) {
    if (row.eventHash === null) {
      // Evento de antes da migração 0003 — não verificável, e não conta
      // como quebra de cadeia. A cadeia "recomeça" a partir do próximo
      // evento com hash.
      eventosPreExistentesSemHash += 1;
      lastKnownHash = null;
      continue;
    }

    if (row.previousEventHash !== lastKnownHash) {
      divergencias.push({
        id: String(row.id),
        reason: "previous_hash_nao_bate_com_evento_anterior",
        storedEventHash: row.eventHash,
      });
    }

    const expected = computeAuditEventHash({
      organizationId: row.organizationId,
      actorUserId: row.actorUserId,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      metadata: row.metadata as Json,
      createdAt: row.createdAt,
      previousEventHash: row.previousEventHash,
    });

    if (expected !== row.eventHash) {
      divergencias.push({
        id: String(row.id),
        reason: "hash_nao_bate",
        expectedEventHash: expected,
        storedEventHash: row.eventHash,
      });
    }

    eventosVerificados += 1;
    lastKnownHash = row.eventHash;
  }

  return {
    totalEventos: rows.length,
    eventosVerificados,
    eventosPreExistentesSemHash,
    integra: divergencias.length === 0,
    divergencias,
  };
}
