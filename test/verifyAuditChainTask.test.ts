/**
 * Fase 53 — fecha SEC-06: testa a TAREFA agendada (claim/finish/fail +
 * persistência em background_task_runs), não só o verificador puro (esse
 * já é coberto por test/auditChain.test.ts). Usa o verificador REAL
 * (sem mock) contra dados forjados via INSERT direto — mesma técnica já
 * estabelecida em test/auditChain.test.ts. Para o caminho de erro de
 * infraestrutura e o teste de concorrência (que precisam controlar
 * timing/forçar exceção), ver test/verifyAuditChainTaskMocked.test.ts.
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { recordAuditLogEntry } from "../src/helpers/auditLog";
import { verifyAuditChainScheduled } from "../src/helpers/verifyAuditChainTask";
import { createAuthenticatedUser, createTestOrganization } from "./helpers";

async function lastBackgroundTaskRun() {
  return db
    .selectFrom("backgroundTaskRuns")
    .select(["id", "taskName", "status", "result", "error"])
    .where("taskName", "=", "verifyAuditChain")
    .orderBy("createdAt", "desc")
    .limit(1)
    .executeTakeFirstOrThrow();
}

describe("verifyAuditChainScheduled — tarefa agendada de verificação periódica (Fase 53)", () => {
  it("cadeia íntegra: registra sucesso (status concluida) com kind=integrity_valid e contagens", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    await recordAuditLogEntry({ organizationId: org.id, actorUserId: owner.userId, action: "teste.integro_scheduler", entityType: "teste" });

    await verifyAuditChainScheduled();

    const run = await lastBackgroundTaskRun();
    expect(run.status).toBe("concluida");
    const result = run.result as Record<string, unknown>;
    expect(result.kind).toBe("integrity_valid");
    expect(typeof result.totalEventos).toBe("number");
    expect(typeof result.duracaoMs).toBe("number");
  });

  it("cadeia corrompida: registra FALHA (status falhou) com kind=integrity_invalid e as divergências encontradas — nunca grava nada em audit_log", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    await recordAuditLogEntry({ organizationId: org.id, actorUserId: owner.userId, action: "teste.base_scheduler_invalido", entityType: "teste" });

    const last = await db.selectFrom("auditLog").select(["eventHash"]).orderBy("id", "desc").limit(1).executeTakeFirstOrThrow();
    await db
      .insertInto("auditLog")
      .values({
        organizationId: org.id,
        actorUserId: owner.userId,
        action: "teste.forjado_scheduler",
        entityType: "teste",
        entityId: "forjado-scheduler",
        metadata: {},
        previousEventHash: last.eventHash,
        eventHash: "hash-forjado-para-o-teste-do-scheduler",
      })
      .execute();

    const countBefore = await db.selectFrom("auditLog").select(db.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();

    await verifyAuditChainScheduled();

    const run = await lastBackgroundTaskRun();
    expect(run.status).toBe("falhou");
    const error = run.error as Record<string, unknown>;
    expect(error.kind).toBe("integrity_invalid");
    expect(Array.isArray(error.divergencias)).toBe(true);
    expect((error.divergencias as unknown[]).length).toBeGreaterThan(0);
    expect(typeof error.message).toBe("string");
    expect(String(error.message)).toContain("comprometida");

    // Garantia estrutural da fase: a verificação em si nunca escreve em
    // audit_log, nem para registrar a própria falha (evitaria contaminar a
    // cadeia que acabou de ser considerada possivelmente comprometida).
    const countAfter = await db.selectFrom("auditLog").select(db.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
    expect(Number(countAfter.n)).toBe(Number(countBefore.n));
  });
});
