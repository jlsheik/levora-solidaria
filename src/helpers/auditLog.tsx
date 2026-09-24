import { db } from "./db";
import type { Transaction } from "kysely";
import type { DB, Json } from "./schema";

/**
 * Grava uma entrada na trilha de auditoria (audit_log).
 *
 * A tabela audit_log é append-only: o banco de dados possui triggers que
 * bloqueiam UPDATE e DELETE (ver docs/plano-implementacao.md). Esta função é
 * o único caminho recomendado para escrever nela — sempre dentro da mesma
 * transação da ação de negócio que está sendo registrada, para que a
 * auditoria nunca fique fora de sincronia com o que realmente aconteceu.
 */
export interface AuditLogEntryInput {
  organizationId: number | null;
  actorUserId: number | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Json;
}

export async function recordAuditLogEntry(
  entry: AuditLogEntryInput,
  trx?: Transaction<DB>
) {
  const executor = trx ?? db;
  await executor
    .insertInto("auditLog")
    .values({
      organizationId: entry.organizationId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata ?? {},
    })
    .execute();
}
