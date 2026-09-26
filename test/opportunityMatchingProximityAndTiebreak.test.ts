/**
 * Correção cirúrgica pós-auditoria final: proximidade da sede agora exige
 * cidade+UF juntos (mesma correção já aplicada em raio_atendimento), e o
 * desempate de finalScore idêntico agora é determinístico por
 * organizationId (identificador técnico estável), não pela ordem
 * incidental do Postgres. Nenhum peso, threshold ou fórmula foi alterado.
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { runMatchingForOpportunity } from "../src/helpers/opportunityMatching";
import {
  createAuthenticatedUser,
  createTestOrganization,
  createTestSource,
  createTestOpportunityRegistry,
  type AuthenticatedTestUser,
} from "./helpers";

interface CriterionResult {
  score: number | null;
  weight: number;
  detail: string;
}

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

async function setupOrgWithNeed(
  city: string,
  state: string,
  overrides: { priority?: "baixa" | "media" | "alta" | "critica"; quantityNeeded?: number } = {}
) {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId, { city, state });
  await db
    .insertInto("needs")
    .values({
      organizationId: org.id,
      title: "Alimentos não perecíveis",
      quantityNeeded: String(overrides.quantityNeeded ?? 30),
      unit: "kg",
      priority: overrides.priority ?? "media",
      status: "aberta",
      createdByUserId: owner.userId,
    })
    .execute();
  return { owner, orgId: org.id };
}

async function createOpportunity(sourceId: number, adminUserId: number, city: string, state: string, quantity = 1000) {
  const opportunity = await createTestOpportunityRegistry(sourceId, adminUserId, { status: "aguardando_destinacao" });
  await db
    .updateTable("opportunityRegistry")
    .set({
      title: "Doação de alimentos não perecíveis",
      category: "Alimentos",
      unit: "kg",
      quantity: String(quantity),
      locationCity: city,
      locationState: state,
    })
    .where("id", "=", opportunity.id)
    .execute();
  return opportunity.id;
}

describe("proximidade da sede — cidade + UF juntos (correção pós-auditoria)", () => {
  let admin: AuthenticatedTestUser;
  let sourceId: number;

  async function setup() {
    admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    sourceId = source.id;
  }

  it("1. mesma cidade + mesma UF → 100", async () => {
    await setup();
    const { orgId } = await setupOrgWithNeed("Contagem", "MG");
    const opportunityId = await createOpportunity(sourceId, admin.userId, "Contagem", "MG");
    await runMatchingForOpportunity(opportunityId, admin.userId);
    expect((await getCriteria(opportunityId, orgId)).proximidade.score).toBe(100);
  });

  it("2. cidade diferente + mesma UF → 60", async () => {
    await setup();
    const { orgId } = await setupOrgWithNeed("Contagem", "MG");
    const opportunityId = await createOpportunity(sourceId, admin.userId, "Uberlândia", "MG");
    await runMatchingForOpportunity(opportunityId, admin.userId);
    expect((await getCriteria(opportunityId, orgId)).proximidade.score).toBe(60);
  });

  it("3. mesma cidade + UF diferente → 20 (nunca 100 — este é o caso obrigatório do achado de auditoria)", async () => {
    await setup();
    // Exatamente o exemplo da auditoria: "Bom Jesus" existe em vários
    // estados brasileiros.
    const { orgId } = await setupOrgWithNeed("Bom Jesus", "MG");
    const opportunityId = await createOpportunity(sourceId, admin.userId, "Bom Jesus", "PI");
    await runMatchingForOpportunity(opportunityId, admin.userId);
    const score = (await getCriteria(opportunityId, orgId)).proximidade.score;
    expect(score).not.toBe(100);
    expect(score).toBe(20);
  });

  it("4. cidade diferente + UF diferente → 20", async () => {
    await setup();
    const { orgId } = await setupOrgWithNeed("Contagem", "MG");
    const opportunityId = await createOpportunity(sourceId, admin.userId, "Salvador", "BA");
    await runMatchingForOpportunity(opportunityId, admin.userId);
    expect((await getCriteria(opportunityId, orgId)).proximidade.score).toBe(20);
  });

  it("5-7. maiúsculas/minúsculas, espaços laterais e acentos não alteram o resultado", async () => {
    await setup();
    const { orgId } = await setupOrgWithNeed("São Paulo", "SP");
    const opportunityId = await createOpportunity(sourceId, admin.userId, "  SAO PAULO  ", "sp");
    await runMatchingForOpportunity(opportunityId, admin.userId);
    expect((await getCriteria(opportunityId, orgId)).proximidade.score).toBe(100);
  });

  it("oportunidade sem localização → score neutro (50), comportamento preservado", async () => {
    await setup();
    const { orgId } = await setupOrgWithNeed("Contagem", "MG");
    const opportunityId = await createOpportunity(sourceId, admin.userId, "Contagem", "MG");
    await db.updateTable("opportunityRegistry").set({ locationCity: null, locationState: null }).where("id", "=", opportunityId).execute();
    await runMatchingForOpportunity(opportunityId, admin.userId);
    expect((await getCriteria(opportunityId, orgId)).proximidade.score).toBe(50);
  });
});

describe("desempate determinístico de finalScore idêntico (correção pós-auditoria)", () => {
  let admin: AuthenticatedTestUser;
  let sourceId: number;

  async function setup() {
    admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    sourceId = source.id;
  }

  it("caso 1: scores diferentes — a organização com score maior sempre é processada primeiro (match_evaluations.id menor)", async () => {
    await setup();
    // B é criada primeiro (organizationId menor) mas tem urgência mais
    // baixa — se o desempate por organizationId estivesse sendo usado
    // indevidamente como critério de ORDENAÇÃO PRINCIPAL, isso inverteria
    // o resultado. O finalScore continua mandando primeiro.
    const orgLowScore = await setupOrgWithNeed("Belo Horizonte", "MG", { priority: "baixa" });
    const orgHighScore = await setupOrgWithNeed("Belo Horizonte", "MG", { priority: "critica" });
    const opportunityId = await createOpportunity(sourceId, admin.userId, "Belo Horizonte", "MG");

    await runMatchingForOpportunity(opportunityId, admin.userId);

    const rows = await db
      .selectFrom("matchEvaluations")
      .select(["organizationId", "finalScore", "id"])
      .where("opportunityRegistryId", "=", opportunityId)
      .orderBy("id", "asc")
      .execute();
    expect(rows).toHaveLength(2);
    // A organização com score maior (orgHighScore) é inserida primeiro,
    // mesmo tendo organizationId maior (foi criada depois).
    expect(rows[0].organizationId).toBe(orgHighScore.orgId);
    expect(rows[1].organizationId).toBe(orgLowScore.orgId);
    expect(Number(rows[0].finalScore)).toBeGreaterThan(Number(rows[1].finalScore));
  });

  it("caso 2, 4 e 5: duas organizações com finalScore IDÊNTICO — ordem decidida só pelo organizationId, score não é alterado, sem vazamento de dado entre elas", async () => {
    await setup();
    // Mesma cidade/UF, mesma prioridade, mesma quantidade — nenhum critério
    // novo (capacidade/logística/área) configurado para nenhuma das duas,
    // então ambas ficam com EXATAMENTE o mesmo finalScore.
    const orgFirst = await setupOrgWithNeed("Belo Horizonte", "MG");
    const orgSecond = await setupOrgWithNeed("Belo Horizonte", "MG");
    const opportunityId = await createOpportunity(sourceId, admin.userId, "Belo Horizonte", "MG");

    await runMatchingForOpportunity(opportunityId, admin.userId);

    const rows = await db
      .selectFrom("matchEvaluations")
      .select(["organizationId", "finalScore", "id"])
      .where("opportunityRegistryId", "=", opportunityId)
      .orderBy("id", "asc")
      .execute();
    expect(rows).toHaveLength(2);

    // Score idêntico entre as duas — o desempate NUNCA mexe no finalScore.
    expect(Number(rows[0].finalScore)).toBe(Number(rows[1].finalScore));

    // Ordem determinada exclusivamente pelo organizationId (menor primeiro).
    expect(rows[0].organizationId).toBe(Math.min(orgFirst.orgId, orgSecond.orgId));
    expect(rows[1].organizationId).toBe(Math.max(orgFirst.orgId, orgSecond.orgId));

    // Sem vazamento: cada organização só reflete os próprios dados (nenhuma
    // das duas tem capacidade/logística/área configurada — ambas "não
    // aplicável" nos 3 critérios novos, nunca herdando dado da outra).
    const criteriaFirst = await getCriteria(opportunityId, rows[0].organizationId);
    const criteriaSecond = await getCriteria(opportunityId, rows[1].organizationId);
    expect(criteriaFirst.capacidadeArmazenamento.score).toBeNull();
    expect(criteriaSecond.capacidadeArmazenamento.score).toBeNull();
  });

  it("caso 3: dois cenários de empate estruturalmente equivalentes (organizações diferentes) produzem a mesma REGRA de ordem — menor organizationId sempre primeiro (reprodutibilidade)", async () => {
    await setup();

    // Par 1
    const pair1First = await setupOrgWithNeed("Belo Horizonte", "MG");
    const pair1Second = await setupOrgWithNeed("Belo Horizonte", "MG");
    const opportunityA = await createOpportunity(sourceId, admin.userId, "Belo Horizonte", "MG");
    await runMatchingForOpportunity(opportunityA, admin.userId);
    const rowsA = await db
      .selectFrom("matchEvaluations")
      .select(["organizationId"])
      .where("opportunityRegistryId", "=", opportunityA)
      .orderBy("id", "asc")
      .execute();

    // Par 2 — organizações NOVAS (não pode reaproveitar as do par 1: já
    // estariam em existingOrgIds de qualquer oportunidade anterior delas),
    // mas nas MESMAS condições estruturais (mesma cidade/UF, mesma
    // prioridade, mesma quantidade) — testa se a REGRA de desempate (menor
    // organizationId primeiro) se repete de forma equivalente, não se os
    // MESMOS IDs se repetem (isso seria impossível, são auto-incrementais).
    const pair2First = await setupOrgWithNeed("Belo Horizonte", "MG");
    const pair2Second = await setupOrgWithNeed("Belo Horizonte", "MG");
    const opportunityB = await createOpportunity(sourceId, admin.userId, "Belo Horizonte", "MG");
    await runMatchingForOpportunity(opportunityB, admin.userId);
    const rowsB = await db
      .selectFrom("matchEvaluations")
      .select(["organizationId"])
      .where("opportunityRegistryId", "=", opportunityB)
      .orderBy("id", "asc")
      .execute();

    expect(rowsA.map((r) => r.organizationId)).toEqual([pair1First.orgId, pair1Second.orgId].sort((a, b) => a - b));
    // opportunityB não exclui as organizações do par 1 (suas necessidades
    // continuam "abertas" — só a atribuição é por oportunidade) — as 4
    // organizações empatam entre si e devem sair em ordem crescente de
    // organizationId, confirmando que a mesma regra vale com mais
    // candidatos empatados, não só com 2.
    expect(rowsB.map((r) => r.organizationId)).toEqual(
      [pair1First.orgId, pair1Second.orgId, pair2First.orgId, pair2Second.orgId].sort((a, b) => a - b)
    );
  });

  it("caso 6: três ou mais organizações com o mesmo finalScore continuam em ordem determinística por organizationId", async () => {
    await setup();
    const orgs = [
      await setupOrgWithNeed("Belo Horizonte", "MG"),
      await setupOrgWithNeed("Belo Horizonte", "MG"),
      await setupOrgWithNeed("Belo Horizonte", "MG"),
      await setupOrgWithNeed("Belo Horizonte", "MG"),
    ];
    const opportunityId = await createOpportunity(sourceId, admin.userId, "Belo Horizonte", "MG");

    await runMatchingForOpportunity(opportunityId, admin.userId);

    const rows = await db
      .selectFrom("matchEvaluations")
      .select(["organizationId", "finalScore", "id"])
      .where("opportunityRegistryId", "=", opportunityId)
      .orderBy("id", "asc")
      .execute();
    expect(rows).toHaveLength(4);

    const scores = rows.map((r) => Number(r.finalScore));
    expect(new Set(scores).size).toBe(1); // todas empatadas de verdade

    const expectedOrder = orgs.map((o) => o.orgId).sort((a, b) => a - b);
    expect(rows.map((r) => r.organizationId)).toEqual(expectedOrder);
  });
});
