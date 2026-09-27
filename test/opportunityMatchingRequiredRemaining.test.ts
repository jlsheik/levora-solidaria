/**
 * Prova comportamental da integração do progresso real (Fase 42) ao
 * Matching (Fase 43, ALGORITHM_VERSION 1.4): elegibilidade de need passa
 * a exigir `status='aberta' AND requiredRemaining>0`, e o critério
 * `quantidade` compara a oferta da oportunidade contra `requiredRemaining`
 * (não mais `quantityNeeded`). Pesos, thresholds, renormalização e
 * desempate permanecem exatamente os da versão 1.3 — só a fonte da
 * quantidade-alvo e o filtro de elegibilidade mudaram.
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { runMatchingForOpportunity, ALGORITHM_VERSION } from "../src/helpers/opportunityMatching";
import {
  createAuthenticatedUser,
  createTestOrganization,
  createTestSource,
  createTestOpportunityRegistry,
  createTestInventoryItem,
  createTestAllocation,
} from "./helpers";

interface CriterionResult {
  score: number | null;
  weight: number;
  detail: string;
}

async function getEvaluation(opportunityId: number, organizationId: number) {
  return db
    .selectFrom("matchEvaluations")
    .select(["decision", "finalScore", "algorithmVersion", "allocationId", "criteria"])
    .where("opportunityRegistryId", "=", opportunityId)
    .where("organizationId", "=", organizationId)
    .orderBy("id", "desc")
    .executeTakeFirstOrThrow();
}

async function findEvaluation(opportunityId: number, organizationId: number) {
  return db
    .selectFrom("matchEvaluations")
    .select(["id"])
    .where("opportunityRegistryId", "=", opportunityId)
    .where("organizationId", "=", organizationId)
    .executeTakeFirst();
}

/** Organização maximizada em todos os critérios não-quantidade, para isolar só o efeito de requiredRemaining no score final. */
async function fullyConfiguredOrg(unit: string, quantityNeeded: number, needStatus: "aberta" | "atendida" | "cancelada" = "aberta") {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId, { city: "Belo Horizonte", state: "MG" });
  const [need] = await db
    .insertInto("needs")
    .values({ organizationId: org.id, title: "Alimentos não perecíveis para doação", quantityNeeded: String(quantityNeeded), unit, priority: "critica", status: needStatus, createdByUserId: owner.userId })
    .returning(["id"])
    .execute();
  await db.insertInto("organizationCapacities").values({ organizationId: org.id, category: "Alimentos", unit, maxCapacity: "999999", createdByUserId: owner.userId }).execute();
  await db.insertInto("organizationMatchingSettings").values({ organizationId: org.id, realizaColeta: true }).execute();
  await db.insertInto("organizationServiceAreas").values({ organizationId: org.id, city: "Belo Horizonte", state: "MG" }).execute();
  return { owner, orgId: org.id, needId: need.id };
}

async function addFulfillment(orgId: number, ownerId: number, needId: number, quantity: number, opts: { unit?: string; isCountable?: boolean } = {}) {
  const item = await createTestInventoryItem(orgId, ownerId, { unit: opts.unit ?? "kg" });
  const admin = await createAuthenticatedUser();
  const source = await createTestSource(admin.userId);
  const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "atribuida" });
  const allocation = await createTestAllocation(opportunity.id, orgId, { status: "aceita", quantityAllocated: quantity });
  const [tx] = await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: String(quantity) }).returning(["id"]).execute();
  const [row] = await db
    .insertInto("needFulfillments")
    .values({ organizationId: orgId, needId, allocationId: allocation.id, stockTransactionId: tx.id, quantity: String(quantity), unit: opts.unit ?? "kg", entryType: "original", isCountable: opts.isCountable ?? true })
    .returning(["id"])
    .execute();
  return row.id;
}

async function addReversal(orgId: number, needId: number, targetId: number, quantity: number, unit = "kg") {
  const targetRow = await db.selectFrom("needFulfillments").select(["allocationId"]).where("id", "=", targetId).executeTakeFirstOrThrow();
  await db
    .insertInto("needFulfillments")
    .values({ organizationId: orgId, needId, allocationId: targetRow.allocationId, stockTransactionId: null, quantity: String(quantity), unit, entryType: "reversal", reversesFulfillmentId: targetId })
    .execute();
}

