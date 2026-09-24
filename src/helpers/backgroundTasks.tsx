import { db } from "./db";
import type { Json } from "./schema";

/**
 * Contabilidade real de execução de tarefas de fundo — histórico,
 * idempotência e reprocessamento manual, por cima do `@floot/queueTask`
 * (que cuida do disparo em si). Todo handler de tarefa deve:
 *   1. chamar `claimTaskRun` no início;
 *   2. se `claimed: false`, retornar sem fazer nada (idempotência: já
 *      existe uma execução com essa chave, em andamento ou concluída);
 *   3. rodar o trabalho real;
 *   4. chamar `finishTaskRun` ou `failTaskRun` no final.
 */

export interface ClaimResult {
  claimed: boolean;
  runId: string;
}

export async function claimTaskRun(params: {
  taskName: string;
  idempotencyKey?: string;
  payload?: Json;
  triggeredByUserId?: number | null;
  maxAttempts?: number;
}): Promise<ClaimResult> {
  return db.transaction().execute(async (trx) => {
    if (params.idempotencyKey) {
      const existing = await trx
        .selectFrom("backgroundTaskRuns")
        .select(["id", "status", "attemptCount", "maxAttempts"])
        .where("idempotencyKey", "=", params.idempotencyKey)
        .executeTakeFirst();

      if (existing) {
        // Já existe execução com esta chave: só reprocessa se a anterior
        // falhou e ainda há tentativas disponíveis. Caso contrário, é
        // idempotência de verdade — não roda de novo.
        if (existing.status === "falhou" && existing.attemptCount < existing.maxAttempts) {
          await trx
            .updateTable("backgroundTaskRuns")
            .set({ status: "executando", startedAt: new Date(), attemptCount: existing.attemptCount + 1, updatedAt: new Date() })
            .where("id", "=", existing.id)
            .execute();
          return { claimed: true, runId: existing.id };
        }
        return { claimed: false, runId: existing.id };
      }
    }

    const [run] = await trx
      .insertInto("backgroundTaskRuns")
      .values({
        taskName: params.taskName,
        idempotencyKey: params.idempotencyKey ?? null,
        status: "executando",
        payload: params.payload ?? {},
        attemptCount: 1,
        maxAttempts: params.maxAttempts ?? 3,
        startedAt: new Date(),
        triggeredByUserId: params.triggeredByUserId ?? null,
      })
      .returning(["id"])
      .execute();

    return { claimed: true, runId: run.id };
  });
}

export async function finishTaskRun(runId: string, result: Json = {}): Promise<void> {
  await db
    .updateTable("backgroundTaskRuns")
    .set({ status: "concluida", finishedAt: new Date(), result, updatedAt: new Date() })
    .where("id", "=", runId)
    .execute();
}

export async function failTaskRun(runId: string, error: unknown): Promise<void> {
  const errorJson: Json = {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack ?? null : null,
  };
  await db
    .updateTable("backgroundTaskRuns")
    .set({ status: "falhou", finishedAt: new Date(), error: errorJson, updatedAt: new Date() })
    .where("id", "=", runId)
    .execute();
}
