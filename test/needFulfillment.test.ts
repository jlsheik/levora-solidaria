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
    expect(fulfillment.entryType).toBe("original");
    expect(fulfillment.isCountable).toBe(true);
    expect(fulfillment.reversesFulfillmentId).toBeNull();

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

  it("teste 6: unidades incompatíveis (need em kg, item recebido em unidade) -> needId PRESERVADO, isCountable=false, motivo registrado (Modelo B)", async () => {
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
    // Modelo B: a relação com a need é preservada (era um fato já certo,
    // gravado no matching) — só a contabilização é suspensa.
    expect(fulfillment.needId).toBe(need.id);
    expect(fulfillment.isCountable).toBe(false);
    expect(fulfillment.entryType).toBe("original");
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

describe("need_fulfillments — FKs RESTRICT (achado de auditoria corrigido: append-only x CASCADE/SET NULL)", () => {
  async function setupFulfillment() {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const item = await createTestInventoryItem(org.id, owner.userId, { name: "Item RESTRICT", unit: "kg" });
    const [need] = await db
      .insertInto("needs")
      .values({ organizationId: org.id, title: "Need de teste RESTRICT", quantityNeeded: "10", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId })
      .returning(["id"])
      .execute();
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "atribuida" });
    const allocation = await createTestAllocation(opportunity.id, org.id, { status: "aceita", quantityAllocated: 10 });

    // Vincula manualmente um needId (não passa pelo motor, só para isolar
    // o comportamento de FK sob teste) via insert direto de match_evaluations,
    // exatamente como o motor faria.
    await db
      .insertInto("matchEvaluations")
      .values({ opportunityRegistryId: opportunity.id, organizationId: org.id, needId: need.id, criteria: {}, finalScore: "100", algorithmVersion: "1.3", decision: "atribuido_automatico", allocationId: allocation.id })
      .execute();

    const receiveRes = await receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocation.id, itemId: item.id, quantityReceived: 10 } }));
    expect(receiveRes.status).toBe(200);

    return { owner, org, need, allocation };
  }

  it("teste A: UPDATE em need_fulfillments continua bloqueado", async () => {
    const { allocation } = await setupFulfillment();
    const fulfillment = await getFulfillment(allocation.id);
    await expect(db.updateTable("needFulfillments").set({ quantity: "1" }).where("id", "=", fulfillment.id).execute()).rejects.toThrow(/append-only/);
  });

  it("teste B: DELETE em need_fulfillments continua bloqueado", async () => {
    const { allocation } = await setupFulfillment();
    const fulfillment = await getFulfillment(allocation.id);
    await expect(db.deleteFrom("needFulfillments").where("id", "=", fulfillment.id).execute()).rejects.toThrow(/append-only/);
  });

  it("teste C: excluir a NEED referenciada por um fulfillment é bloqueado (RESTRICT) — nunca silenciosamente vira null", async () => {
    const { need } = await setupFulfillment();
    await expect(db.deleteFrom("needs").where("id", "=", need.id).execute()).rejects.toThrow();

    const stillThere = await db.selectFrom("needs").select(["id"]).where("id", "=", need.id).executeTakeFirst();
    expect(stillThere).toBeDefined(); // a need não foi apagada — bloqueada antes de qualquer efeito colateral
  });

  it("teste D: excluir a ALLOCATION referenciada por um fulfillment é bloqueado (RESTRICT) — nunca cascateia silenciosamente", async () => {
    const { allocation } = await setupFulfillment();
    await expect(db.deleteFrom("opportunityAllocations").where("id", "=", allocation.id).execute()).rejects.toThrow();

    const fulfillmentStillThere = await getFulfillment(allocation.id);
    expect(fulfillmentStillThere).toBeDefined(); // histórico intacto — a exclusão nunca chegou a acontecer
  });

  it("teste E: excluir a ORGANIZATION referenciada por um fulfillment é bloqueado (RESTRICT) — não existe hoje nenhum fluxo real que dependa de apagar organizations", async () => {
    const { org } = await setupFulfillment();
    // Não existe nenhum endpoint real que apague organizations (confirmado
    // por auditoria) — este teste prova só a proteção de schema em si,
    // usando um DELETE direto, não um fluxo de produto inventado.
    await expect(db.deleteFrom("organizations").where("id", "=", org.id).execute()).rejects.toThrow();
  });
});

