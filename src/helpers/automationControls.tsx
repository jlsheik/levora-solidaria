import type { Kysely, Transaction } from "kysely";
import type { DB } from "./schema.js";
import { recordAuditLogEntry } from "./auditLog.js";
import { newCorrelationId } from "./correlation.js";
import { ConflictError } from "./errorResponse.js";
import { fenceForChange } from "./policyFence.js";

/**
 * Pausar automação e modo emergência (master prompt, seções 91-92). Todo
 * agente consulta isto antes de agir (ver agentTools.tsx).
 *
 * - pausada: nenhuma ferramenta que MUDA dados executa; leitura e alertas continuam.
 * - emergência: só alertas (a plataforma continua avisando; nada mais roda).
 *
 * A pausa global vale para todas as organizações; a da organização vale só
 * para ela. Sem registro = não pausada. Desligar a pausa da organização não
 * "vence" uma pausa global.
 */

export interface ControlState {
  paused: boolean;
  emergency: boolean;
  reason: string | null;
}

export interface AutomationState {
  global: ControlState;
  organization: ControlState;
  /** Efetivo: qualquer um dos escopos pausado/em emergência. */
  paused: boolean;
  emergency: boolean;
}

const OFF: ControlState = { paused: false, emergency: false, reason: null };

async function readScope(executor: Kysely<DB>, organizationId: number | null): Promise<ControlState> {
  const row = await executor
    .selectFrom("automationControls")
    .select(["paused", "emergency", "reason"])
    .where("organizationId", organizationId === null ? "is" : "=", organizationId)
    .executeTakeFirst();
  return row ? { paused: row.paused, emergency: row.emergency, reason: row.reason } : OFF;
}

export async function getAutomationState(
  executor: Kysely<DB>,
  organizationId: number | null
): Promise<AutomationState> {
  const global = await readScope(executor, null);
  const organization = organizationId === null ? OFF : await readScope(executor, organizationId);
  return {
    global,
    organization,
    paused: global.paused || organization.paused || global.emergency || organization.emergency,
    emergency: global.emergency || organization.emergency,
  };
}

export async function setAutomationControl(
  trx: Transaction<DB>,
  input: { organizationId: number | null; paused: boolean; emergency: boolean; reason?: string | null; userId: number }
): Promise<ControlState> {
  // M36: cerca de política — a alteração de pausa/emergência é ordenada, pelo banco, em relação às conclusões que a leem (ver policyFence.tsx).
  await fenceForChange(trx, input.organizationId);
  if (input.emergency && !input.paused) {
    throw new ConflictError("O modo emergência também pausa a automação");
  }
  const reason = input.reason?.trim() ? input.reason.trim().slice(0, 300) : null;

  const existing = await trx
    .selectFrom("automationControls")
    .select(["id", "paused", "emergency"])
    .where("organizationId", input.organizationId === null ? "is" : "=", input.organizationId)
    .forUpdate()
    .executeTakeFirst();

  if (existing) {
    await trx
      .updateTable("automationControls")
      .set({
        paused: input.paused,
        emergency: input.emergency,
        reason,
        changedByUserId: input.userId,
        updatedAt: new Date(),
      })
      .where("id", "=", existing.id)
      .execute();
  } else {
    await trx
      .insertInto("automationControls")
      .values({
        organizationId: input.organizationId,
        paused: input.paused,
        emergency: input.emergency,
        reason,
        changedByUserId: input.userId,
      })
      .execute();
  }

  await recordAuditLogEntry(
    {
      organizationId: input.organizationId,
      actorUserId: input.userId,
      action: "automacao.controle_alterado",
      outcome: "concluida", // mesma transação da alteração
      correlationId: newCorrelationId(),
      entityType: "automation_control",
      entityId: input.organizationId === null ? "global" : String(input.organizationId),
      metadata: {
        escopo: input.organizationId === null ? "global" : "organizacao",
        pausadaAntes: existing?.paused ?? false,
        emergenciaAntes: existing?.emergency ?? false,
        pausada: input.paused,
        emergencia: input.emergency,
      },
    },
    trx
  );

  return { paused: input.paused, emergency: input.emergency, reason };
}
