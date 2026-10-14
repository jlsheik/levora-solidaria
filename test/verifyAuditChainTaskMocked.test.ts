/**
 * Fase 53 — cobre os dois cenários que test/verifyAuditChainTask.test.ts
 * (verificador real) não consegue provar deterministicamente:
 *   1. erro de infraestrutura/aplicação DURANTE a verificação (precisa
 *      forçar uma exceção que o verificador real nunca lançaria sozinho
 *      contra um banco saudável);
 *   2. concorrência real entre duas execuções (precisa controlar o timing
 *      da verificação para garantir que a segunda chamada tenta adquirir o
 *      lock ENQUANTO a primeira ainda o detém — sem sleep, com uma
 *      promessa resolvida manualmente, mesma técnica de
 *      test/scheduledTaskLock.test.ts).
 *
 * `vi.mock` troca `verifyAuditLogChain` só neste arquivo — os outros
 * arquivos de teste da Fase 53 continuam usando o verificador real.
 */
import { describe, it, expect, vi } from "vitest";
import { db } from "../src/helpers/db";

const verifyAuditLogChain = vi.fn();
vi.mock("../src/helpers/verifyAuditChain", () => ({
  verifyAuditLogChain: (...args: unknown[]) => verifyAuditLogChain(...args),
}));

// Import depois do mock (vi.mock é hoisted pelo Vitest, então a ordem no
// arquivo não importa de verdade, mas mantém a leitura linear).
import { verifyAuditChainScheduled } from "../src/helpers/verifyAuditChainTask";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function lastBackgroundTaskRun() {
  return db
    .selectFrom("backgroundTaskRuns")
    .select(["id", "status", "result", "error"])
    .where("taskName", "=", "verifyAuditChain")
    .orderBy("createdAt", "desc")
    .limit(1)
    .executeTakeFirstOrThrow();
}

describe("verifyAuditChainScheduled — erro de infraestrutura (Fase 53)", () => {
  it("se o verificador lançar uma exceção, registra falha com kind=verification_error — NUNCA kind=integrity_invalid (são coisas diferentes)", async () => {
    verifyAuditLogChain.mockRejectedValueOnce(new Error("conexão com o Postgres perdida (simulado)"));

    await expect(verifyAuditChainScheduled()).rejects.toThrow("conexão com o Postgres perdida");

    const run = await lastBackgroundTaskRun();
    expect(run.status).toBe("falhou");
    const error = run.error as Record<string, unknown>;
    expect(error.kind).toBe("verification_error");
    expect(error.message).toContain("conexão com o Postgres perdida");
    // Nunca confundido com divergência de hash: não deve existir o campo
    // "divergencias" que só o caminho de integridade inválida preenche.
    expect(error.divergencias).toBeUndefined();
  });
});

describe("verifyAuditChainScheduled — concorrência real entre duas execuções (Fase 53)", () => {
  it("duas chamadas simultâneas: só a primeira executa o verificador; a segunda é recusada pelo advisory lock (withScheduledTaskLock) sem nunca chamar verifyAuditLogChain", async () => {
    const started = createDeferred<void>();
    const release = createDeferred<{ integra: boolean; totalEventos: number; eventosVerificados: number; eventosPreExistentesSemHash: number; divergencias: never[] }>();

    verifyAuditLogChain.mockImplementationOnce(async () => {
      started.resolve();
      return release.promise;
    });

    const firstCallPromise = verifyAuditChainScheduled();
    await started.promise; // a primeira chamada já está "dentro" do verificador, lock preso

    // Segunda chamada concorrente — deve ser recusada pelo lock ANTES de
    // sequer chamar verifyAuditLogChain de novo.
    await verifyAuditChainScheduled();
    expect(verifyAuditLogChain).toHaveBeenCalledTimes(1);

    release.resolve({ integra: true, totalEventos: 1, eventosVerificados: 1, eventosPreExistentesSemHash: 0, divergencias: [] });
    await firstCallPromise;

    expect(verifyAuditLogChain).toHaveBeenCalledTimes(1); // continua 1 — a segunda nunca chegou a chamar
  });
});