describe("need_fulfillments — Modelo B: ledger de eventos (entry_type/is_countable/reverses_fulfillment_id)", () => {
  async function setupOriginal(quantity = 200) {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const item = await createTestInventoryItem(org.id, owner.userId, { name: "Item Modelo B", unit: "kg" });
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "atribuida" });
    const allocation = await createTestAllocation(opportunity.id, org.id, { status: "aceita", quantityAllocated: quantity });

    const receiveRes = await receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocation.id, itemId: item.id, quantityReceived: quantity } }));
    expect(receiveRes.status).toBe(200);

    const original = await getFulfillment(allocation.id);
    return { owner, org, item, allocation, original };
  }

  it("teste 3: correção de evento original (novo valor, sem stock_transaction novo) -> permitido, referencia o original", async () => {
    const { org, allocation, original } = await setupOriginal(200);

    const [correction] = await db
      .insertInto("needFulfillments")
      .values({
        organizationId: org.id,
        needId: null,
        allocationId: allocation.id,
        stockTransactionId: null,
        quantity: "150",
        unit: "kg",
        entryType: "correction",
        isCountable: true,
        reversesFulfillmentId: original.id,
      })
      .returning(["id"])
      .execute();

    const correctionRow = await db.selectFrom("needFulfillments").selectAll().where("id", "=", correction.id).executeTakeFirstOrThrow();
    expect(correctionRow.entryType).toBe("correction");
    expect(correctionRow.allocationId).toBe(allocation.id); // repete a allocation da linha original
    expect(correctionRow.reversesFulfillmentId).toBe(original.id);
    expect(correctionRow.stockTransactionId).toBeNull(); // teste 8: correção sem novo movimento físico
    expect(Number(correctionRow.quantity)).toBe(150);
  });

  it("teste 4: reversão de evento original -> permitida, exige reverses_fulfillment_id", async () => {
    const { org, allocation, original } = await setupOriginal(200);

    const [reversal] = await db
      .insertInto("needFulfillments")
      .values({
        organizationId: org.id,
        needId: null,
        allocationId: allocation.id,
        stockTransactionId: null,
        quantity: "200",
        unit: "kg",
        entryType: "reversal",
        isCountable: true,
        reversesFulfillmentId: original.id,
      })
      .returning(["id"])
      .execute();

    const reversalRow = await db.selectFrom("needFulfillments").selectAll().where("id", "=", reversal.id).executeTakeFirstOrThrow();
    expect(reversalRow.entryType).toBe("reversal");
    expect(reversalRow.reversesFulfillmentId).toBe(original.id);

    // reversal SEM reverses_fulfillment_id é rejeitado pelo trigger.
    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "50", unit: "kg", entryType: "reversal", isCountable: true }).execute()
    ).rejects.toThrow(/exige reverses_fulfillment_id/);
  });

  it("teste 9: correção COM novo stock_transaction (movimento físico real de ajuste) -> permitido", async () => {
    const { org, item, allocation, original } = await setupOriginal(200);

    const [adjustmentTx] = await db
      .insertInto("stockTransactions")
      .values({ organizationId: org.id, itemId: item.id, type: "ajuste", delta: "-50", reason: "correção de recebimento" })
      .returning(["id"])
      .execute();

    const [correction] = await db
      .insertInto("needFulfillments")
      .values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: adjustmentTx.id, quantity: "50", unit: "kg", entryType: "correction", isCountable: true, reversesFulfillmentId: original.id })
      .returning(["id"])
      .execute();

    const correctionRow = await db.selectFrom("needFulfillments").select(["stockTransactionId"]).where("id", "=", correction.id).executeTakeFirstOrThrow();
    expect(String(correctionRow.stockTransactionId)).toBe(String(adjustmentTx.id));
    expect(String(correctionRow.stockTransactionId)).not.toBe(String(original.stockTransactionId)); // stock_transaction distinto, nunca reaproveitado
  });

  it("teste 6 (schema): duas linhas 'original' para a MESMA allocation são proibidas (índice único parcial)", async () => {
    const { org, item, allocation } = await setupOriginal(200);

    // Insert válido quanto ao trigger (stock_transaction_id preenchido,
    // entry_type=original) — a única coisa que deve barrar é o índice
    // único parcial idx_need_fulfillments_one_original_per_allocation.
    const [secondTx] = await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: item.id, type: "entrada", delta: "10" }).returning(["id"]).execute();

    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: secondTx.id, quantity: "10", unit: "kg", entryType: "original" }).execute()
    ).rejects.toThrow(/idx_need_fulfillments_one_original_per_allocation|duplicate key/);
  });

  it("teste 7 (schema): duas linhas 'original' para o MESMO stock_transaction são proibidas (UNIQUE)", async () => {
    const { org, item, allocation } = await setupOriginal(200);
    const originalRow = await getFulfillment(allocation.id);

    const secondAllocation = await createTestAllocation((await db.selectFrom("opportunityAllocations").select(["opportunityRegistryId"]).where("id", "=", allocation.id).executeTakeFirstOrThrow()).opportunityRegistryId, org.id, { status: "aceita", quantityAllocated: 10 });

    await expect(
      db
        .insertInto("needFulfillments")
        .values({ organizationId: org.id, needId: null, allocationId: secondAllocation.id, stockTransactionId: originalRow.stockTransactionId!, quantity: "10", unit: "kg", entryType: "original" })
        .execute()
    ).rejects.toThrow(); // UNIQUE(stock_transaction_id)
  });

  it("reverses_fulfillment_id não pode apontar para uma linha que já é 'reversal' (proibido pelo trigger)", async () => {
    const { org, allocation, original } = await setupOriginal(200);
    const [reversal] = await db
      .insertInto("needFulfillments")
      .values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "200", unit: "kg", entryType: "reversal", reversesFulfillmentId: original.id })
      .returning(["id"])
      .execute();

    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "50", unit: "kg", entryType: "correction", reversesFulfillmentId: reversal.id }).execute()
    ).rejects.toThrow(/já é entry_type=reversal/);
  });

  it("reverses_fulfillment_id não pode apontar para uma linha de OUTRA allocation", async () => {
    const { org, allocation, original } = await setupOriginal(200);
    const otherAllocation = await createTestAllocation((await db.selectFrom("opportunityAllocations").select(["opportunityRegistryId"]).where("id", "=", allocation.id).executeTakeFirstOrThrow()).opportunityRegistryId, org.id, { status: "aceita", quantityAllocated: 5 });

    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: otherAllocation.id, stockTransactionId: null, quantity: "5", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id }).execute()
    ).rejects.toThrow(/mesma allocation_id/);
  });

  it("teste 12: migração — linha inserida sem especificar entry_type/is_countable usa os defaults corretos ('original'/true)", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "atribuida" });
    const allocation = await createTestAllocation(opportunity.id, org.id, { status: "aceita", quantityAllocated: 10 });
    const item = await createTestInventoryItem(org.id, owner.userId, { name: "Item legado", unit: "kg" });
    const [tx] = await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: item.id, type: "entrada", delta: "10", createdByUserId: owner.userId }).returning(["id"]).execute();

    // Insert "à moda antiga" (Fase 29), sem entry_type/is_countable — como
    // seria um registro histórico anterior a esta migration.
    await db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: tx.id, quantity: "10", unit: "kg" }).execute();

    const row = await getFulfillment(allocation.id);
    expect(row.entryType).toBe("original");
    expect(row.isCountable).toBe(true);
    expect(row.reversesFulfillmentId).toBeNull();
  });
});
