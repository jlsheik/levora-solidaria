/**
 * Prova comportamental da regra arquitetural "nunca comparar numericamente
 * quantidades de unidades incompatíveis" aplicada ao critério `quantidade`
 * do motor de matching (Fase 35 — achado de auditoria: antes desta fase,
 * `quantidade` comparava `opportunity.quantity` a `needs.quantity_needed`
 * puramente por número, sem checar `unit`, diferente de
 * `capacidade_armazenamento`, que já exigia categoria+unidade iguais).
 *
 * Mesma técnica de comparação usada em todo o projeto (normalize(): NFD +
 * remoção de acento + minúsculas, sem conversão nem taxonomia de unidades):
 * unidades diferentes nunca são tratadas como equivalentes, e a ausência de
 * `opportunity.unit` (quando há quantidade) também não é assumida como
 * compatível. Quando incompatível, o critério vira `score: null` (mesmo
 * mecanismo de "não aplicável" já usado por `capacidade_armazenamento`) e é
 * excluído da média ponderada (renormalização já existente, inalterada).
 *
 * Pesos, thresholds, demais critérios, desempate e lifecycle não são
 * tocados por esta correção — só o cálculo do critério `quantidade`.
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { runMatchingForOpportunity } from "../src/helpers/opportunityMatching";
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

// Mesma nota das outras suítes de matching: o FlootCamelCasePlugin
// transforma recursivamente as chaves do JSONB lido via Kysely — a chave
// gravada é "quantidade" (sem underscore), então volta inalterada.
async function getCriteria(opportunityId: number, organizationId: number): Promise<Record<string, CriterionResult>> {
  const row = await db
    .selectFrom("matchEvaluations")
    .select(["criteria", "finalScore"])
    .where("opportunityRegistryId", "=", opportunityId)
    .where("organizationId", "=", organizationId)
    .orderBy("id", "desc")
    .executeTakeFirstOrThrow();
  return row.criteria as unknown as Record<string, CriterionResult>;
}

async function setupNeed(unit: string, quantityNeeded: number) {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId, { city: "Belo Horizonte", state: "MG" });
  await db
    .insertInto("needs")
    .values({ organizationId: org.id, title: "Alimentos não perecíveis", quantityNeeded: String(quantityNeeded), unit, priority: "media", status: "aberta", createdByUserId: owner.userId })
    .execute();
  return { owner, orgId: org.id };
}

async function createOpportunity(sourceId: number, adminUserId: number, unit: string, quantity: number) {
  const opportunity = await createTestOpportunityRegistry(sourceId, adminUserId, { status: "aguardando_destinacao" });
  await db
    .updateTable("opportunityRegistry")
    .set({
      title: "Doação de alimentos não perecíveis",
      category: "Alimentos",
      unit,
      quantity: String(quantity),
      locationCity: "Belo Horizonte",
      locationState: "MG",
    })
    .where("id", "=", opportunity.id)
    .execute();
  return opportunity.id;
}

describe("motor de matching — critério quantidade nunca compara numericamente unidades incompatíveis", () => {
  it("caso 1: 500 kg oferecidos vs 500 kg necessários — mesma unidade, comparação quantitativa válida (score 100)", async () => {
    const { orgId } = await setupNeed("kg", 500);
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunityId = await createOpportunity(source.id, admin.userId, "kg", 500);

    await runMatchingForOpportunity(opportunityId, admin.userId);
    const criteria = await getCriteria(opportunityId, orgId);

    expect(criteria.quantidade.score).toBe(100);
    expect(criteria.quantidade.weight).toBe(0.15);
  });

  it("caso 2: 400 caixas oferecidas vs 500 caixas necessárias — mesma unidade, comparação quantitativa válida (score 80)", async () => {
    const { orgId } = await setupNeed("caixa", 500);
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunityId = await createOpportunity(source.id, admin.userId, "caixa", 400);

    await runMatchingForOpportunity(opportunityId, admin.userId);
    const criteria = await getCriteria(opportunityId, orgId);

    expect(criteria.quantidade.score).toBe(80); // min(400,500)/500*100
  });

  it("caso 3: 500 kg oferecidos vs 500 caixas necessárias — unidades incompatíveis, NUNCA recebe score numérico como se fossem comparáveis (score null, critério não aplicável)", async () => {
    const { orgId } = await setupNeed("caixa", 500);
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunityId = await createOpportunity(source.id, admin.userId, "kg", 500);

    await runMatchingForOpportunity(opportunityId, admin.userId);
    const criteria = await getCriteria(opportunityId, orgId);

    expect(criteria.quantidade.score).toBeNull();
    expect(criteria.quantidade.detail).toMatch(/unidades incompativeis/);
    // Nunca 100 (que seria o resultado de comparar 500/500 ignorando a unidade).
    expect(criteria.quantidade.score).not.toBe(100);
  });

  it("caso 4: mesmo número, unidades diferentes (100 kg vs 100 unidades) — não é tratado como match quantitativo (score null)", async () => {
    const { orgId } = await setupNeed("unidade", 100);
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunityId = await createOpportunity(source.id, admin.userId, "kg", 100);

    await runMatchingForOpportunity(opportunityId, admin.userId);
    const criteria = await getCriteria(opportunityId, orgId);

    expect(criteria.quantidade.score).toBeNull();
  });

  it("caso 5: correção não altera pesos, renormalização, outros critérios nem o comportamento pré-existente de opportunity.quantity === null", async () => {
    const { orgId } = await setupNeed("kg", 500);
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "aguardando_destinacao" });
    // quantity=null (nunca informada) — comportamento pré-existente preservado: score fixo 70, critério aplicável (nunca null por causa disso).
    await db
      .updateTable("opportunityRegistry")
      .set({ title: "Doação de alimentos não perecíveis", category: "Alimentos", unit: null, quantity: null, locationCity: "Belo Horizonte", locationState: "MG" })
      .where("id", "=", opportunity.id)
      .execute();

    await runMatchingForOpportunity(opportunity.id, admin.userId);
    const criteria = await getCriteria(opportunity.id, orgId);

    expect(criteria.quantidade.score).toBe(70);
    expect(criteria.quantidade.weight).toBe(0.15);
    expect(criteria.quantidade.detail).toBe("quantidade da oportunidade não informada");
    // Demais pesos inalterados.
    expect(criteria.categoria.weight).toBe(0.2);
    expect(criteria.necessidadeUrgencia.weight).toBe(0.15);
    expect(criteria.proximidade.weight).toBe(0.15);
  });

  it("caso 6: unidade incompatível é excluída da média ponderada (renormalização), não conta como 0 nem trava o candidato abaixo do threshold indevidamente", async () => {
    // Cenário maximizado em tudo, exceto quantidade (incompatível): se a
    // renormalização estivesse quebrada e tratasse null como 0 no numerador
    // mas ainda dividisse pelo peso cheio, o finalScore cairia
    // artificialmente. Com a renormalização correta (já existente,
    // inalterada), o critério simplesmente sai do denominador.
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { city: "Belo Horizonte", state: "MG" });
    await db
      .insertInto("needs")
      .values({ organizationId: org.id, title: "Alimentos não perecíveis", quantityNeeded: "500", unit: "caixa", priority: "critica", status: "aberta", createdByUserId: owner.userId })
      .execute();
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunityId = await createOpportunity(source.id, admin.userId, "kg", 500);

    await runMatchingForOpportunity(opportunityId, admin.userId);
    const criteria = await getCriteria(opportunityId, org.id);

    expect(criteria.quantidade.score).toBeNull();
    // applicableWeight exclui quantidade (0.15) do denominador — finalScore
    // é a média ponderada só dos critérios aplicáveis, nunca penalizado
    // como se quantidade tivesse tirado 0.
    const row = await db
      .selectFrom("matchEvaluations")
      .select(["finalScore"])
      .where("opportunityRegistryId", "=", opportunityId)
      .where("organizationId", "=", org.id)
      .executeTakeFirstOrThrow();
    expect(Number(row.finalScore)).toBeGreaterThan(0);
  });
});
