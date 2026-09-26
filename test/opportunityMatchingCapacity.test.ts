/**
 * Prova de que os 3 critérios recém-ligados (capacidade_armazenamento,
 * capacidade_logistica, raio_atendimento) realmente afetam o resultado do
 * matching quando a organização configura os dados novos — e que
 * continuam "não aplicável" quando não configura (sem penalizar quem
 * ainda não configurou, ver comentário no topo de opportunityMatching.tsx).
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { runMatchingForOpportunity } from "../src/helpers/opportunityMatching";
import {
  createAuthenticatedUser,
  createTestOrganization,
  createTestSource,
  createTestOpportunityRegistry,
  createTestInventoryItem,
  type AuthenticatedTestUser,
} from "./helpers";

interface CriterionResult {
  score: number | null;
  weight: number;
  detail: string;
}

// O FlootCamelCasePlugin (src/helpers/db.tsx) transforma recursivamente as
// chaves de QUALQUER objeto simples numa linha lida via Kysely — inclusive
// as chaves de dentro de uma coluna JSONB, não só nomes de coluna. Os
// critérios são gravados com chave "capacidade_armazenamento" (ver
// opportunityMatching.tsx), mas voltam como "capacidadeArmazenamento"
// depois de uma leitura via `db.selectFrom(...)`. Isto já era assim antes
// desta sessão (não é um bug introduzido aqui) — só ninguém tinha lido uma
// chave específica de `criteria` programaticamente até agora.
async function getCriteria(opportunityId: number, organizationId: number): Promise<Record<string, CriterionResult>> {
  const row = await db
    .selectFrom("matchEvaluations")
    .select(["criteria"])
    .where("opportunityRegistryId", "=", opportunityId)
    .where("organizationId", "=", organizationId)
    .orderBy("id", "desc")
    .executeTakeFirstOrThrow();
  return row.criteria as unknown as Record<string, CriterionResult>;
}

describe("matching automático — critérios de capacidade/logística/área de atendimento", () => {
  let owner: AuthenticatedTestUser;
  let orgId: number;
  let admin: AuthenticatedTestUser;
  let sourceId: number;

  async function setup() {
    owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { city: "Belo Horizonte", state: "MG" });
    orgId = org.id;
    admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    sourceId = source.id;
  }

  async function createNeed(title: string, quantityNeeded: number) {
    const [need] = await db
      .insertInto("needs")
      .values({ organizationId: orgId, title, quantityNeeded: String(quantityNeeded), unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId })
      .returning(["id"])
      .execute();
    return need.id;
  }

  async function createOpportunity(overrides: { locationCity?: string | null; locationState?: string | null } = {}) {
    const opportunity = await createTestOpportunityRegistry(sourceId, admin.userId, { status: "aguardando_destinacao" });
    await db
      .updateTable("opportunityRegistry")
      .set({
        title: "Doação de alimentos não perecíveis",
        category: "Alimentos",
        quantity: "50",
        locationCity: overrides.locationCity ?? "Belo Horizonte",
        locationState: overrides.locationState ?? "MG",
      })
      .where("id", "=", opportunity.id)
      .execute();
    return opportunity.id;
  }

  it("sem NENHUMA configuração nova, os 3 critérios ficam 'não aplicável' (score null) e não entram no cálculo", async () => {
    await setup();
    await createNeed("Alimentos não perecíveis", 30);
    const opportunityId = await createOpportunity();

    await runMatchingForOpportunity(opportunityId, admin.userId);

    const criteria = await getCriteria(opportunityId, orgId);
    expect(criteria.capacidadeArmazenamento.score).toBeNull();
    expect(criteria.capacidadeLogistica.score).toBeNull();
    expect(criteria.raioAtendimento.score).toBeNull();
  });

  it("capacidade declarada com folga dá score 100 nesse critério; capacidade já esgotada dá score 0", async () => {
    await setup();
    const item = await createTestInventoryItem(orgId, owner.userId, { name: "Arroz" });
    await db.updateTable("inventoryItems").set({ category: "Alimentos" }).where("id", "=", item.id).execute();

    await db
      .insertInto("organizationCapacities")
      .values({ organizationId: orgId, category: "Alimentos", unit: "kg", maxCapacity: "1000", createdByUserId: owner.userId })
      .execute();

    await createNeed("Alimentos não perecíveis", 30);
    const opportunityId = await createOpportunity();
    await runMatchingForOpportunity(opportunityId, admin.userId);

    const criteria = await getCriteria(opportunityId, orgId);
    expect(criteria.capacidadeArmazenamento.score).toBe(100); // 1000 disponível vs 50 ofertado

    // Agora esgota a capacidade com estoque já existente e roda de novo
    // para outra oportunidade equivalente.
    await db
      .insertInto("stockTransactions")
      .values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: "1000", createdByUserId: owner.userId })
      .execute();
    const secondOpportunityId = await createOpportunity();
    await runMatchingForOpportunity(secondOpportunityId, admin.userId);

    const criteria2 = await getCriteria(secondOpportunityId, orgId);
    expect(criteria2.capacidadeArmazenamento.score).toBe(0); // 1000 usado == 1000 declarado, disponivel 0
  });

  it("realiza_coleta=true dá score 100 em capacidade_logistica; false dá score 0", async () => {
    await setup();
    await createNeed("Alimentos não perecíveis", 30);

    await db.insertInto("organizationMatchingSettings").values({ organizationId: orgId, realizaColeta: true }).execute();
    const opportunityId = await createOpportunity();
    await runMatchingForOpportunity(opportunityId, admin.userId);
    expect((await getCriteria(opportunityId, orgId)).capacidadeLogistica.score).toBe(100);

    await db.updateTable("organizationMatchingSettings").set({ realizaColeta: false }).where("organizationId", "=", orgId).execute();
    const opportunityId2 = await createOpportunity();
    await runMatchingForOpportunity(opportunityId2, admin.userId);
    expect((await getCriteria(opportunityId2, orgId)).capacidadeLogistica.score).toBe(0);
  });

  it("área de atendimento: mesma cidade declarada = 100, só mesmo estado = 60, cidade/estado diferentes = 20", async () => {
    await setup();
    await createNeed("Alimentos não perecíveis", 30);
    await db.insertInto("organizationServiceAreas").values({ organizationId: orgId, city: "Contagem", state: "MG" }).execute();

    const sameCityOpp = await createOpportunity({ locationCity: "Contagem", locationState: "MG" });
    await runMatchingForOpportunity(sameCityOpp, admin.userId);
    expect((await getCriteria(sameCityOpp, orgId)).raioAtendimento.score).toBe(100);

    const sameStateOpp = await createOpportunity({ locationCity: "Uberlândia", locationState: "MG" });
    await runMatchingForOpportunity(sameStateOpp, admin.userId);
    expect((await getCriteria(sameStateOpp, orgId)).raioAtendimento.score).toBe(60);

    const differentStateOpp = await createOpportunity({ locationCity: "Salvador", locationState: "BA" });
    await runMatchingForOpportunity(differentStateOpp, admin.userId);
    expect((await getCriteria(differentStateOpp, orgId)).raioAtendimento.score).toBe(20);
  });

  it("configurar tudo favoravelmente eleva uma oportunidade de confiança média para atribuição automática de alta confiança", async () => {
    await setup();
    // Prioridade baixa deliberadamente, pra ficar em confiança média sem os
    // critérios novos (mesmo cenário do teste de idempotência já existente).
    await db
      .insertInto("needs")
      .values({ organizationId: orgId, title: "Alimentos não perecíveis", quantityNeeded: "30", unit: "kg", priority: "baixa", status: "aberta", createdByUserId: owner.userId })
      .execute();

    const item = await createTestInventoryItem(orgId, owner.userId, { name: "Feijão" });
    await db.updateTable("inventoryItems").set({ category: "Alimentos" }).where("id", "=", item.id).execute();

    const opportunityWithoutConfig = await createOpportunity();
    const before = await runMatchingForOpportunity(opportunityWithoutConfig, admin.userId);
    expect(before.allocationsCreated[0]?.status).toBe("proposta"); // confiança média, não alta

    // Agora configura tudo favoravelmente para uma SEGUNDA oportunidade
    // equivalente.
    await db
      .insertInto("organizationCapacities")
      .values({ organizationId: orgId, category: "Alimentos", unit: "kg", maxCapacity: "1000", createdByUserId: owner.userId })
      .execute();
    await db.insertInto("organizationMatchingSettings").values({ organizationId: orgId, realizaColeta: true }).execute();
    await db.insertInto("organizationServiceAreas").values({ organizationId: orgId, city: "Belo Horizonte", state: "MG" }).execute();

    const opportunityWithConfig = await createOpportunity();
    const after = await runMatchingForOpportunity(opportunityWithConfig, admin.userId);
    expect(after.allocationsCreated[0]?.status).toBe("aceita"); // agora alta confiança
    expect(after.allocationsCreated[0]?.score).toBeGreaterThan(before.allocationsCreated[0]?.score ?? 0);
  });
});
