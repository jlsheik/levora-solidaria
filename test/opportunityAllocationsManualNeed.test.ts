/**
 * Prova comportamental de allocation manual com `need_id` opcional (Fase
 * 45, decisão da Fase 44): só o `platformAdmin` escolhe, validado
 * inteiramente no servidor, alinhado à mesma regra de elegibilidade do
 * Matching 1.4 (`status='aberta' AND requiredRemaining>0`). Nunca
 * inferido automaticamente.
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { handle as postOpportunityAllocations } from "../src/endpoints/opportunity-allocations_POST";
import { handle as postAllocationsReceive } from "../src/endpoints/allocations-receive_POST";
import {
  createAuthenticatedUser,
  createPlatformAdmin,
  createTestOrganization,
  createTestSource,
  createTestOpportunityRegistry,
  createTestInventoryItem,
  buildRequest,
  parseJson,
} from "./helpers";

async function makeNeed(orgId: number, ownerId: number, overrides: { quantityNeeded?: number; unit?: string; status?: "aberta" | "atendida" | "cancelada" } = {}) {
  const [need] = await db
    .insertInto("needs")
    .values({ organizationId: orgId, title: "Need Fase 45", quantityNeeded: String(overrides.quantityNeeded ?? 500), unit: overrides.unit ?? "kg", priority: "media", status: overrides.status ?? "aberta", createdByUserId: ownerId })
    .returning(["id"])
    .execute();
  return need.id;
}

async function makeOpportunity(adminUserId: number, quantity = 1000) {
  const source = await createTestSource(adminUserId);
  const opp = await createTestOpportunityRegistry(source.id, adminUserId, { status: "validada" });
  await db.updateTable("opportunityRegistry").set({ quantity: String(quantity), unit: "kg" }).where("id", "=", opp.id).execute();
  return opp.id;
}

describe("opportunity-allocations_POST — need_id opcional na allocation manual (Fase 45)", () => {
  it("1: allocation manual SEM need continua funcionando exatamente como antes", async () => {
    const admin = await createPlatformAdmin();
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const opportunityId = await makeOpportunity(admin.userId);

    const response = await postOpportunityAllocations(
      buildRequest("opportunity-allocations", { method: "POST", cookie: admin.cookie, body: { opportunityId, organizationId: org.id, quantityAllocated: 100 } })
    );
    expect(response.status).toBe(200);
    const data = await parseJson<{ allocation: { id: number } }>(response);
    const allocation = await db.selectFrom("opportunityAllocations").select(["needId"]).where("id", "=", data.allocation.id).executeTakeFirstOrThrow();
    expect(allocation.needId).toBeNull();
  });

  it("2/3: allocation manual COM need aberta e remaining>0 funciona e persiste o need_id", async () => {
    const admin = await createPlatformAdmin();
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const needId = await makeNeed(org.id, owner.userId);
    const opportunityId = await makeOpportunity(admin.userId);

    const response = await postOpportunityAllocations(
      buildRequest("opportunity-allocations", { method: "POST", cookie: admin.cookie, body: { opportunityId, organizationId: org.id, quantityAllocated: 100, needId } })
    );
    expect(response.status).toBe(200);
    const data = await parseJson<{ allocation: { id: number } }>(response);
    const allocation = await db.selectFrom("opportunityAllocations").select(["needId"]).where("id", "=", data.allocation.id).executeTakeFirstOrThrow();
    expect(allocation.needId).toBe(needId);
  });

  it("4: organization mismatch (need de outra organização) é rejeitado", async () => {
    const admin = await createPlatformAdmin();
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const otherOwner = await createAuthenticatedUser();
    const otherOrg = await createTestOrganization(otherOwner.userId);
    const needOfOtherOrg = await makeNeed(otherOrg.id, otherOwner.userId);
    const opportunityId = await makeOpportunity(admin.userId);

    const response = await postOpportunityAllocations(
      buildRequest("opportunity-allocations", { method: "POST", cookie: admin.cookie, body: { opportunityId, organizationId: org.id, quantityAllocated: 100, needId: needOfOtherOrg } })
    );
    expect(response.status).toBe(400);
  });

  it("5: need cancelada é rejeitada", async () => {
    const admin = await createPlatformAdmin();
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const needId = await makeNeed(org.id, owner.userId, { status: "cancelada" });
    const opportunityId = await makeOpportunity(admin.userId);

    const response = await postOpportunityAllocations(
      buildRequest("opportunity-allocations", { method: "POST", cookie: admin.cookie, body: { opportunityId, organizationId: org.id, quantityAllocated: 100, needId } })
    );
    expect(response.status).toBe(409);
  });

  it("6: need atendida é rejeitada nesta primeira versão", async () => {
    const admin = await createPlatformAdmin();
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const needId = await makeNeed(org.id, owner.userId, { status: "atendida" });
    const opportunityId = await makeOpportunity(admin.userId);

    const response = await postOpportunityAllocations(
      buildRequest("opportunity-allocations", { method: "POST", cookie: admin.cookie, body: { opportunityId, organizationId: org.id, quantityAllocated: 100, needId } })
    );
    expect(response.status).toBe(409);
  });

  it("7: need aberta com requiredRemaining=0 (já totalmente atendida pela rede) é rejeitada", async () => {
    const admin = await createPlatformAdmin();
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const needId = await makeNeed(org.id, owner.userId, { quantityNeeded: 100 });
    // Satisfaz a need inteira via um recebimento anterior real.
    const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
    const opp1 = await makeOpportunity(admin.userId);
    const alloc1 = await postOpportunityAllocations(
      buildRequest("opportunity-allocations", { method: "POST", cookie: admin.cookie, body: { opportunityId: opp1, organizationId: org.id, quantityAllocated: 100, needId } })
    );
    const alloc1Data = await parseJson<{ allocation: { id: number } }>(alloc1);
    await db.updateTable("opportunityAllocations").set({ status: "aceita" }).where("id", "=", alloc1Data.allocation.id).execute();
    await postAllocationsReceive(
      buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: alloc1Data.allocation.id, itemId: item.id, quantityReceived: 100 } })
    );

    // Segunda tentativa de vincular a MESMA need, já sem saldo.
    const opp2 = await makeOpportunity(admin.userId);
    const response = await postOpportunityAllocations(
      buildRequest("opportunity-allocations", { method: "POST", cookie: admin.cookie, body: { opportunityId: opp2, organizationId: org.id, quantityAllocated: 50, needId } })
    );
    expect(response.status).toBe(409);
  });

  it("8: need com requiredRemaining>0 é aceita", async () => {
    const admin = await createPlatformAdmin();
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const needId = await makeNeed(org.id, owner.userId, { quantityNeeded: 500 });
    const opportunityId = await makeOpportunity(admin.userId);

    const response = await postOpportunityAllocations(
      buildRequest("opportunity-allocations", { method: "POST", cookie: admin.cookie, body: { opportunityId, organizationId: org.id, quantityAllocated: 100, needId } })
    );
    expect(response.status).toBe(200);
  });

  it("9: quantity maior que requiredRemaining continua permitido (vira surplus depois)", async () => {
    const admin = await createPlatformAdmin();
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const needId = await makeNeed(org.id, owner.userId, { quantityNeeded: 200 });
    const opportunityId = await makeOpportunity(admin.userId);

    const response = await postOpportunityAllocations(
      buildRequest("opportunity-allocations", { method: "POST", cookie: admin.cookie, body: { opportunityId, organizationId: org.id, quantityAllocated: 500, needId } })
    );
    expect(response.status).toBe(200);
  });
});

describe("Recebimento de allocation manual vinculada a need (Fase 45)", () => {
  it("10: allocation manual com need gera need_fulfillment com o MESMO need_id", async () => {
    const admin = await createPlatformAdmin();
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const needId = await makeNeed(org.id, owner.userId, { quantityNeeded: 500, unit: "kg" });
    const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
    const opportunityId = await makeOpportunity(admin.userId);

    const allocResp = await postOpportunityAllocations(
      buildRequest("opportunity-allocations", { method: "POST", cookie: admin.cookie, body: { opportunityId, organizationId: org.id, quantityAllocated: 200, needId } })
    );
    const allocData = await parseJson<{ allocation: { id: number } }>(allocResp);
    await db.updateTable("opportunityAllocations").set({ status: "aceita" }).where("id", "=", allocData.allocation.id).execute();

    await postAllocationsReceive(
      buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocData.allocation.id, itemId: item.id, quantityReceived: 200 } })
    );

    const fulfillment = await db.selectFrom("needFulfillments").select(["needId", "quantity"]).where("allocationId", "=", allocData.allocation.id).executeTakeFirstOrThrow();
    expect(fulfillment.needId).toBe(needId);
    expect(Number(fulfillment.quantity)).toBe(200);
  });

  it("11: allocation manual SEM need continua gerando need_fulfillment.need_id=NULL", async () => {
    const admin = await createPlatformAdmin();
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
    const opportunityId = await makeOpportunity(admin.userId);

    const allocResp = await postOpportunityAllocations(
      buildRequest("opportunity-allocations", { method: "POST", cookie: admin.cookie, body: { opportunityId, organizationId: org.id, quantityAllocated: 200 } })
    );
    const allocData = await parseJson<{ allocation: { id: number } }>(allocResp);
    await db.updateTable("opportunityAllocations").set({ status: "aceita" }).where("id", "=", allocData.allocation.id).execute();

    await postAllocationsReceive(
      buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocData.allocation.id, itemId: item.id, quantityReceived: 200 } })
    );

    const fulfillment = await db.selectFrom("needFulfillments").select(["needId"]).where("allocationId", "=", allocData.allocation.id).executeTakeFirstOrThrow();
    expect(fulfillment.needId).toBeNull();
  });

  it("12: requiredRemaining diminui após recebimento de allocation manual vinculada", async () => {
    const admin = await createPlatformAdmin();
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const needId = await makeNeed(org.id, owner.userId, { quantityNeeded: 500, unit: "kg" });
    const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
    const opportunityId = await makeOpportunity(admin.userId);

    const allocResp = await postOpportunityAllocations(
      buildRequest("opportunity-allocations", { method: "POST", cookie: admin.cookie, body: { opportunityId, organizationId: org.id, quantityAllocated: 300, needId } })
    );
    const allocData = await parseJson<{ allocation: { id: number } }>(allocResp);
    await db.updateTable("opportunityAllocations").set({ status: "aceita" }).where("id", "=", allocData.allocation.id).execute();
    await postAllocationsReceive(
      buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocData.allocation.id, itemId: item.id, quantityReceived: 300 } })
    );

    const { getNeedFulfillmentBalance, computeNeedProgress } = await import("../src/helpers/needFulfillment");
    const fulfilled = await getNeedFulfillmentBalance(db, needId);
    expect(computeNeedProgress(500, fulfilled).requiredRemaining).toBe(200);
  });

  it("13: allocation com unidade incompatível gera fulfillment não-contável (is_countable=false), conforme regra já existente", async () => {
    const admin = await createPlatformAdmin();
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const needId = await makeNeed(org.id, owner.userId, { quantityNeeded: 500, unit: "caixa" });
    const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" }); // unidade do item diverge da need
    const opportunityId = await makeOpportunity(admin.userId);

    const allocResp = await postOpportunityAllocations(
      buildRequest("opportunity-allocations", { method: "POST", cookie: admin.cookie, body: { opportunityId, organizationId: org.id, quantityAllocated: 200, needId } })
    );
    const allocData = await parseJson<{ allocation: { id: number } }>(allocResp);
    await db.updateTable("opportunityAllocations").set({ status: "aceita" }).where("id", "=", allocData.allocation.id).execute();
    await postAllocationsReceive(
      buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocData.allocation.id, itemId: item.id, quantityReceived: 200 } })
    );

    const fulfillment = await db.selectFrom("needFulfillments").select(["needId", "isCountable"]).where("allocationId", "=", allocData.allocation.id).executeTakeFirstOrThrow();
    expect(fulfillment.needId).toBe(needId); // vínculo preservado
    expect(fulfillment.isCountable).toBe(false); // mas não conta no progresso
  });
});

describe("Consistência entre fontes de need_id e não-bloqueio retroativo (Fase 45)", () => {
  it("14: inconsistência hipotética entre match_evaluations.need_id e opportunity_allocations.need_id nunca é resolvida silenciosamente", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const needA = await makeNeed(org.id, owner.userId);
    const needB = await makeNeed(org.id, owner.userId);
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "reservada" });
    const [allocation] = await db
      .insertInto("opportunityAllocations")
      .values({ opportunityRegistryId: opportunity.id, organizationId: org.id, quantityAllocated: "100", status: "aceita", needId: needB })
      .returning(["id"])
      .execute();
    // Simula uma match_evaluation hipotética divergente para a MESMA allocation.
    await db
      .insertInto("matchEvaluations")
      .values({ opportunityRegistryId: opportunity.id, organizationId: org.id, needId: needA, allocationId: allocation.id, criteria: {} as never, finalScore: "90", algorithmVersion: "1.4", decision: "atribuido_automatico" })
      .execute();

    const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
    const response = await postAllocationsReceive(
      buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocation.id, itemId: item.id, quantityReceived: 100 } })
    );
    // buildErrorResponse converte a exceção em erro HTTP — nunca um 200 com dado escolhido silenciosamente.
    expect(response.status).not.toBe(200);
    const noFulfillment = await db.selectFrom("needFulfillments").select(["id"]).where("allocationId", "=", allocation.id).executeTakeFirst();
    expect(noFulfillment).toBeUndefined();
  });

  it("15: mudança do status da need DEPOIS da criação da allocation não bloqueia o recebimento já comprometido", async () => {
    const admin = await createPlatformAdmin();
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const needId = await makeNeed(org.id, owner.userId, { quantityNeeded: 500, unit: "kg" });
    const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
    const opportunityId = await makeOpportunity(admin.userId);

    const allocResp = await postOpportunityAllocations(
      buildRequest("opportunity-allocations", { method: "POST", cookie: admin.cookie, body: { opportunityId, organizationId: org.id, quantityAllocated: 200, needId } })
    );
    const allocData = await parseJson<{ allocation: { id: number } }>(allocResp);
    await db.updateTable("opportunityAllocations").set({ status: "aceita" }).where("id", "=", allocData.allocation.id).execute();

    // Status muda DEPOIS da allocation já criada, ANTES do recebimento.
    await db.updateTable("needs").set({ status: "atendida" }).where("id", "=", needId).execute();

    const response = await postAllocationsReceive(
      buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocData.allocation.id, itemId: item.id, quantityReceived: 200 } })
    );
    expect(response.status).toBe(200);
    const fulfillment = await db.selectFrom("needFulfillments").select(["needId"]).where("allocationId", "=", allocData.allocation.id).executeTakeFirstOrThrow();
    expect(fulfillment.needId).toBe(needId);
  });

  it("16: mudança do requiredRemaining DEPOIS da criação da allocation não bloqueia o recebimento", async () => {
    const admin = await createPlatformAdmin();
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const needId = await makeNeed(org.id, owner.userId, { quantityNeeded: 300, unit: "kg" });
    const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
    const opportunityId = await makeOpportunity(admin.userId);

    const allocResp = await postOpportunityAllocations(
      buildRequest("opportunity-allocations", { method: "POST", cookie: admin.cookie, body: { opportunityId, organizationId: org.id, quantityAllocated: 300, needId } })
    );
    const allocData = await parseJson<{ allocation: { id: number } }>(allocResp);
    await db.updateTable("opportunityAllocations").set({ status: "aceita" }).where("id", "=", allocData.allocation.id).execute();

    // Outro recebimento já comprometido satura a need completamente ANTES desta ser recebida.
    const opp2 = await makeOpportunity(admin.userId);
    const alloc2Resp = await postOpportunityAllocations(
      buildRequest("opportunity-allocations", { method: "POST", cookie: admin.cookie, body: { opportunityId: opp2, organizationId: org.id, quantityAllocated: 300, needId } })
    );
    const alloc2Data = await parseJson<{ allocation: { id: number } }>(alloc2Resp);
    await db.updateTable("opportunityAllocations").set({ status: "aceita" }).where("id", "=", alloc2Data.allocation.id).execute();
    await postAllocationsReceive(
      buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: alloc2Data.allocation.id, itemId: item.id, quantityReceived: 300 } })
    );

    // A PRIMEIRA allocation (criada quando remaining=300) ainda é recebida normalmente.
    const response = await postAllocationsReceive(
      buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocData.allocation.id, itemId: item.id, quantityReceived: 300 } })
    );
    expect(response.status).toBe(200);
  });
});

describe("Multi-tenancy estrutural (Fase 45)", () => {
  it("17: FK composta impede allocation.organization_id != need.organization_id mesmo em SQL direto", async () => {
    const owner = await createAuthenticatedUser();
    const orgA = await createTestOrganization(owner.userId);
    const otherOwner = await createAuthenticatedUser();
    const orgB = await createTestOrganization(otherOwner.userId);
    const needOfOrgB = await makeNeed(orgB.id, otherOwner.userId);
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "validada" });

    await expect(
      db
        .insertInto("opportunityAllocations")
        .values({ opportunityRegistryId: opportunity.id, organizationId: orgA.id, quantityAllocated: "100", needId: needOfOrgB })
        .execute()
    ).rejects.toThrow(/opportunity_allocations_need_org_fkey/);
  });
});
