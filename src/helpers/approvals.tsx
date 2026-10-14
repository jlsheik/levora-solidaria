import { db } from "./db.js";
import type { Transaction } from "kysely";
import type { DB, Json } from "./schema.js";

/**
 * Dupla autorização genérica: uma ação de alto risco não executa na hora —
 * fica pendente aqui até uma SEGUNDA pessoa (nunca quem pediu) decidir.
 * `payload` guarda tudo que é preciso para executar a ação real quando
 * aprovada; quem aprova reexecuta a lógica de negócio de verdade, não só
 * muda um status.
 */
export async function createApprovalRequest(
  params: {
    actionType: string;
    organizationId: number | null;
    payload: Json;
    reason: string;
    requestedByUserId: number;
  },
  trx?: Transaction<DB>
): Promise<{ id: number }> {
  const executor = trx ?? db;
  const [row] = await executor
    .insertInto("approvalRequests")
    .values({
      actionType: params.actionType,
      organizationId: params.organizationId,
      payload: params.payload,
      reason: params.reason,
      requestedByUserId: params.requestedByUserId,
    })
    .returning(["id"])
    .execute();
  return row;
}
