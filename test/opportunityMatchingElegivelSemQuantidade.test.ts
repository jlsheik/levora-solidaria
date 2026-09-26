/**
 * Prova comportamental do achado de auditoria "remaining=0 apaga
 * candidatos elegíveis do rastro de match_evaluations". Correção:
 * candidatos que já foram pontuados (score >= MEDIUM_CONFIDENCE_THRESHOLD)
 * mas não recebem alocação porque a quantidade da oportunidade já foi
 * totalmente distribuída para candidatos anteriores na MESMA execução
 * agora persistem uma match_evaluation com decision="elegivel_sem_quantidade"
 * — nunca "descartado" (não foram reprovados pelo score) e nunca geram
 * opportunity_allocations. Ver relatório de auditoria entregue no chat.
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { runMatchingForOpportunity, ALGORITHM_VERSION } from "../src/helpers/opportunityMatching";
import {
  createAuthenticatedUser,
  createTestOrganization,
  createTestSource,
  createTestOpportunityRegistry,
} from "./helpers";

interface CriterionResult {
  score: number | null;
  weight: number;
  detail: string;
}

async function fullyConfiguredOrg(city: string, state: string, priority: "baixa" | "media" | "alta" | "critica", needQty: number) {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId, { city, state });
  await db.insertInto("needs").values({ organizationId: org.id, title: "Alimentos não perecíveis para doação", quantityNeeded: String(needQty), unit: "kg", priority, status: "aberta", createdByUserId: owner.userId }).execute();
  await db.insertInto("organizationCapacities").values({ organizationId: org.id, category: "Alimentos", unit: "kg", maxCapacity: "999999", createdByUserId: owner.userId }).execute();
  await db.insertInto("organizationMatchingSettings").values({ organizationId: org.id, realizaColeta: true }).execute();
  await db.insertInto("organizationServiceAreas").values({ organizationId: org.id, city, state }).execute();
  return { owner, orgId: org.id };
}

async function makeOpportunity(sourceId: number, adminUserId: number, quantity: number, city: string, state: string) {
  const opp = await createTestOpportunityRegistry(sourceId, adminUserId, { title: "Doação de alimentos não perecíveis", status: "aguardando_destinacao" });
  await db
    .updateTable("opportunityRegistry")
    .set({ category: "Alimentos", unit: "kg", quantity: String(quantity), locationCity: city, locationState: state })
    .where("id", "=", opp.id)
    .execute();
  return opp.id;
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

describe("elegivel_sem_quantidade — candidato pontuado, sem quantidade restante", () => {
  it("teste 1: quantidade esgota no primeiro candidato (score 100); segundo (score 97.75, >=90) fica elegivel_sem_quantidade, sem allocation", async () => {
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);

    const a = await fullyConfiguredOrg("Belo Horizonte", "MG", "critica", 20); // score projetado: 100
    const b = await fullyConfiguredOrg("Belo Horizonte", "MG", "alta", 20); // score projetado: 97.75

    const opportunityId = await makeOpportunity(source.id, admin.userId, 20, "Belo Horizonte", "MG");
    const result = await runMatchingForOpportunity(opportunityId, admin.userId);

    // Só A recebeu alocação — quantidade (20) esgotada nele.
    expect(result.allocationsCreated).toHaveLength(1);
    expect(result.allocationsCreated[0].organizationId).toBe(a.orgId);

    const evalA = await getEvaluation(opportunityId, a.orgId);
    expect(evalA.decision).toBe("atribuido_automatico");
    expect(evalA.allocationId).not.toBeNull();
    expect(Number(evalA.finalScore)).toBe(100);

    const evalB = await getEvaluation(opportunityId, b.orgId);
    expect(evalB.decision).toBe("elegivel_sem_quantidade");
    expect(evalB.allocationId).toBeNull();
    expect(Number(evalB.finalScore)).toBe(97.75); // score real calculado, nunca 0/null/genérico
    expect(evalB.algorithmVersion).toBe("1.3");
    expect(ALGORITHM_VERSION).toBe("1.3");

    // Nenhuma allocation para B.
    const allocationsForB = await db.selectFrom("opportunityAllocations").select(["id"]).where("opportunityRegistryId", "=", opportunityId).where("organizationId", "=", b.orgId).execute();
    expect(allocationsForB).toHaveLength(0);
  });

  it("teste 2: tres candidatos depois do esgotamento — todos com elegivel_sem_quantidade", async () => {
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);

    const winner = await fullyConfiguredOrg("Belo Horizonte", "MG", "critica", 20); // consome toda a quantidade
    const b = await fullyConfiguredOrg("Belo Horizonte", "MG", "critica", 20);
    const c = await fullyConfiguredOrg("Belo Horizonte", "MG", "critica", 20);
    const d = await fullyConfiguredOrg("Belo Horizonte", "MG", "critica", 20);

    const opportunityId = await makeOpportunity(source.id, admin.userId, 20, "Belo Horizonte", "MG");
    const result = await runMatchingForOpportunity(opportunityId, admin.userId);

    expect(result.allocationsCreated).toHaveLength(1); // só o primeiro do desempate consome os 20

    const evaluations = await db
      .selectFrom("matchEvaluations")
      .select(["organizationId", "decision", "finalScore"])
      .where("opportunityRegistryId", "=", opportunityId)
      .execute();
    expect(evaluations).toHaveLength(4); // os 4 candidatos, todos com score empatado (100), TODOS avaliados e logados

    const winnerOrgId = result.allocationsCreated[0].organizationId;
    const losers = evaluations.filter((e) => e.organizationId !== winnerOrgId);
    expect(losers).toHaveLength(3);
    for (const loser of losers) {
      expect(loser.decision).toBe("elegivel_sem_quantidade");
      expect(Number(loser.finalScore)).toBe(100); // mesmo score do vencedor — só não teve quantidade
    }
    const winnerEval = evaluations.find((e) => e.organizationId === winnerOrgId)!;
    expect(winnerEval.decision).toBe("atribuido_automatico");

    // Confirma que todos os 4 organizationIds esperados aparecem.
    const allOrgIds = [winner.orgId, b.orgId, c.orgId, d.orgId].sort((x, y) => x - y);
    const evaluatedOrgIds = evaluations.map((e) => e.organizationId).sort((x, y) => x - y);
    expect(evaluatedOrgIds).toEqual(allOrgIds);
  });

  it("teste 4: allocation count nao aumenta quando remaining=0, mesmo com candidatos elegiveis restantes", async () => {
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    await fullyConfiguredOrg("Belo Horizonte", "MG", "critica", 20);
    await fullyConfiguredOrg("Belo Horizonte", "MG", "critica", 20);
    await fullyConfiguredOrg("Belo Horizonte", "MG", "critica", 20);

    const opportunityId = await makeOpportunity(source.id, admin.userId, 20, "Belo Horizonte", "MG");
    await runMatchingForOpportunity(opportunityId, admin.userId);

    const allocationCount = await db.selectFrom("opportunityAllocations").select((eb) => eb.fn.countAll().as("c")).where("opportunityRegistryId", "=", opportunityId).executeTakeFirstOrThrow();
    expect(Number(allocationCount.c)).toBe(1); // exatamente 1, nunca mais que isso
  });

  it("teste 6: fluxos antigos permanecem intactos (<70 descartado; 70-89,99 com quantidade = proposto; >=90 com quantidade = atribuido_automatico)", async () => {
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);

    // Quantidade generosa: nenhum candidato deste teste esgota `remaining`,
    // isolando só os 3 fluxos antigos (nenhuma interação com elegivel_sem_quantidade).
    const opportunityId = await makeOpportunity(source.id, admin.userId, 1000, "Belo Horizonte", "MG");

    // score baixo (< 70): sem nenhuma configuração de capacidade/logística/área.
    const ownerLow = await createAuthenticatedUser();
    const orgLow = await createTestOrganization(ownerLow.userId, { city: "Outra Cidade", state: "YY" });
    await db.insertInto("needs").values({ organizationId: orgLow.id, title: "Alimentos não perecíveis para doação", quantityNeeded: "1000", unit: "kg", priority: "baixa", status: "aberta", createdByUserId: ownerLow.userId }).execute();

    // score médio (70-89,99): capacidade/logística/área configuradas, mas cidade diferente (proximidade mais baixa).
    const ownerMedium = await fullyConfiguredOrg("Contagem", "MG", "media", 20);

    // score alto (>=90): tudo maximizado.
    const ownerHigh = await fullyConfiguredOrg("Belo Horizonte", "MG", "critica", 20);

    const result = await runMatchingForOpportunity(opportunityId, admin.userId);

    const evalLow = await getEvaluation(opportunityId, orgLow.id);
    expect(evalLow.decision).toBe("descartado");
    expect(Number(evalLow.finalScore)).toBeLessThan(70);

    const evalMedium = await getEvaluation(opportunityId, ownerMedium.orgId);
    expect(evalMedium.decision).toBe("proposto");
    expect(Number(evalMedium.finalScore)).toBeGreaterThanOrEqual(70);
    expect(Number(evalMedium.finalScore)).toBeLessThan(90);

    const evalHigh = await getEvaluation(opportunityId, ownerHigh.orgId);
    expect(evalHigh.decision).toBe("atribuido_automatico");
    expect(Number(evalHigh.finalScore)).toBeGreaterThanOrEqual(90);

    expect(result.allocationsCreated).toHaveLength(2); // médio (proposta) + alto (aceita)
  });
});
