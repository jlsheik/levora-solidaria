/**
 * Prova comportamental de que os 3 critérios ligados ao motor de matching
 * (capacidade_armazenamento, capacidade_logistica, raio_atendimento) usam
 * dado real quando a organização configura, respeitam compatibilidade de
 * categoria+unidade (achado de auditoria corrigido nesta etapa), exigem
 * cidade+UF juntos para "mesma localidade" (idem), e nunca vazam dado
 * entre organizações. Ver relatório de auditoria entregue no chat.
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
// desta sessão (não é um bug introduzido aqui).
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

async function createOpportunity(
  sourceId: number,
  adminUserId: number,
  overrides: {
    category?: string;
    unit?: string;
    quantity?: number;
    locationCity?: string | null;
    locationState?: string | null;
  } = {}
) {
  const opportunity = await createTestOpportunityRegistry(sourceId, adminUserId, { status: "aguardando_destinacao" });
  await db
    .updateTable("opportunityRegistry")
    .set({
      title: "Doação de alimentos não perecíveis",
      category: overrides.category ?? "Alimentos",
      unit: overrides.unit ?? "kg",
      quantity: String(overrides.quantity ?? 50),
      locationCity: overrides.locationCity ?? "Belo Horizonte",
      locationState: overrides.locationState ?? "MG",
    })
    .where("id", "=", opportunity.id)
    .execute();
  return opportunity.id;
}

describe("capacidade de armazenamento — compatibilidade de categoria + unidade", () => {
  async function setup() {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { city: "Belo Horizonte", state: "MG" });
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    await db
      .insertInto("needs")
      .values({ organizationId: org.id, title: "Alimentos não perecíveis", quantityNeeded: "30", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId })
      .execute();
    return { owner, orgId: org.id, admin, sourceId: source.id };
  }

  it("5.1 capacidade suficiente (maior que a quantidade solicitada) → score 100", async () => {
    const { owner, orgId, admin, sourceId } = await setup();
    await db.insertInto("organizationCapacities").values({ organizationId: orgId, category: "Alimentos", unit: "kg", maxCapacity: "1000", createdByUserId: owner.userId }).execute();

    const opportunityId = await createOpportunity(sourceId, admin.userId, { quantity: 50 });
    await runMatchingForOpportunity(opportunityId, admin.userId);

    expect((await getCriteria(opportunityId, orgId)).capacidadeArmazenamento.score).toBe(100);
  });

  it("5.2 capacidade exatamente igual à quantidade solicitada → score 100", async () => {
    const { owner, orgId, admin, sourceId } = await setup();
    await db.insertInto("organizationCapacities").values({ organizationId: orgId, category: "Alimentos", unit: "kg", maxCapacity: "50", createdByUserId: owner.userId }).execute();

    const opportunityId = await createOpportunity(sourceId, admin.userId, { quantity: 50 });
    await runMatchingForOpportunity(opportunityId, admin.userId);

    expect((await getCriteria(opportunityId, orgId)).capacidadeArmazenamento.score).toBe(100);
  });

  it("5.3 capacidade insuficiente (disponível zerado) → score 0, nunca null", async () => {
    const { owner, orgId, admin, sourceId } = await setup();
    const item = await createTestInventoryItem(orgId, owner.userId, { name: "Arroz", unit: "kg" });
    await db.updateTable("inventoryItems").set({ category: "Alimentos" }).where("id", "=", item.id).execute();
    await db.insertInto("organizationCapacities").values({ organizationId: orgId, category: "Alimentos", unit: "kg", maxCapacity: "100", createdByUserId: owner.userId }).execute();
    // Estoque já consome toda a capacidade declarada.
    await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: "100", createdByUserId: owner.userId }).execute();

    const opportunityId = await createOpportunity(sourceId, admin.userId, { quantity: 50 });
    await runMatchingForOpportunity(opportunityId, admin.userId);

    expect((await getCriteria(opportunityId, orgId)).capacidadeArmazenamento.score).toBe(0);
  });

  it("5.4 consumo parcial do estoque: usa o DISPONÍVEL (máximo − uso), nunca o máximo bruto", async () => {
    const { owner, orgId, admin, sourceId } = await setup();
    const item = await createTestInventoryItem(orgId, owner.userId, { name: "Arroz", unit: "kg" });
    await db.updateTable("inventoryItems").set({ category: "Alimentos" }).where("id", "=", item.id).execute();
    await db.insertInto("organizationCapacities").values({ organizationId: orgId, category: "Alimentos", unit: "kg", maxCapacity: "500", createdByUserId: owner.userId }).execute();
    await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: "200", createdByUserId: owner.userId }).execute();

    // Disponível real = 500 − 200 = 300. Pedido de 400: se o algoritmo
    // usasse o bruto (500), o resultado seria 100 (500 >= 400) — o mesmo
    // valor que um bug produziria. Pedir MAIS que o disponível real (300)
    // mas MENOS que o bruto (500) é o único jeito de um teste realmente
    // distinguir "usou disponível" de "usou bruto por engano".
    const opportunityId = await createOpportunity(sourceId, admin.userId, { quantity: 400 });
    await runMatchingForOpportunity(opportunityId, admin.userId);

    // 300/400*100 = 75 — só é possível chegar nesse número usando 300 (disponível), nunca 500 (bruto).
    expect((await getCriteria(opportunityId, orgId)).capacidadeArmazenamento.score).toBe(75);
  });

  it("5.5 categoria diferente → não aplicável (null), nunca usa a capacidade de outra categoria", async () => {
    const { owner, orgId, admin, sourceId } = await setup();
    await db.insertInto("organizationCapacities").values({ organizationId: orgId, category: "Alimentos", unit: "kg", maxCapacity: "1000", createdByUserId: owner.userId }).execute();

    const opportunityId = await createOpportunity(sourceId, admin.userId, { category: "Medicamentos", unit: "kg", quantity: 50 });
    await runMatchingForOpportunity(opportunityId, admin.userId);

    expect((await getCriteria(opportunityId, orgId)).capacidadeArmazenamento.score).toBeNull();
  });

  it("5.6 [BLOQUEADOR] unidade diferente com MESMA categoria → não aplicável (null), NUNCA compara os números", async () => {
    const { owner, orgId, admin, sourceId } = await setup();
    // Capacidade: Alimentos / kg / 500.
    await db.insertInto("organizationCapacities").values({ organizationId: orgId, category: "Alimentos", unit: "kg", maxCapacity: "500", createdByUserId: owner.userId }).execute();

    // Oportunidade: Alimentos / unidade / 300 — mesma categoria, unidade diferente.
    const opportunityId = await createOpportunity(sourceId, admin.userId, { category: "Alimentos", unit: "unidade", quantity: 300 });
    await runMatchingForOpportunity(opportunityId, admin.userId);

    const score = (await getCriteria(opportunityId, orgId)).capacidadeArmazenamento.score;
    expect(score).toBeNull();
    expect(score).not.toBe(100); // nunca "500 kg cobre 300 unidade"
    expect(score).not.toBe(0); // também não é "incapaz" — é dado incomparável, não incapacidade
  });

  it("5.7 capacidade declarada como zero → score 0, sem divisão por zero nem NaN", async () => {
    const { owner, orgId, admin, sourceId } = await setup();
    await db.insertInto("organizationCapacities").values({ organizationId: orgId, category: "Alimentos", unit: "kg", maxCapacity: "0", createdByUserId: owner.userId }).execute();

    const opportunityId = await createOpportunity(sourceId, admin.userId, { quantity: 50 });
    await runMatchingForOpportunity(opportunityId, admin.userId);

    const score = (await getCriteria(opportunityId, orgId)).capacidadeArmazenamento.score;
    expect(score).toBe(0);
    expect(Number.isFinite(score)).toBe(true);
  });

  it("5.8 estoques de unidades diferentes na mesma categoria NUNCA se somam (isolados por categoria+unidade)", async () => {
    const { owner, orgId, admin, sourceId } = await setup();
    const kgItem = await createTestInventoryItem(orgId, owner.userId, { name: "Arroz a granel", unit: "kg" });
    await db.updateTable("inventoryItems").set({ category: "Alimentos" }).where("id", "=", kgItem.id).execute();
    const unidadeItem = await createTestInventoryItem(orgId, owner.userId, { name: "Latas de conserva", unit: "unidade" });
    await db.updateTable("inventoryItems").set({ category: "Alimentos" }).where("id", "=", unidadeItem.id).execute();

    // 5 kg (relevante) e 100 unidade (categoria igual, unidade diferente —
    // NUNCA deveria contaminar o cálculo de "kg").
    await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: kgItem.id, type: "entrada", delta: "5", createdByUserId: owner.userId }).execute();
    await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: unidadeItem.id, type: "entrada", delta: "100", createdByUserId: owner.userId }).execute();

    await db.insertInto("organizationCapacities").values({ organizationId: orgId, category: "Alimentos", unit: "kg", maxCapacity: "10", createdByUserId: owner.userId }).execute();

    const opportunityId = await createOpportunity(sourceId, admin.userId, { category: "Alimentos", unit: "kg", quantity: 5 });
    await runMatchingForOpportunity(opportunityId, admin.userId);

    // Se os 100 "unidade" contaminassem o cálculo: disponível = 10 - (5+100) = -95 → score 0.
    // Correto (isolado por unidade): disponível = 10 - 5 = 5 → score 100 (5 >= 5 solicitado).
    expect((await getCriteria(opportunityId, orgId)).capacidadeArmazenamento.score).toBe(100);
  });

  it("5.9 capacidade parcialmente insuficiente (disponível > 0 mas menor que o solicitado) → score intermediário coerente", async () => {
    const { owner, orgId, admin, sourceId } = await setup();
    await db.insertInto("organizationCapacities").values({ organizationId: orgId, category: "Alimentos", unit: "kg", maxCapacity: "100", createdByUserId: owner.userId }).execute();

    const opportunityId = await createOpportunity(sourceId, admin.userId, { quantity: 150 });
    await runMatchingForOpportunity(opportunityId, admin.userId);

    const score = (await getCriteria(opportunityId, orgId)).capacidadeArmazenamento.score!;
    expect(score).toBeCloseTo((100 / 150) * 100, 2); // ~66.67
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });

  it("organização sem NENHUMA capacidade declarada → não aplicável (null), nunca vira score 0", async () => {
    const { admin, sourceId, orgId } = await setup();
    const opportunityId = await createOpportunity(sourceId, admin.userId, { quantity: 50 });
    await runMatchingForOpportunity(opportunityId, admin.userId);

    expect((await getCriteria(opportunityId, orgId)).capacidadeArmazenamento.score).toBeNull();
  });
});

describe("capacidade logística — ausência de configuração nunca vira 'false' automaticamente", () => {
  it("realiza_coleta=true → score 100; realiza_coleta=false → score 0; sem linha nenhuma → null (não aplicável)", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { city: "Belo Horizonte", state: "MG" });
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    await db
      .insertInto("needs")
      .values({ organizationId: org.id, title: "Alimentos não perecíveis", quantityNeeded: "30", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId })
      .execute();

    // Sem NENHUMA linha em organization_matching_settings ainda.
    const noConfigOpp = await createOpportunity(source.id, admin.userId);
    await runMatchingForOpportunity(noConfigOpp, admin.userId);
    expect((await getCriteria(noConfigOpp, org.id)).capacidadeLogistica.score).toBeNull();

    await db.insertInto("organizationMatchingSettings").values({ organizationId: org.id, realizaColeta: true }).execute();
    const trueOpp = await createOpportunity(source.id, admin.userId);
    await runMatchingForOpportunity(trueOpp, admin.userId);
    expect((await getCriteria(trueOpp, org.id)).capacidadeLogistica.score).toBe(100);

    await db.updateTable("organizationMatchingSettings").set({ realizaColeta: false }).where("organizationId", "=", org.id).execute();
    const falseOpp = await createOpportunity(source.id, admin.userId);
    await runMatchingForOpportunity(falseOpp, admin.userId);
    expect((await getCriteria(falseOpp, org.id)).capacidadeLogistica.score).toBe(0);
  });
});

describe("área de atendimento — cidade E estado juntos (cidades homônimas em UFs diferentes não geram falso positivo)", () => {
  async function setupWithArea(city: string, state: string) {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { city: "Belo Horizonte", state: "MG" });
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    await db
      .insertInto("needs")
      .values({ organizationId: org.id, title: "Alimentos não perecíveis", quantityNeeded: "30", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId })
      .execute();
    await db.insertInto("organizationServiceAreas").values({ organizationId: org.id, city, state }).execute();
    return { orgId: org.id, admin, sourceId: source.id };
  }

  it("6.A mesma cidade e mesmo estado → score 100", async () => {
    const { orgId, admin, sourceId } = await setupWithArea("Contagem", "MG");
    const opportunityId = await createOpportunity(sourceId, admin.userId, { locationCity: "Contagem", locationState: "MG" });
    await runMatchingForOpportunity(opportunityId, admin.userId);
    expect((await getCriteria(opportunityId, orgId)).raioAtendimento.score).toBe(100);
  });

  it("6.B mesma cidade, ESTADO DIFERENTE (homônimo real do Brasil) → NUNCA é tratado como a mesma localidade", async () => {
    const { orgId, admin, sourceId } = await setupWithArea("Bom Jesus", "MG");
    const opportunityId = await createOpportunity(sourceId, admin.userId, { locationCity: "Bom Jesus", locationState: "BA" });
    await runMatchingForOpportunity(opportunityId, admin.userId);
    expect((await getCriteria(opportunityId, orgId)).raioAtendimento.score).not.toBe(100);
    expect((await getCriteria(opportunityId, orgId)).raioAtendimento.score).toBe(20); // cidade não bate, estado (MG vs BA) também não
  });

  it("6.C cidade diferente, mesmo estado → score 60 (preservado)", async () => {
    const { orgId, admin, sourceId } = await setupWithArea("Contagem", "MG");
    const opportunityId = await createOpportunity(sourceId, admin.userId, { locationCity: "Uberlândia", locationState: "MG" });
    await runMatchingForOpportunity(opportunityId, admin.userId);
    expect((await getCriteria(opportunityId, orgId)).raioAtendimento.score).toBe(60);
  });

  it("6.D capitalização e acentuação diferentes continuam batendo (normalize)", async () => {
    const { orgId, admin, sourceId } = await setupWithArea("São Paulo", "SP");
    const opportunityId = await createOpportunity(sourceId, admin.userId, { locationCity: "SAO PAULO", locationState: "sp" });
    await runMatchingForOpportunity(opportunityId, admin.userId);
    expect((await getCriteria(opportunityId, orgId)).raioAtendimento.score).toBe(100);
  });

  it("6.E espaços extras não quebram a comparação (trim adicionado ao normalize)", async () => {
    const { orgId, admin, sourceId } = await setupWithArea("Contagem", "MG");
    const opportunityId = await createOpportunity(sourceId, admin.userId, { locationCity: "  Contagem  ", locationState: "MG" });
    await runMatchingForOpportunity(opportunityId, admin.userId);
    expect((await getCriteria(opportunityId, orgId)).raioAtendimento.score).toBe(100);
  });

  it("cidade/estado diferentes (sem nenhuma relação) → score 20", async () => {
    const { orgId, admin, sourceId } = await setupWithArea("Contagem", "MG");
    const opportunityId = await createOpportunity(sourceId, admin.userId, { locationCity: "Salvador", locationState: "BA" });
    await runMatchingForOpportunity(opportunityId, admin.userId);
    expect((await getCriteria(opportunityId, orgId)).raioAtendimento.score).toBe(20);
  });

  it("organização sem NENHUMA área declarada → não aplicável (null), nunca 0 nem 20 por padrão", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { city: "Belo Horizonte", state: "MG" });
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    await db
      .insertInto("needs")
      .values({ organizationId: org.id, title: "Alimentos não perecíveis", quantityNeeded: "30", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId })
      .execute();

    const opportunityId = await createOpportunity(source.id, admin.userId);
    await runMatchingForOpportunity(opportunityId, admin.userId);
    expect((await getCriteria(opportunityId, org.id)).raioAtendimento.score).toBeNull();
  });
});

describe("isolamento multi-tenant DO MOTOR DE MATCHING (não só dos endpoints CRUD)", () => {
  it("capacidade, estoque, área e configuração de logística da organização B nunca entram no cálculo da organização A", async () => {
    // Organização A: "pobre" de propósito — nada declarado, ou declarado
    // desfavoravelmente. Se houvesse vazamento de B, o resultado de A
    // mudaria para melhor.
    const ownerA = await createAuthenticatedUser();
    const orgA = await createTestOrganization(ownerA.userId, { city: "Belo Horizonte", state: "MG" });
    await db
      .insertInto("needs")
      .values({ organizationId: orgA.id, title: "Alimentos não perecíveis", quantityNeeded: "30", unit: "kg", priority: "media", status: "aberta", createdByUserId: ownerA.userId })
      .execute();
    // Sem organization_capacities, sem organization_matching_settings, sem
    // organization_service_areas para A.

    // Organização B: extremamente favorável em tudo — se vazasse para A,
    // os 3 critérios de A deixariam de ser "null".
    const ownerB = await createAuthenticatedUser();
    const orgB = await createTestOrganization(ownerB.userId, { city: "Belo Horizonte", state: "MG" });
    await db
      .insertInto("needs")
      .values({ organizationId: orgB.id, title: "Alimentos não perecíveis", quantityNeeded: "30", unit: "kg", priority: "media", status: "aberta", createdByUserId: ownerB.userId })
      .execute();
    await db.insertInto("organizationCapacities").values({ organizationId: orgB.id, category: "Alimentos", unit: "kg", maxCapacity: "999999", createdByUserId: ownerB.userId }).execute();
    await db.insertInto("organizationMatchingSettings").values({ organizationId: orgB.id, realizaColeta: true }).execute();
    await db.insertInto("organizationServiceAreas").values({ organizationId: orgB.id, city: "Belo Horizonte", state: "MG" }).execute();

    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunityId = await createOpportunity(source.id, admin.userId, { quantity: 50 });

    await runMatchingForOpportunity(opportunityId, admin.userId);

    const criteriaA = await getCriteria(opportunityId, orgA.id);
    const criteriaB = await getCriteria(opportunityId, orgB.id);

    // B, favorecida, tem os 3 critérios com dado real.
    expect(criteriaB.capacidadeArmazenamento.score).toBe(100);
    expect(criteriaB.capacidadeLogistica.score).toBe(100);
    expect(criteriaB.raioAtendimento.score).toBe(100);

    // A, sem NENHUMA configuração própria, continua "não aplicável" em
    // todos os 3 — a fartura de B não vazou para A de jeito nenhum.
    expect(criteriaA.capacidadeArmazenamento.score).toBeNull();
    expect(criteriaA.capacidadeLogistica.score).toBeNull();
    expect(criteriaA.raioAtendimento.score).toBeNull();
  });
});

describe("matching automático — elevação de confiança com configuração completa (regressão do comportamento já existente)", () => {
  it("configurar tudo favoravelmente eleva uma oportunidade de confiança média para atribuição automática de alta confiança", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { city: "Belo Horizonte", state: "MG" });
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);

    // Prioridade baixa deliberadamente, pra ficar em confiança média sem os
    // critérios novos.
    await db
      .insertInto("needs")
      .values({ organizationId: org.id, title: "Alimentos não perecíveis", quantityNeeded: "30", unit: "kg", priority: "baixa", status: "aberta", createdByUserId: owner.userId })
      .execute();

    const opportunityWithoutConfig = await createOpportunity(source.id, admin.userId);
    const before = await runMatchingForOpportunity(opportunityWithoutConfig, admin.userId);
    expect(before.allocationsCreated[0]?.status).toBe("proposta"); // confiança média, não alta

    await db.insertInto("organizationCapacities").values({ organizationId: org.id, category: "Alimentos", unit: "kg", maxCapacity: "1000", createdByUserId: owner.userId }).execute();
    await db.insertInto("organizationMatchingSettings").values({ organizationId: org.id, realizaColeta: true }).execute();
    await db.insertInto("organizationServiceAreas").values({ organizationId: org.id, city: "Belo Horizonte", state: "MG" }).execute();

    const opportunityWithConfig = await createOpportunity(source.id, admin.userId);
    const after = await runMatchingForOpportunity(opportunityWithConfig, admin.userId);
    expect(after.allocationsCreated[0]?.status).toBe("aceita"); // agora alta confiança
    expect(after.allocationsCreated[0]?.score).toBeGreaterThan(before.allocationsCreated[0]?.score ?? 0);
  });
});

describe("opportunity_registry.quantity nunca pode ser zero (proteção em duas camadas)", () => {
  it("o banco rejeita quantity=0 mesmo contornando a validação do Zod (INSERT direto)", async () => {
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);

    await expect(
      db.insertInto("opportunityRegistry").values({ sourceId: source.id, title: "Teste", quantity: "0", discoveredByUserId: admin.userId }).execute()
    ).rejects.toThrow(/opportunity_registry_quantity_positive_chk/);
  });

  it("o banco rejeita quantity negativa também", async () => {
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);

    await expect(
      db.insertInto("opportunityRegistry").values({ sourceId: source.id, title: "Teste", quantity: "-5", discoveredByUserId: admin.userId }).execute()
    ).rejects.toThrow(/opportunity_registry_quantity_positive_chk/);
  });

  it("quantity nula continua permitida (quantidade desconhecida é um estado real, distinto de zero)", async () => {
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);

    const [row] = await db
      .insertInto("opportunityRegistry")
      .values({ sourceId: source.id, title: "Teste", quantity: null, discoveredByUserId: admin.userId })
      .returning(["id"])
      .execute();
    expect(row.id).toBeGreaterThan(0);
  });
});
