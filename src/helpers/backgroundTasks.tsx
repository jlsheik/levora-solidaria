import { db } from "./db.js";
import type { Json } from "./schema.js";

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

// SQLSTATE de "unique_violation" no Postgres — usado para reconhecer a
// corrida abaixo independentemente da mensagem de erro (que pode variar).
const POSTGRES_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === POSTGRES_UNIQUE_VIOLATION;
}

export async function claimTaskRun(params: {
  taskName: string;
  idempotencyKey?: string;
  payload?: Json;
  triggeredByUserId?: number | null;
  maxAttempts?: number;
}): Promise<ClaimResult> {
  try {
    return await db.transaction().execute(async (trx) => {
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
  } catch (error) {
    // Corrida real sob concorrência: duas chamadas com a MESMA
    // idempotencyKey podem ambas fazer o SELECT acima e verem "não existe"
    // antes de qualquer uma inserir (READ COMMITTED não impede isso). A
    // constraint UNIQUE em background_task_runs.idempotency_key garante que
    // só uma linha é criada, mas sem este catch a chamada perdedora da
    // corrida recebia uma exceção de violação de unicidade não tratada, em
    // vez do mesmo `claimed: false` que o ramo "já existe" acima devolve
    // quando a corrida não acontece. Trata os dois casos como idênticos
    // para quem chama.
    if (params.idempotencyKey && isUniqueViolation(error)) {
      const existing = await db
        .selectFrom("backgroundTaskRuns")
        .select(["id"])
        .where("idempotencyKey", "=", params.idempotencyKey)
        .executeTakeFirstOrThrow();
      return { claimed: false, runId: existing.id };
    }
    throw error;
  }
}

export async function finishTaskRun(runId: string, result: Json = {}): Promise<void> {
  await db
    .updateTable("backgroundTaskRuns")
    .set({ status: "concluida", finishedAt: new Date(), result, updatedAt: new Date() })
    .where("id", "=", runId)
    .execute();
}

export async function failTaskRun(runId: string, error: unknown, extra?: Record<string, Json>): Promise<void> {
  // `extra` (Fase 53): campos estruturados adicionais mesclados no JSON de
  // erro — usado por verifyAuditChainTask.tsx para anexar as divergências
  // encontradas (id/motivo), sem forçar quem só tem um Error genérico a
  // passar nada. Opcional e aditivo: nenhum chamador existente (as 4
  // tarefas agendadas originais) precisa mudar.
  const errorJson: Json = {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack ?? null : null,
    ...(extra ?? {}),
  };
  await db
    .updateTable("backgroundTaskRuns")
    .set({ status: "falhou", finishedAt: new Date(), error: errorJson, updatedAt: new Date() })
    .where("id", "=", runId)
    .execute();
}
