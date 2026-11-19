import type { Transaction } from "kysely";
import type { DB, IntegrityAlertLevel, Json } from "./schema.js";
import { recordAuditLogEntry } from "./auditLog.js";

/**
 * Centro de alertas de integridade (master prompt, seção 42). Um alerta é um
 * aviso para um humano olhar — nunca uma acusação nem uma correção
 * automática (seções 34, 41, 62). `detail` carrega só fatos e ids, nunca
 * dado pessoal.
 */

export interface CreateIntegrityAlertInput {
  organizationId: number | null;
  level: IntegrityAlertLevel;
  category: string;
  title: string;
  detail?: Json;
  entityType?: string | null;
  entityId?: string | null;
  /** Enquanto houver alerta aberto/reconhecido com a mesma chave, não cria outro. */
  dedupeKey?: string | null;
  /** Quem criou: agente (principal) ou sistema (nulo). */
  agentPrincipalId?: number | null;
}

export async function createIntegrityAlert(
  trx: Transaction<DB>,
  input: CreateIntegrityAlertInput
): Promise<{ created: boolean; id: string | null }> {
  const inserted = await trx
    .insertInto("integrityAlerts")
    .values({
      organizationId: input.organizationId,
      level: input.level,
      category: input.category.slice(0, 80),
      title: input.title.slice(0, 200),
      detail: input.detail ?? {},
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      createdByAgentPrincipalId: input.agentPrincipalId ?? null,
    })
    .onConflict((oc) => oc.doNothing())
    .returning("id")
    .executeTakeFirst();

  if (!inserted) return { created: false, id: null };

  await recordAuditLogEntry(
    {
      organizationId: input.organizationId,
      actorUserId: null,
      actorType: input.agentPrincipalId ? "agent" : "system",
      actorAgentPrincipalId: input.agentPrincipalId ?? null,
      action: "automacao.alerta_criado",
      outcome: "concluida",
      entityType: "integrity_alert",
      entityId: String(inserted.id),
      metadata: { nivel: input.level, categoria: input.category.slice(0, 80) },
    },
    trx
  );

  return { created: true, id: String(inserted.id) };
}
