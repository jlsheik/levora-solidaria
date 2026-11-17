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
  reason: "hash_nao_bate" | "previous_hash_nao_bate_com_evento_anterior" | "versao_inconsistente" | "versao_nao_suportada" | "hash_ausente_apos_inicio_da_cadeia";
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

/**
 * `options.maxId` (M38): limita a verificação aos eventos com id <= maxId, lido no início da verificação — a abrangência fica definida e os eventos
 * gravados durante a leitura não entram no resultado. Sem a opção, o comportamento é o de sempre (cadeia inteira). O ALGORITMO é o mesmo.
 */
export async function verifyAuditLogChain(options: { maxId?: string } = {}): Promise<AuditChainVerificationResult> {
  let query = db
    .selectFrom("auditLog")
    .select(["id", "organizationId", "actorUserId", "actorType", "actorAgentPrincipalId", "action", "entityType", "entityId", "metadata", "createdAt", "previousEventHash", "eventHash", "recordVersion", "outcome", "correlationId"])
    .orderBy("id", "asc");
  if (options.maxId !== undefined) query = query.where("id", "<=", options.maxId);
  const rows = await query.execute();

  const divergencias: AuditChainMismatch[] = [];
  let lastKnownHash: string | null = null;
  let eventosPreExistentesSemHash = 0;
  let eventosVerificados = 0;
  let cadeiaIniciada = false; // já apareceu algum evento com hash?

  for (const row of rows) {
    if (row.eventHash === null) {
      // Evento de antes da migração 0003 — não verificável, e não conta
      // como quebra de cadeia. A cadeia "recomeça" a partir do próximo
      // evento com hash.
      eventosPreExistentesSemHash += 1;
      // M39: um evento SEM hash só é "anterior ao encadeamento" se aparecer ANTES do primeiro evento com hash. Depois que a cadeia começou, todo evento legítimo tem hash
      // (recordAuditLogEntry sempre o calcula); uma linha sem hash ali é inserção fora do caminho recomendado (ou remoção do hash) e NÃO pode passar como histórico.
      if (cadeiaIniciada) divergencias.push({ id: String(row.id), reason: "hash_ausente_apos_inicio_da_cadeia", storedEventHash: null });
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

    // M39: versão do formato do registro. v1 = histórico (hash sem outcome/correlação); v2 = hash cobre ambos. Versão desconhecida, ou colunas incompatíveis com a versão, NUNCA são silenciadas.
    if (row.recordVersion !== 1 && row.recordVersion !== 2) {
      divergencias.push({ id: String(row.id), reason: "versao_nao_suportada", storedEventHash: row.eventHash });
      eventosVerificados += 1; cadeiaIniciada = true; lastKnownHash = row.eventHash; continue;
    }
    const hasNew = row.outcome !== null || row.correlationId !== null;
    if ((row.recordVersion === 1 && hasNew) || (row.recordVersion === 2 && !hasNew)) {
      divergencias.push({ id: String(row.id), reason: "versao_inconsistente", storedEventHash: row.eventHash });
    }
    const expected = computeAuditEventHash({
      recordVersion: row.recordVersion,
      outcome: row.recordVersion === 2 ? row.outcome : null,
      correlationId: row.recordVersion === 2 ? row.correlationId : null,
      organizationId: row.organizationId,
      actorUserId: row.actorUserId,
      actorType: row.actorType,
      actorAgentPrincipalId: row.actorAgentPrincipalId,
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
    cadeiaIniciada = true;
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
