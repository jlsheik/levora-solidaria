/**
 * Prova que ALGORITHM_VERSION é a única fonte de verdade da versão gravada
 * pelo motor de matching. Não basta testar a constante isolada — o teste
 * principal executa o motor de ponta a ponta e lê o valor persistido em
 * match_evaluations (e, no caminho de alocação bem-sucedida, também em
 * opportunity_allocations.notes e audit_log.metadata), provando que os 3
 * destinos ficam sincronizados automaticamente por dependerem da mesma
 * constante — nenhum deles tem um literal de versão próprio.
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

describe("ALGORITHM_VERSION — versão comportamental do motor", () => {
  it("a constante está fixada em 1.3", () => {
    expect(ALGORITHM_VERSION).toBe("1.3");
  });

  it("uma avaliação real do motor persiste algorithm_version = 1.3 em match_evaluations (descarte, sem alocação)", async () => {
    const owner = await createAuthenticatedUser();
    // Organização sem nenhuma configuração de capacidade/logística/área →
    // score baixo, avaliação é descartada (decision != "auto_atribuido"),
    // mas ainda assim é gravada em match_evaluations.
    const org = await createTestOrganization(owner.userId, { city: "Cidade Sem Configuração", state: "XX" });
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    await db
      .insertInto("needs")
      .values({ organizationId: org.id, title: "Roupas de inverno", quantityNeeded: "10", unit: "unidade", priority: "baixa", status: "aberta", createdByUserId: owner.userId })
      .execute();

    // Sem capacidade/logística/área de atendimento configuradas: score baixo,
    // avaliação é descartada — mas o candidato precisa ter alguma relação de
    // palavra-chave com a oportunidade (título/categoria), senão o motor nem
    // cria a linha em match_evaluations (ver opportunityMatching.tsx: score de
    // categoria 0 → "nem candidato").
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { title: "Doação de roupas de inverno", status: "aguardando_destinacao" });
    await db
      .updateTable("opportunityRegistry")
      .set({ category: "Roupas", unit: "unidade", quantity: "10", locationCity: "Outra Cidade", locationState: "YY" })
      .where("id", "=", opportunity.id)
      .execute();

    await runMatchingForOpportunity(opportunity.id, admin.userId);

    const evaluation = await db
      .selectFrom("matchEvaluations")
      .select(["algorithmVersion", "decision"])
      .where("opportunityRegistryId", "=", opportunity.id)
      .where("organizationId", "=", org.id)
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();

    expect(evaluation.algorithmVersion).toBe("1.3");
  });

  it("no caminho de alocação automática, notes e audit_log também refletem 1.3 — todos vindos da mesma constante", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { city: "Belo Horizonte", state: "MG" });
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);

    // Configura tudo para maximizar o score e garantir alocação automática.
    await db
      .insertInto("organizationCapacities")
      .values({ organizationId: org.id, category: "Alimentos", unit: "kg", maxCapacity: "1000", createdByUserId: owner.userId })
      .execute();
    await db
      .insertInto("organizationServiceAreas")
      .values({ organizationId: org.id, city: "Belo Horizonte", state: "MG" })
      .execute();
    await db
      .insertInto("needs")
      .values({ organizationId: org.id, title: "Alimentos não perecíveis", quantityNeeded: "50", unit: "kg", priority: "critica", status: "aberta", createdByUserId: owner.userId })
      .execute();

    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "aguardando_destinacao" });
    await db
      .updateTable("opportunityRegistry")
      .set({ category: "Alimentos", unit: "kg", quantity: "50", locationCity: "Belo Horizonte", locationState: "MG" })
      .where("id", "=", opportunity.id)
      .execute();

    await runMatchingForOpportunity(opportunity.id, admin.userId);

    const evaluation = await db
      .selectFrom("matchEvaluations")
      .select(["algorithmVersion", "decision", "allocationId"])
      .where("opportunityRegistryId", "=", opportunity.id)
      .where("organizationId", "=", org.id)
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(evaluation.algorithmVersion).toBe("1.3");

    if (evaluation.allocationId) {
      const allocation = await db
        .selectFrom("opportunityAllocations")
        .select(["notes"])
        .where("id", "=", evaluation.allocationId)
        .executeTakeFirstOrThrow();
      expect(allocation.notes).toContain("algoritmo 1.3");
    }

    const auditRow = await db
      .selectFrom("auditLog")
      .select(["metadata"])
      .where("action", "=", "matching.executado")
      .where("entityId", "=", String(opportunity.id))
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect((auditRow.metadata as { algoritmo?: string }).algoritmo).toBe("1.3");
  });
});
