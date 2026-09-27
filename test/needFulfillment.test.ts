/**
 * Prova comportamental do ledger de atendimento (`need_fulfillments`,
 * Fase 29): registra o fato físico de um recebimento, resolvendo needId
 * pela relação real allocation→match_evaluations→need quando ela existe,
 * sem tocar em needs.status/quantity_needed, sem alterar o motor de
 * matching. Ver src/helpers/needFulfillment.tsx e
 * db/migrations/0006_need_fulfillments.sql.
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { handle as receiveHandle } from "../src/endpoints/allocations-receive_POST";
import { runMatchingForOpportunity } from "../src/helpers/opportunityMatching";
import {
  createAuthenticatedUser,
  createTestOrganization,
  createTestSource,
  createTestOpportunityRegistry,
  createTestInventoryItem,
  createTestAllocation,
  buildRequest,
} from "./helpers";

async function getFulfillment(allocationId: number) {
  return db.selectFrom("needFulfillments").selectAll().where("allocationId", "=", allocationId).executeTakeFirstOrThrow();
}

describe("need_fulfillments — ledger de atendimento", () => {
  it("teste 1: allocation criada pelo motor, recebida -> fulfillment com needId/allocationId/stockTransactionId/quantity/unit corretos", async () => {
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);

    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { city: "Belo Horizonte", state: "MG" });
    const item = await createTestInventoryItem(org.id, owner.userId, { name: "Arroz", unit: "kg" });
    const [need] = await db
      .insertInto("needs")
      .values({ organizationId: org.id, title: "Alimentos não perecíveis para doação", quantityNeeded: "20", unit: "kg", priority: "critica", status: "aberta", createdByUserId: owner.userId })
      .returning(["id"])
      .execute();
    await db.insertInto("organizationCapacities").values({ organizationId: org.id, category: "Alimentos", unit: "kg", maxCapacity: "999", createdByUserId: owner.userId }).execute();
    await db.insertInto("organizationMatchingSettings").values({ organizationId: org.id, realizaColeta: true }).execute();
    await db.insertInto("organizationServiceAreas").values({ organizationId: org.id, city: "Belo Horizonte", state: "MG" }).execute();

    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { title: "Doação de alimentos não perecíveis", status: "aguardando_destinacao" });
    await db.updateTable("opportunityRegistry").set({ category: "Alimentos", unit: "kg", quantity: "20", locationCity: "Belo Horizonte", locationState: "MG" }).where("id", "=", opportunity.id).execute();

    const result = await runMatchingForOpportunity(opportunity.id, admin.userId);
    expect(result.allocationsCreated).toHaveLength(1);
    const allocation = await db.selectFrom("opportunityAllocations").selectAll().where("opportunityRegistryId", "=", opportunity.id).executeTakeFirstOrThrow();

    const evaluation = await db.selectFrom("matchEvaluations").select(["needId"]).where("allocationId", "=", allocation.id).executeTakeFirstOrThrow();
    expect(evaluation.needId).toBe(need.id);

    const receiveRes = await receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocation.id, itemId: item.id, quantityReceived: 20 } }));
    expect(receiveRes.status).toBe(200);

    const fulfillment = await getFulfillment(allocation.id);
    expect(fulfillment.needId).toBe(need.id);
    expect(fulfillment.allocationId).toBe(allocation.id);
    expect(fulfillment.organizationId).toBe(org.id);
    expect(Number(fulfillment.quantity)).toBe(20);
    expect(fulfillment.unit).toBe("kg");
    expect(fulfillment.unitMismatchNote).toBeNull();

    const stockTx = await db.selectFrom("stockTransactions").select(["id"]).where("itemId", "=", item.id).executeTakeFirstOrThrow();
    expect(String(fulfillment.stockTransactionId)).toBe(String(stockTx.id));
  });

  it("teste 2/9: allocation manual (sem match_evaluations), recebida -> needId permanece null", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const item = await createTestInventoryItem(org.id, owner.userId, { name: "Feijão", unit: "kg" });
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "atribuida" });
    const allocation = await createTestAllocation(opportunity.id, org.id, { status: "aceita", quantityAllocated: 50 });

    const noEvaluation = await db.selectFrom("matchEvaluations").select(["id"]).where("allocationId", "=", allocation.id).executeTakeFirst();
    expect(noEvaluation).toBeUndefined(); // confirma: allocation manual nunca gera match_evaluations

    const receiveRes = await receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocation.id, itemId: item.id, quantityReceived: 50 } }));
    expect(receiveRes.status).toBe(200);

    const fulfillment = await getFulfillment(allocation.id);
    expect(fulfillment.needId).toBeNull();
    expect(fulfillment.unitMismatchNote).toBeNull(); // sem need candidata, nem tenta comparar unidade
  });

  it("teste 3: recebimento parcial (alocado 200, recebido 150) -> fulfillment.quantity = 150 (nunca o alocado)", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const item = await createTestInventoryItem(org.id, owner.userId, { name: "Óleo", unit: "kg" });
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "atribuida" });
    const allocation = await createTestAllocation(opportunity.id, org.id, { status: "aceita", quantityAllocated: 200 });

    const receiveRes = await receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocation.id, itemId: item.id, quantityReceived: 150 } }));
    expect(receiveRes.status).toBe(200);

    const fulfillment = await getFulfillment(allocation.id);
    expect(Number(fulfillment.quantity)).toBe(150);
  });

  it("teste 4: recebido acima do alocado (alocado 200, recebido 250) -> fulfillment reflete exatamente o recebido, comportamento atual preservado", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const item = await createTestInventoryItem(org.id, owner.userId, { name: "Açúcar", unit: "kg" });
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "atribuida" });
    const allocation = await createTestAllocation(opportunity.id, org.id, { status: "aceita", quantityAllocated: 200 });

    const receiveRes = await receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocation.id, itemId: item.id, quantityReceived: 250 } }));
    expect(receiveRes.status).toBe(200); // nenhum bloqueio introduzido nesta etapa, por instrução explícita

    const fulfillment = await getFulfillment(allocation.id);
    expect(Number(fulfillment.quantity)).toBe(250); // reflete o recebido, não o alocado — cenário registrado para decisão de produto futura
  });

  it("teste 5: unidades compatíveis (need em kg, recebido em kg, mesma normalização) -> needId vinculado", async () => {
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { city: "Belo Horizonte", state: "MG" });
    const item = await createTestInventoryItem(org.id, owner.userId, { name: "Arroz", unit: "KG" }); // maiúsculo de propósito
    const [need] = await db
      .insertInto("needs")
      .values({ organizationId: org.id, title: "Alimentos não perecíveis para doação", quantityNeeded: "20", unit: "kg", priority: "critica", status: "aberta", createdByUserId: owner.userId })
      .returning(["id"])
      .execute();
    await db.insertInto("organizationCapacities").values({ organizationId: org.id, category: "Alimentos", unit: "KG", maxCapacity: "999", createdByUserId: owner.userId }).execute();
    await db.insertInto("organizationMatchingSettings").values({ organizationId: org.id, realizaColeta: true }).execute();
    await db.insertInto("organizationServiceAreas").values({ organizationId: org.id, city: "Belo Horizonte", state: "MG" }).execute();

    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { title: "Doação de alimentos não perecíveis", status: "aguardando_destinacao" });
    await db.updateTable("opportunityRegistry").set({ category: "Alimentos", unit: "kg", quantity: "20", locationCity: "Belo Horizonte", locationState: "MG" }).where("id", "=", opportunity.id).execute();
    await runMatchingForOpportunity(opportunity.id, admin.userId);
    const allocation = await db.selectFrom("opportunityAllocations").selectAll().where("opportunityRegistryId", "=", opportunity.id).executeTakeFirstOrThrow();

    const receiveRes = await receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocation.id, itemId: item.id, quantityReceived: 20 } }));
    expect(receiveRes.status).toBe(200);

    const fulfillment = await getFulfillment(allocation.id);
    expect(fulfillment.needId).toBe(need.id); // "KG" (item) normaliza igual a "kg" (need) — vinculado
  });

  it("teste 6: unidades incompatíveis (need em kg, item recebido em unidade) -> needId NAO atribuído, motivo registrado", async () => {
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { city: "Belo Horizonte", state: "MG" });
    // Item de recebimento com unidade DIFERENTE da unidade declarada pela need.
    const item = await createTestInventoryItem(org.id, owner.userId, { name: "Cobertores", unit: "unidade" });
    const [need] = await db
      .insertInto("needs")
      .values({ organizationId: org.id, title: "Alimentos não perecíveis para doação", quantityNeeded: "20", unit: "kg", priority: "critica", status: "aberta", createdByUserId: owner.userId })
      .returning(["id"])
      .execute();
    await db.insertInto("organizationCapacities").values({ organizationId: org.id, category: "Alimentos", unit: "kg", maxCapacity: "999", createdByUserId: owner.userId }).execute();
    await db.insertInto("organizationMatchingSettings").values({ organizationId: org.id, realizaColeta: true }).execute();
    await db.insertInto("organizationServiceAreas").values({ organizationId: org.id, city: "Belo Horizonte", state: "MG" }).execute();

    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { title: "Doação de alimentos não perecíveis", status: "aguardando_destinacao" });
    await db.updateTable("opportunityRegistry").set({ category: "Alimentos", unit: "kg", quantity: "20", locationCity: "Belo Horizonte", locationState: "MG" }).where("id", "=", opportunity.id).execute();
    await runMatchingForOpportunity(opportunity.id, admin.userId);
    const allocation = await db.selectFrom("opportunityAllocations").selectAll().where("opportunityRegistryId", "=", opportunity.id).executeTakeFirstOrThrow();

    const evaluation = await db.selectFrom("matchEvaluations").select(["needId"]).where("allocationId", "=", allocation.id).executeTakeFirstOrThrow();
    expect(evaluation.needId).toBe(need.id); // a relação existe...

    // ...mas o item escolhido no recebimento tem unidade diferente da need.
    const receiveRes = await receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocation.id, itemId: item.id, quantityReceived: 20 } }));
    expect(receiveRes.status).toBe(200);

    const fulfillment = await getFulfillment(allocation.id);
    expect(fulfillment.needId).toBeNull(); // nunca soma unidades incompatíveis
    expect(fulfillment.unitMismatchNote).toContain(String(need.id));
    expect(fulfillment.unitMismatchNote).toContain("unidade");
  });

  it("teste 7: mesma allocation recebida duas vezes (concorrente) -> apenas um fulfillment, protegido por UNIQUE(allocation_id)", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const item = await createTestInventoryItem(org.id, owner.userId, { name: "Leite", unit: "litro" });
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "atribuida" });
    const allocation = await createTestAllocation(opportunity.id, org.id, { status: "aceita", quantityAllocated: 30 });

    const req1 = buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocation.id, itemId: item.id, quantityReceived: 30 } });
    const req2 = buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocation.id, itemId: item.id, quantityReceived: 30 } });

    const [res1, res2] = await Promise.all([receiveHandle(req1), receiveHandle(req2)]);
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]); // protegido a montante pela própria máquina de estados da allocation

    const fulfillments = await db.selectFrom("needFulfillments").select(["id"]).where("allocationId", "=", allocation.id).execute();
    expect(fulfillments).toHaveLength(1);
  });

  it("teste 8: multi-tenancy — fulfillment sempre herda organizationId da allocation, nunca de outra organização", async () => {
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);

    const ownerA = await createAuthenticatedUser();
    const orgA = await createTestOrganization(ownerA.userId, { city: "Belo Horizonte", state: "MG" });
    const itemA = await createTestInventoryItem(orgA.id, ownerA.userId, { name: "Item A", unit: "kg" });
    const [needA] = await db.insertInto("needs").values({ organizationId: orgA.id, title: "Alimentos não perecíveis para doação", quantityNeeded: "20", unit: "kg", priority: "critica", status: "aberta", createdByUserId: ownerA.userId }).returning(["id"]).execute();
    await db.insertInto("organizationCapacities").values({ organizationId: orgA.id, category: "Alimentos", unit: "kg", maxCapacity: "999", createdByUserId: ownerA.userId }).execute();
    await db.insertInto("organizationMatchingSettings").values({ organizationId: orgA.id, realizaColeta: true }).execute();
    await db.insertInto("organizationServiceAreas").values({ organizationId: orgA.id, city: "Belo Horizonte", state: "MG" }).execute();

    const ownerB = await createAuthenticatedUser();
    const orgB = await createTestOrganization(ownerB.userId, { city: "Belo Horizonte", state: "MG" });
    await db.insertInto("needs").values({ organizationId: orgB.id, title: "Alimentos não perecíveis para doação", quantityNeeded: "20", unit: "kg", priority: "baixa", status: "aberta", createdByUserId: ownerB.userId }).execute();

    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { title: "Doação de alimentos não perecíveis", status: "aguardando_destinacao" });
    await db.updateTable("opportunityRegistry").set({ category: "Alimentos", unit: "kg", quantity: "20", locationCity: "Belo Horizonte", locationState: "MG" }).where("id", "=", opportunity.id).execute();
    await runMatchingForOpportunity(opportunity.id, admin.userId);

    const allocationA = await db.selectFrom("opportunityAllocations").selectAll().where("opportunityRegistryId", "=", opportunity.id).where("organizationId", "=", orgA.id).executeTakeFirstOrThrow();

    const receiveRes = await receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: ownerA.cookie, body: { organizationId: orgA.id, allocationId: allocationA.id, itemId: itemA.id, quantityReceived: 20 } }));
    expect(receiveRes.status).toBe(200);

    const fulfillment = await getFulfillment(allocationA.id);
    expect(fulfillment.organizationId).toBe(orgA.id);
    expect(fulfillment.needId).toBe(needA.id); // nunca a need de B, mesmo B tendo uma need parecida na mesma oportunidade
  });

  it("teste 10 (histórico/append-only): UPDATE e DELETE em need_fulfillments são bloqueados pelo trigger, como em stock_transactions", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const item = await createTestInventoryItem(org.id, owner.userId, { name: "Item X", unit: "kg" });
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "atribuida" });
    const allocation = await createTestAllocation(opportunity.id, org.id, { status: "aceita", quantityAllocated: 10 });
    await receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocation.id, itemId: item.id, quantityReceived: 10 } }));

    const fulfillment = await getFulfillment(allocation.id);

    await expect(
      db.updateTable("needFulfillments").set({ quantity: "999" }).where("id", "=", fulfillment.id).execute()
    ).rejects.toThrow(/append-only/);

    await expect(
      db.deleteFrom("needFulfillments").where("id", "=", fulfillment.id).execute()
    ).rejects.toThrow(/append-only/);
  });
});
