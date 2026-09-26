/**
 * Prova comportamental do achado de auditoria "claimTaskRun não impede
 * execução concorrente das tarefas agendadas" (docs/OPERATIONS.md,
 * "Idempotência de background_task_runs"). `withScheduledTaskLock` é a
 * camada adicional (advisory lock de sessão do Postgres) por cima de
 * `claimTaskRun`, que continua com sua semântica original — ver
 * test/idempotency.test.ts para a cobertura de `claimTaskRun` em si.
 *
 * Nenhum teste aqui usa `setTimeout`/sleep real: o controle de timing é
 * feito com promessas resolvidas manualmente ("deferred"), para provar a
 * exclusão mútua de forma determinística, incluindo o caso de uma
 * execução mais longa que o intervalo nominal do cron (teste E).
 */
import { describe, it, expect } from "vitest";
import { withScheduledTaskLock } from "../src/helpers/scheduledTaskLock";

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("withScheduledTaskLock — exclusão mútua real via advisory lock", () => {
  it("teste A: duas chamadas concorrentes da MESMA tarefa — uma adquire, a outra é recusada pelo lock", async () => {
    const started = createDeferred<void>();
    const release = createDeferred<string>();

    const call1Promise = withScheduledTaskLock("expireReservations", async () => {
      started.resolve();
      return release.promise;
    });

    await started.promise; // call1 já detém o lock e está "executando"

    const call2 = await withScheduledTaskLock("expireReservations", async () => "nao deveria rodar");
    expect(call2.ran).toBe(false);
    expect(call2.result).toBeUndefined();

    release.resolve("call1-resultado");
    const call1 = await call1Promise;
    expect(call1.ran).toBe(true);
    expect(call1.result).toBe("call1-resultado");
  });

  it("teste B: depois que a primeira execução libera o lock, uma execução posterior adquire normalmente", async () => {
    const first = await withScheduledTaskLock("expireOpportunities", async () => "primeira");
    expect(first.ran).toBe(true);

    // Lock já foi liberado (fora do escopo de withScheduledTaskLock) — uma
    // "próxima execução" (outro tick do cron, ou reprocessamento manual)
    // deve conseguir adquirir sem qualquer resquício da anterior.
    const second = await withScheduledTaskLock("expireOpportunities", async () => "segunda");
    expect(second.ran).toBe(true);
    expect(second.result).toBe("segunda");
  });

  it("teste C: se a execução lança exceção, o lock é liberado mesmo assim (próxima chamada consegue adquirir)", async () => {
    await expect(
      withScheduledTaskLock("expireApprovalRequests", async () => {
        throw new Error("falha simulada dentro da tarefa");
      })
    ).rejects.toThrow("falha simulada dentro da tarefa");

    // Se o lock tivesse ficado presa, esta segunda chamada ficaria travada
    // (ran:false) para sempre — confirma que o `finally` do helper soltou o
    // lock antes da exceção se propagar.
    const after = await withScheduledTaskLock("expireApprovalRequests", async () => "ok apos falha");
    expect(after.ran).toBe(true);
    expect(after.result).toBe("ok apos falha");
  });

  it("teste D: uma tarefa diferente NÃO é bloqueada pelo lock de outra tarefa em andamento", async () => {
    const started = createDeferred<void>();
    const release = createDeferred<void>();

    const runningTaskPromise = withScheduledTaskLock("expireReservations", async () => {
      started.resolve();
      await release.promise;
      return "tarefa-A";
    });

    await started.promise; // "expireReservations" está com o lock preso

    // "runMatchingSweep" é uma tarefa DIFERENTE — objid diferente no mesmo
    // classid — não deve ser afetada pelo lock de "expireReservations".
    const otherTask = await withScheduledTaskLock("runMatchingSweep", async () => "tarefa-B");
    expect(otherTask.ran).toBe(true);
    expect(otherTask.result).toBe("tarefa-B");

    release.resolve();
    const runningTask = await runningTaskPromise;
    expect(runningTask.ran).toBe(true);
    expect(runningTask.result).toBe("tarefa-A");
  });

  it("teste E: uma execução que atravessa (conceitualmente) o intervalo nominal do cron continua protegida enquanto o lock estiver preso — nao depende de janela/tick", async () => {
    const started = createDeferred<void>();
    const release = createDeferred<void>();

    const longRunningPromise = withScheduledTaskLock("runMatchingSweep", async () => {
      started.resolve();
      await release.promise; // fica "executando" indefinidamente até liberarmos
      return "tarefa-longa-concluida";
    });

    await started.promise;

    // Várias tentativas concorrentes "chegando depois", simulando múltiplos
    // ticks do cron que teriam disparado enquanto a tarefa longa ainda roda
    // — nenhuma delas consegue o lock, por mais que "o tempo passe"
    // (aqui, nenhum tempo real passa — é exatamente o ponto: a proteção não
    // depende de uma janela de tempo, só de o lock estar preso ou não).
    const laterAttempts = await Promise.all([
      withScheduledTaskLock("runMatchingSweep", async () => "nao deveria rodar 1"),
      withScheduledTaskLock("runMatchingSweep", async () => "nao deveria rodar 2"),
    ]);
    for (const attempt of laterAttempts) expect(attempt.ran).toBe(false);

    release.resolve();
    const longRunning = await longRunningPromise;
    expect(longRunning.ran).toBe(true);
    expect(longRunning.result).toBe("tarefa-longa-concluida");

    // Só depois de liberado, uma nova tentativa finalmente adquire.
    const afterRelease = await withScheduledTaskLock("runMatchingSweep", async () => "agora sim");
    expect(afterRelease.ran).toBe(true);
  });

  it("taskName sem lock id mapeado lança erro explícito (nunca roda a tarefa silenciosamente sem proteção)", async () => {
    await expect(withScheduledTaskLock("tarefaInexistente", async () => "nunca deveria rodar")).rejects.toThrow(/não tem lock id mapeado/);
  });
});
