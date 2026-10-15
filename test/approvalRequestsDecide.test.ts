import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { handle as postStockTransaction } from "../src/endpoints/stock-transactions_POST";
import { handle as postApprovalDecide } from "../src/endpoints/approval-requests-decide_POST";
import { createAuthenticatedUser, createTestOrganization, addMembership, createTestInventoryItem, buildRequest, parseJson, type AuthenticatedTestUser , consumeStockForTest } from "./helpers";

describe("POST /approval-requests-decide", () => {
  async function setupHighRiskRequest(orgId: number, requester: AuthenticatedTestUser, itemId: number) {
    // entrada inicial de 100, depois um ajuste de -30 (>=20 absoluto e
    // >=30% do saldo) dispara dupla autorização.
    await postStockTransaction(
      buildRequest("stock-transactions", { method: "POST", cookie: requester.cookie, body: { organizationId: orgId, itemId, type: "entrada", quantity: 100, reason: "Entrada inicial" } })
    );
    const response = await postStockTransaction(
      buildRequest("stock-transactions", { method: "POST", cookie: requester.cookie, body: { organizationId: orgId, itemId, type: "ajuste", quantity: -30, reason: "Divergência na conferência" } })
    );
    expect(response.status).toBe(202);
    const data = await parseJson<{ approvalRequestId: number }>(response);
    return data.approvalRequestId;
  }

  it("aprova normalmente e aplica o ajuste quando o saldo ainda comporta", async () => {
    const requester = await createAuthenticatedUser();
    const org = await createTestOrganization(requester.userId);
    const approver = await createAuthenticatedUser();
    await addMembership(org.id, approver.userId, "administrador");
    const item = await createTestInventoryItem(org.id, requester.userId);

    const approvalRequestId = await setupHighRiskRequest(org.id, requester, item.id);

    const response = await postApprovalDecide(
      buildRequest("approval-requests-decide", { method: "POST", cookie: approver.cookie, body: { organizationId: org.id, requestId: approvalRequestId, decision: "aprovada" } })
    );
    expect(response.status).toBe(200);

    const stockRow = await db.selectFrom("stockTransactions").select((eb) => eb.fn.sum("delta").as("total")).where("itemId", "=", item.id).executeTakeFirst();
    expect(Number(stockRow?.total ?? 0)).toBe(70); // 100 - 30

    const approval = await db.selectFrom("approvalRequests").select(["status"]).where("id", "=", approvalRequestId).executeTakeFirstOrThrow();
    expect(approval.status).toBe("aprovada");
  });

  it("bloqueia (409) aprovar um ajuste que deixaria o saldo negativo por causa de movimentações posteriores ao pedido, e NÃO deixa o pedido preso em 'aprovada'", async () => {
    const requester = await createAuthenticatedUser();
    const org = await createTestOrganization(requester.userId);
    const approver = await createAuthenticatedUser();
    await addMembership(org.id, approver.userId, "administrador");
    const item = await createTestInventoryItem(org.id, requester.userId);

    const approvalRequestId = await setupHighRiskRequest(org.id, requester, item.id);

    // Enquanto o pedido de ajuste (-30) está pendente, uma saída legítima
    // de -80 acontece (saldo cai de 100 para 20) — aprovar o ajuste de -30
    // agora deixaria o saldo em -10.
    // Fase 99E: a saída física não nasce mais em stock-transactions; o consumo concorrente é um fixture sob a trava do item
    const saida = await consumeStockForTest(org.id, requester.userId, item.id, 80);
    expect(saida.status).toBe(200);

    const response = await postApprovalDecide(
      buildRequest("approval-requests-decide", { method: "POST", cookie: approver.cookie, body: { organizationId: org.id, requestId: approvalRequestId, decision: "aprovada" } })
    );
    expect(response.status).toBe(409);
    const data = await parseJson<{ message: string }>(response);
    expect(data.message).toContain("negativo");

    // O saldo não mudou por causa da tentativa de aprovação recusada.
    const stockRow = await db.selectFrom("stockTransactions").select((eb) => eb.fn.sum("delta").as("total")).where("itemId", "=", item.id).executeTakeFirst();
    expect(Number(stockRow?.total ?? 0)).toBe(20); // 100 - 80, o ajuste de -30 nunca foi aplicado

    // O pedido CONTINUA "pendente" — não ficou preso em "aprovada" sem o
    // ajuste ter realmente acontecido (bug que a revalidação corrige).
    const approval = await db.selectFrom("approvalRequests").select(["status"]).where("id", "=", approvalRequestId).executeTakeFirstOrThrow();
    expect(approval.status).toBe("pendente");
  });

  it("rejeitar não aplica o ajuste nem exige saldo suficiente", async () => {
    const requester = await createAuthenticatedUser();
    const org = await createTestOrganization(requester.userId);
    const approver = await createAuthenticatedUser();
    await addMembership(org.id, approver.userId, "administrador");
    const item = await createTestInventoryItem(org.id, requester.userId);

    const approvalRequestId = await setupHighRiskRequest(org.id, requester, item.id);

    const response = await postApprovalDecide(
      buildRequest("approval-requests-decide", { method: "POST", cookie: approver.cookie, body: { organizationId: org.id, requestId: approvalRequestId, decision: "rejeitada" } })
    );
    expect(response.status).toBe(200);

    const stockRow = await db.selectFrom("stockTransactions").select((eb) => eb.fn.sum("delta").as("total")).where("itemId", "=", item.id).executeTakeFirst();
    expect(Number(stockRow?.total ?? 0)).toBe(100); // só a entrada inicial

    const approval = await db.selectFrom("approvalRequests").select(["status"]).where("id", "=", approvalRequestId).executeTakeFirstOrThrow();
    expect(approval.status).toBe("rejeitada");
  });

  it("bloqueia (403) quem pediu aprovar o próprio pedido", async () => {
    const requester = await createAuthenticatedUser();
    const org = await createTestOrganization(requester.userId);
    const item = await createTestInventoryItem(org.id, requester.userId);

    const approvalRequestId = await setupHighRiskRequest(org.id, requester, item.id);

    const response = await postApprovalDecide(
      buildRequest("approval-requests-decide", { method: "POST", cookie: requester.cookie, body: { organizationId: org.id, requestId: approvalRequestId, decision: "aprovada" } })
    );
    expect(response.status).toBe(403);
  });
});
