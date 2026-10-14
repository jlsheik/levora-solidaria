import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { handle } from "../src/endpoints/opportunities-status_POST";
import { createAuthenticatedUser, createTestOrganization, buildRequest, parseJson } from "./helpers";

/**
 * Fase 65 — este endpoint nunca tinha teste dedicado antes. A auditoria
 * global de classificação de erros encontrou aqui o único lugar do
 * projeto que lançava um `Error` genérico esperando 409 (via comparação
 * de texto frágil num terceiro argumento de `buildErrorResponse`, nunca
 * via `instanceof`) — corrigido com `ConflictError`. Este teste prova o
 * contrato real de ponta a ponta, não só a classificação isolada do
 * helper (já coberta em test/errorResponse.test.ts).
 */
describe("opportunities-status_POST — conflito real (oportunidade já recebida)", () => {
  it("tentar trocar o status de uma oportunidade já recebida devolve 409, não 400", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);

    const [opportunity] = await db
      .insertInto("donationOpportunities")
      .values({
        organizationId: org.id,
        title: "Doação já recebida",
        donorName: "Doador de teste",
        status: "recebida",
        createdByUserId: owner.userId,
      })
      .returning(["id"])
      .execute();

    const response = await handle(
      buildRequest("v1/opportunities-status", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: org.id, opportunityId: opportunity.id, status: "registrada" },
      })
    );

    expect(response.status).toBe(409);
    const body = await parseJson<{ message: string }>(response);
    expect(body.message).toBe("Esta oportunidade já foi recebida e não pode ter o status alterado por aqui");
  });
});
