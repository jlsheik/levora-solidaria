import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/helpers/db";
import { expireApprovalRequests } from "../src/helpers/expireApprovalRequests";
import { createAuthenticatedUser, createTestOrganization, type AuthenticatedTestUser } from "./helpers";

async function createApprovalRequest(organizationId: number, userId: number, createdAt: Date) {
  const [row] = await db
    .insertInto("approvalRequests")
    .values({
      actionType: "ajuste_estoque_alto_risco",
      organizationId,
      payload: { organizationId, itemId: 1, type: "ajuste", quantity: -50 },
      reason: "Teste",
      requestedByUserId: userId,
      createdAt,
    })
    .returning(["id"])
    .execute();
  return row.id;
}

describe("expireApprovalRequests (tarefa agendada)", () => {
  let owner: AuthenticatedTestUser;
  let orgId: number;

  beforeEach(async () => {
    owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    orgId = org.id;
  });

  it("expira pedido pendente criado há mais de 7 dias", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const requestId = await createApprovalRequest(orgId, owner.userId, eightDaysAgo);

    await expireApprovalRequests();

    const row = await db.selectFrom("approvalRequests").select(["status", "decisionNotes"]).where("id", "=", requestId).executeTakeFirstOrThrow();
    expect(row.status).toBe("expirada");
    expect(row.decisionNotes).toContain("Expirado automaticamente");

    const auditEntry = await db
      .selectFrom("auditLog")
      .select(["action"])
      .where("entityType", "=", "approval_request")
      .where("entityId", "=", String(requestId))
      .executeTakeFirst();
    expect(auditEntry?.action).toBe("aprovacao.expirada");
  });

  it("não expira pedido pendente ainda dentro do prazo", async () => {
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const requestId = await createApprovalRequest(orgId, owner.userId, oneDayAgo);

    await expireApprovalRequests();

    const row = await db.selectFrom("approvalRequests").select(["status"]).where("id", "=", requestId).executeTakeFirstOrThrow();
    expect(row.status).toBe("pendente");
  });

  it("não mexe em pedido já decidido (aprovado ou rejeitado), mesmo antigo", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const requestId = await createApprovalRequest(orgId, owner.userId, eightDaysAgo);
    await db.updateTable("approvalRequests").set({ status: "aprovada", decidedAt: new Date() }).where("id", "=", requestId).execute();

    await expireApprovalRequests();

    const row = await db.selectFrom("approvalRequests").select(["status"]).where("id", "=", requestId).executeTakeFirstOrThrow();
    expect(row.status).toBe("aprovada");
  });

  it("é idempotente: rodar duas vezes seguidas não gera auditoria duplicada", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const requestId = await createApprovalRequest(orgId, owner.userId, eightDaysAgo);

    await expireApprovalRequests();
    await expireApprovalRequests();

    const auditEntries = await db
      .selectFrom("auditLog")
      .select(["id"])
      .where("entityType", "=", "approval_request")
      .where("entityId", "=", String(requestId))
      .execute();
    expect(auditEntries).toHaveLength(1);
  });
});