async function makeOpportunity(sourceId: number, adminUserId: number, quantity: number, unit: string) {
  const opp = await createTestOpportunityRegistry(sourceId, adminUserId, { title: "Doação de alimentos não perecíveis", status: "aguardando_destinacao" });
  await db
    .updateTable("opportunityRegistry")
    .set({ category: "Alimentos", unit, quantity: String(quantity), locationCity: "Belo Horizonte", locationState: "MG" })
    .where("id", "=", opp.id)
    .execute();
  return opp.id;
}

describe("Matching 1.4 — elegibilidade e quantity score usando requiredRemaining", () => {
  it("teste 1: need aberta sem fulfillment (500/0/500) é candidata", async () => {
    const { orgId } = await fullyConfiguredOrg("kg", 500);
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunityId = await makeOpportunity(source.id, admin.userId, 500, "kg");

    await runMatchingForOpportunity(opportunityId, admin.userId);
    const found = await findEvaluation(opportunityId, orgId);
    expect(found).toBeDefined();
  });

  it("teste 2: need parcialmente atendida (500/200/300) é candidata, e o quantity score usa 300 (restante), não 500 (original)", async () => {
    const { owner, orgId, needId } = await fullyConfiguredOrg("kg", 500);
    await addFulfillment(orgId, owner.userId, needId, 200);
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    // Oportunidade oferece exatamente o que falta (300) — se o motor ainda
    // comparasse contra o quantityNeeded original (500), o score seria
    // (min(300,500)/500)*100=60; usando o restante (300), é 100.
    const opportunityId = await makeOpportunity(source.id, admin.userId, 300, "kg");

    await runMatchingForOpportunity(opportunityId, admin.userId);
    const evaluation = await getEvaluation(opportunityId, orgId);
    const criteria = evaluation.criteria as unknown as Record<string, CriterionResult>;
    expect(criteria.quantidade.score).toBe(100);
    expect(criteria.quantidade.detail).toContain("restante 300");
  });

  it("teste 3: need exatamente atendida (500/500/0, status aberta) NÃO é candidata", async () => {
    const { owner, orgId, needId } = await fullyConfiguredOrg("kg", 500);
    await addFulfillment(orgId, owner.userId, needId, 500);
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunityId = await makeOpportunity(source.id, admin.userId, 500, "kg");

    await runMatchingForOpportunity(opportunityId, admin.userId);
    const found = await findEvaluation(opportunityId, orgId);
    expect(found).toBeUndefined();
  });

  it("teste 4: need over-fulfilled (500/650/0, status aberta) NÃO é candidata", async () => {
    const { owner, orgId, needId } = await fullyConfiguredOrg("kg", 500);
    await addFulfillment(orgId, owner.userId, needId, 650);
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunityId = await makeOpportunity(source.id, admin.userId, 500, "kg");

    await runMatchingForOpportunity(opportunityId, admin.userId);
    const found = await findEvaluation(opportunityId, orgId);
    expect(found).toBeUndefined();
  });

  it("teste 5: need status='atendida' (mesmo com fulfilled=0, requiredRemaining=500) NÃO é candidata — status continua bloqueando o matching", async () => {
    const { orgId } = await fullyConfiguredOrg("kg", 500, "atendida");
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunityId = await makeOpportunity(source.id, admin.userId, 500, "kg");

    await runMatchingForOpportunity(opportunityId, admin.userId);
    const found = await findEvaluation(opportunityId, orgId);
    expect(found).toBeUndefined();
  });

  it("teste 6: need cancelada NÃO é candidata", async () => {
    const { orgId } = await fullyConfiguredOrg("kg", 500, "cancelada");
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunityId = await makeOpportunity(source.id, admin.userId, 500, "kg");

    await runMatchingForOpportunity(opportunityId, admin.userId);
    const found = await findEvaluation(opportunityId, orgId);
    expect(found).toBeUndefined();
  });

  it("teste 7: reversal total (+500 -500) reabre a necessidade no progresso (remaining volta a 500) — status continua aberta, volta a ser candidata", async () => {
    const { owner, orgId, needId } = await fullyConfiguredOrg("kg", 500);
    const originalId = await addFulfillment(orgId, owner.userId, needId, 500);
    await addReversal(orgId, needId, originalId, 500);
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunityId = await makeOpportunity(source.id, admin.userId, 500, "kg");

    await runMatchingForOpportunity(opportunityId, admin.userId);
    const evaluation = await getEvaluation(opportunityId, orgId);
    const criteria = evaluation.criteria as unknown as Record<string, CriterionResult>;
    expect(criteria.quantidade.score).toBe(100); // 500 restante vs 500 oferecido
  });

  it("teste 8: non-countable (+200 is_countable=false) não conta no progresso — remaining continua 500", async () => {
    const { owner, orgId, needId } = await fullyConfiguredOrg("kg", 500);
    await addFulfillment(orgId, owner.userId, needId, 200, { isCountable: false });
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunityId = await makeOpportunity(source.id, admin.userId, 500, "kg");

    await runMatchingForOpportunity(opportunityId, admin.userId);
    const evaluation = await getEvaluation(opportunityId, orgId);
    const criteria = evaluation.criteria as unknown as Record<string, CriterionResult>;
    expect(criteria.quantidade.score).toBe(100); // 500 restante (200 non-countable ignorado) vs 500 oferecido
  });

  it("teste 9: unidade compatível (remaining 300kg vs oferta 300kg) — quantity score válido", async () => {
    const { owner, orgId, needId } = await fullyConfiguredOrg("kg", 500);
    await addFulfillment(orgId, owner.userId, needId, 200);
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunityId = await makeOpportunity(source.id, admin.userId, 300, "kg");

    await runMatchingForOpportunity(opportunityId, admin.userId);
    const evaluation = await getEvaluation(opportunityId, orgId);
    const criteria = evaluation.criteria as unknown as Record<string, CriterionResult>;
    expect(criteria.quantidade.score).toBe(100);
  });

  it("teste 10: unidade incompatível (remaining 300kg vs oferta 300 caixas) — quantity score null, nunca comparado numericamente", async () => {
    const { owner, orgId, needId } = await fullyConfiguredOrg("kg", 500);
    await addFulfillment(orgId, owner.userId, needId, 200);
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunityId = await makeOpportunity(source.id, admin.userId, 300, "caixa");

    await runMatchingForOpportunity(opportunityId, admin.userId);
    const evaluation = await getEvaluation(opportunityId, orgId);
    const criteria = evaluation.criteria as unknown as Record<string, CriterionResult>;
    expect(criteria.quantidade.score).toBeNull();
  });

  it("teste 11: renormalização — quantidade=null (unidade incompatível) continua fora do denominador, finalScore não penalizado como se fosse 0", async () => {
    const { owner, orgId, needId } = await fullyConfiguredOrg("caixa", 500);
    await addFulfillment(orgId, owner.userId, needId, 200, { unit: "caixa" });
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunityId = await makeOpportunity(source.id, admin.userId, 300, "kg");

    await runMatchingForOpportunity(opportunityId, admin.userId);
    const evaluation = await getEvaluation(opportunityId, orgId);
    const criteria = evaluation.criteria as unknown as Record<string, CriterionResult>;
    expect(criteria.quantidade.score).toBeNull();
    expect(Number(evaluation.finalScore)).toBeGreaterThan(0);
  });

  it("teste 12: trocar quantityNeeded por requiredRemaining pode alterar o finalScore, mas os pesos/thresholds continuam os mesmos (>=90 automatico inalterado)", async () => {
    const { owner, orgId, needId } = await fullyConfiguredOrg("kg", 500);
    await addFulfillment(orgId, owner.userId, needId, 200); // remaining = 300
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    // Oferta de 300 (== remaining) -> quantidade=100. Com o comportamento
    // antigo (quantityNeeded=500), quantidade seria (300/500)*100=60 —
    // mesma diferença que prova o efeito real da mudança no score, sem
    // mexer em peso/threshold.
    const opportunityId = await makeOpportunity(source.id, admin.userId, 300, "kg");

    await runMatchingForOpportunity(opportunityId, admin.userId);
    const evaluation = await getEvaluation(opportunityId, orgId);
    expect(evaluation.decision).toBe("atribuido_automatico"); // score >= 90 com remaining=300
    expect(Number(evaluation.finalScore)).toBeGreaterThanOrEqual(90);
  });

  it("teste 13: múltiplas needs candidatas têm o progresso calculado em lote (uma única operação), cada uma com seu próprio remaining correto", async () => {
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const a = await fullyConfiguredOrg("kg", 500);
    const b = await fullyConfiguredOrg("kg", 500);
    const c = await fullyConfiguredOrg("kg", 500);
    await addFulfillment(a.orgId, a.owner.userId, a.needId, 200); // remaining 300
    await addFulfillment(b.orgId, b.owner.userId, b.needId, 500); // remaining 0 -> não elegível
    // c: sem fulfillment -> remaining 500

    const opportunityId = await makeOpportunity(source.id, admin.userId, 1000, "kg");
    await runMatchingForOpportunity(opportunityId, admin.userId);

    const evalA = await getEvaluation(opportunityId, a.orgId);
    const evalC = await getEvaluation(opportunityId, c.orgId);
    const foundB = await findEvaluation(opportunityId, b.orgId);

    expect((evalA.criteria as unknown as Record<string, CriterionResult>).quantidade.detail).toContain("restante 300");
    expect((evalC.criteria as unknown as Record<string, CriterionResult>).quantidade.detail).toContain("restante 500");
    expect(foundB).toBeUndefined();
  });

  it("teste 14: multi-tenancy — o progresso em lote nunca cruza fulfillments de organizações diferentes", async () => {
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const orgA = await fullyConfiguredOrg("kg", 500);
    const orgB = await fullyConfiguredOrg("kg", 500);
    // Só orgA recebe fulfillment; orgB precisa continuar com remaining=500
    // mesmo processada na MESMA chamada de matching (mesmo lote).
    await addFulfillment(orgA.orgId, orgA.owner.userId, orgA.needId, 200);

    const opportunityId = await makeOpportunity(source.id, admin.userId, 1000, "kg");
    await runMatchingForOpportunity(opportunityId, admin.userId);

    const evalA = await getEvaluation(opportunityId, orgA.orgId);
    const evalB = await getEvaluation(opportunityId, orgB.orgId);
    expect((evalA.criteria as unknown as Record<string, CriterionResult>).quantidade.detail).toContain("restante 300");
    expect((evalB.criteria as unknown as Record<string, CriterionResult>).quantidade.detail).toContain("restante 500");
  });

  it("teste 15: novas avaliações usam algorithm_version=1.4; avaliações antigas (1.3) já persistidas permanecem intactas", async () => {
    const { orgId, needId } = await fullyConfiguredOrg("kg", 500);
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunityId = await makeOpportunity(source.id, admin.userId, 500, "kg");

    // Simula uma avaliação histórica já persistida na versão anterior, antes
    // desta fase — nunca deve ser reescrita retroativamente.
    await db
      .insertInto("matchEvaluations")
      .values({
        opportunityRegistryId: opportunityId,
        organizationId: orgId,
        needId,
        criteria: {} as never,
        finalScore: "42",
        algorithmVersion: "1.3",
        decision: "descartado",
      })
      .execute();

    expect(ALGORITHM_VERSION).toBe("1.4");
    await runMatchingForOpportunity(opportunityId, admin.userId);

    const rows = await db
      .selectFrom("matchEvaluations")
      .select(["algorithmVersion"])
      .where("opportunityRegistryId", "=", opportunityId)
      .where("organizationId", "=", orgId)
      .orderBy("id", "asc")
      .execute();

    expect(rows[0].algorithmVersion).toBe("1.3"); // histórica, intocada
    expect(rows[rows.length - 1].algorithmVersion).toBe("1.4"); // nova avaliação desta fase
  });
});
