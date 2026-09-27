/**
 * Prova comportamental de que GET /needs (needs_GET.ts) expõe o progresso
 * derivado do Modelo B (Fase 42) — fulfilled/requiredRemaining/surplus —
 * de forma compatível com o contrato existente (campos aditivos, nenhum
 * campo removido/renomeado), calculado em lote (uma query GROUP BY para
 * toda a listagem, nunca um SUM por need).
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { handle as getNeeds } from "../src/endpoints/needs_GET";
import { buildRequest, parseJson, createAuthenticatedUser, createTestOrganization, createTestInventoryItem, createTestSource, createTestOpportunityRegistry, createTestAllocation } from "./helpers";

describe("GET /needs — progresso derivado (Fase 42)", () => {
  it("retorna fulfilled/requiredRemaining/surplus corretos para needs em estados diferentes, numa única listagem", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);

    const [needSemFulfillment] = await db.insertInto("needs").values({ organizationId: org.id, title: "Sem recebimento", quantityNeeded: "500", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId }).returning(["id"]).execute();
    const [needParcial] = await db.insertInto("needs").values({ organizationId: org.id, title: "Parcial", quantityNeeded: "500", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId }).returning(["id"]).execute();
    const [needOver] = await db.insertInto("needs").values({ organizationId: org.id, title: "Over", quantityNeeded: "500", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId }).returning(["id"]).execute();

    async function addOriginal(needId: number, quantity: number) {
      const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
      const admin = await createAuthenticatedUser();
      const source = await createTestSource(admin.userId);
      const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "atribuida" });
      const allocation = await createTestAllocation(opportunity.id, org.id, { status: "aceita", quantityAllocated: quantity });
      const [tx] = await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: item.id, type: "entrada", delta: String(quantity) }).returning(["id"]).execute();
      await db.insertInto("needFulfillments").values({ organizationId: org.id, needId, allocationId: allocation.id, stockTransactionId: tx.id, quantity: String(quantity), unit: "kg", entryType: "original" }).execute();
    }

    await addOriginal(needParcial.id, 300);
    await addOriginal(needOver.id, 650);

    const response = await getNeeds(buildRequest(`needs?organizationId=${org.id}`, { cookie: owner.cookie }));
    expect(response.status).toBe(200);
    const data = await parseJson<{ needs: Array<{ id: number; quantityNeeded: number; fulfilled: number; requiredRemaining: number; surplus: number }> }>(response);

    const byId = new Map(data.needs.map((n) => [n.id, n]));
    expect(byId.get(needSemFulfillment.id)).toMatchObject({ quantityNeeded: 500, fulfilled: 0, requiredRemaining: 500, surplus: 0 });
    expect(byId.get(needParcial.id)).toMatchObject({ quantityNeeded: 500, fulfilled: 300, requiredRemaining: 200, surplus: 0 });
    expect(byId.get(needOver.id)).toMatchObject({ quantityNeeded: 500, fulfilled: 650, requiredRemaining: 0, surplus: 150 });
  });
});
