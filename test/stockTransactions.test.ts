import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/helpers/db";
import { handle as postStockTransaction } from "../src/endpoints/stock-transactions_POST";
import {
  createAuthenticatedUser,
  createTestOrganization,
  createTestInventoryItem as createItem,
  addMembership,
  buildRequest,
  parseJson,
  type AuthenticatedTestUser,
} from "./helpers";

describe("POST /stock-transactions", () => {
  let owner: AuthenticatedTestUser;
  let orgId: number;
  let itemId: number;

  beforeEach(async () => {
    owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    orgId = org.id;
    const item = await createItem(orgId, owner.userId);
    itemId = item.id;
  });

  it("registra uma entrada e retorna o novo saldo", async () => {
    const response = await postStockTransaction(
      buildRequest("stock-transactions", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, itemId, type: "entrada", quantity: 50, reason: "Doação recebida" },
      })
    );
    expect(response.status).toBe(200);
    const data = await parseJson<{ newStock: number; transaction: { delta: number } }>(response);
    expect(data.newStock).toBe(50);
    expect(data.transaction.delta).toBe(50);
  });

  it("bloqueia saída que deixaria o saldo negativo (409)", async () => {
    await postStockTransaction(
      buildRequest("stock-transactions", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, itemId, type: "entrada", quantity: 10, reason: "Entrada inicial" },
      })
    );

    const response = await postStockTransaction(
      buildRequest("stock-transactions", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, itemId, type: "saida", quantity: 20, reason: "Distribuição" },
      })
    );
    expect(response.status).toBe(409);

    const stockRow = await db
      .selectFrom("stockTransactions")
      .select((eb) => eb.fn.sum("delta").as("total"))
      .where("itemId", "=", itemId)
      .executeTakeFirst();
    expect(Number(stockRow?.total ?? 0)).toBe(10); // a tentativa bloqueada não deixou rastro
  });

  it("exige segunda aprovação para ajuste negativo de alto risco em vez de aplicar direto", async () => {
    await postStockTransaction(
      buildRequest("stock-transactions", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, itemId, type: "entrada", quantity: 100, reason: "Entrada inicial" },
      })
    );

    const response = await postStockTransaction(
      buildRequest("stock-transactions", {
        method: "POST",
        cookie: owner.cookie,
        // -30 é >= 20 (limite absoluto) e >= 30% de 100 — dispara dupla aprovação.
        body: { organizationId: orgId, itemId, type: "ajuste", quantity: -30, reason: "Divergência encontrada na conferência" },
      })
    );
    expect(response.status).toBe(202);
    const data = await parseJson<{ approvalRequestId: number }>(response);
    expect(data.approvalRequestId).toBeGreaterThan(0);

    const pending = await db
      .selectFrom("approvalRequests")
      .select(["id", "status", "actionType"])
      .where("id", "=", data.approvalRequestId)
      .executeTakeFirstOrThrow();
    expect(pending.status).toBe("pendente");
    expect(pending.actionType).toBe("ajuste_estoque_alto_risco");

    // O ajuste NÃO foi aplicado ao saldo até que alguém aprove.
    const stockRow = await db
      .selectFrom("stockTransactions")
      .select((eb) => eb.fn.sum("delta").as("total"))
      .where("itemId", "=", itemId)
      .executeTakeFirst();
    expect(Number(stockRow?.total ?? 0)).toBe(100);
  });

  it("aplica ajuste negativo pequeno diretamente, sem exigir aprovação", async () => {
    await postStockTransaction(
      buildRequest("stock-transactions", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, itemId, type: "entrada", quantity: 100, reason: "Entrada inicial" },
      })
    );

    const response = await postStockTransaction(
      buildRequest("stock-transactions", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, itemId, type: "ajuste", quantity: -5, reason: "Pequeno ajuste de contagem" },
      })
    );
    expect(response.status).toBe(200);
    const data = await parseJson<{ newStock: number }>(response);
    expect(data.newStock).toBe(95);
  });

  it("nega acesso (403) para usuário sem membership ativo na organização", async () => {
    const outsider = await createAuthenticatedUser();
    const response = await postStockTransaction(
      buildRequest("stock-transactions", {
        method: "POST",
        cookie: outsider.cookie,
        body: { organizationId: orgId, itemId, type: "entrada", quantity: 10, reason: "Tentativa indevida" },
      })
    );
    expect(response.status).toBe(403);
  });

  it("nega acesso (403) para papel voluntário, que não pode lançar estoque", async () => {
    const volunteer = await createAuthenticatedUser();
    await addMembership(orgId, volunteer.userId, "voluntario");

    const response = await postStockTransaction(
      buildRequest("stock-transactions", {
        method: "POST",
        cookie: volunteer.cookie,
        body: { organizationId: orgId, itemId, type: "entrada", quantity: 10, reason: "Tentativa indevida" },
      })
    );
    expect(response.status).toBe(403);
  });

  it("rejeita sem sessão autenticada (401)", async () => {
    const response = await postStockTransaction(
      buildRequest("stock-transactions", {
        method: "POST",
        body: { organizationId: orgId, itemId, type: "entrada", quantity: 10, reason: "Sem login" },
      })
    );
    expect(response.status).toBe(401);
  });

  it("impede que um item de outra organização seja usado no lançamento (isolamento multi-tenant)", async () => {
    const otherOwner = await createAuthenticatedUser();
    const otherOrg = await createTestOrganization(otherOwner.userId);
    const otherItem = await createItem(otherOrg.id, otherOwner.userId, { name: "Item de outra organização" });

    // owner é membro de `orgId`, tenta lançar estoque no item de `otherOrg`.
    const response = await postStockTransaction(
      buildRequest("stock-transactions", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: orgId, itemId: otherItem.id, type: "entrada", quantity: 10, reason: "Tentativa cruzada" },
      })
    );
    expect(response.status).toBe(404);
  });
});
