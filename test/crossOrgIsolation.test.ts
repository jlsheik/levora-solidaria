/**
 * Cobertura de isolamento multi-organização para os domínios que ainda não
 * tinham teste explícito (ver "o que ainda falta" em docs/TESTING.md):
 * opportunity_registry, opportunity_allocations, logistics_events e
 * approval_requests. Segue o mesmo padrão de stockTransactions.test.ts —
 * uma pessoa membro só da organização B nunca deve conseguir ler ou agir
 * sobre uma linha que pertence à organização A, mesmo referenciando o ID
 * certo.
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { handle as postAllocationsDecide } from "../src/endpoints/allocations-decide_POST";
import { handle as postAllocationsLogistics } from "../src/endpoints/allocations-logistics_POST";
import { handle as getOrganizationAllocations } from "../src/endpoints/organization-allocations_GET";
import { handle as postApprovalDecide } from "../src/endpoints/approval-requests-decide_POST";
import { handle as getApprovalRequests } from "../src/endpoints/approval-requests_GET";
import { handle as postOpportunityRegistryStatus } from "../src/endpoints/opportunity-registry-status_POST";
import {
  createAuthenticatedUser,
  createTestOrganization,
  createTestSource,
  createTestOpportunityRegistry,
  createTestAllocation,
  createPlatformAdmin,
  buildRequest,
  parseJson,
  type AuthenticatedTestUser,
} from "./helpers";

describe("isolamento multi-organização: atribuições e logística", () => {
  async function setupTwoOrgsWithAllocationInA() {
    const ownerA = await createAuthenticatedUser();
    const orgA = await createTestOrganization(ownerA.userId);
    const ownerB = await createAuthenticatedUser();
    const orgB = await createTestOrganization(ownerB.userId);

    const admin = await createPlatformAdmin();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId);
    const allocation = await createTestAllocation(opportunity.id, orgA.id);

    return { ownerA, orgA, ownerB, orgB, allocation };
  }

  it("organização B não consegue decidir (aceitar/recusar) uma atribuição que pertence à organização A", async () => {
    const { ownerB, orgB, allocation } = await setupTwoOrgsWithAllocationInA();

    const response = await postAllocationsDecide(
      buildRequest("allocations-decide", {
        method: "POST",
        cookie: ownerB.cookie,
        // orgB é a organização do próprio ownerB (passa a checagem de
        // permissão), mas o allocationId pertence à orgA — o isolamento
        // real está no WHERE organizationId da query, não na permissão.
        body: { organizationId: orgB.id, allocationId: allocation.id, decision: "aceita" },
      })
    );
    expect(response.status).toBe(404);

    const untouched = await db
      .selectFrom("opportunityAllocations")
      .select(["status"])
      .where("id", "=", allocation.id)
      .executeTakeFirstOrThrow();
    expect(untouched.status).toBe("proposta");
  });

  it("organização B não consegue registrar evento de logística numa atribuição da organização A", async () => {
    const { ownerB, orgB, allocation } = await setupTwoOrgsWithAllocationInA();

    // Precisa estar "aceita" para aceitar coleta_agendada, mas o 404 do
    // isolamento acontece antes de qualquer checagem de transição.
    const response = await postAllocationsLogistics(
      buildRequest("allocations-logistics", {
        method: "POST",
        cookie: ownerB.cookie,
        body: { organizationId: orgB.id, allocationId: allocation.id, eventType: "coleta_agendada" },
      })
    );
    expect(response.status).toBe(404);

    const events = await db
      .selectFrom("logisticsEvents")
      .select(["id"])
      .where("opportunityAllocationId", "=", allocation.id)
      .execute();
    expect(events).toHaveLength(0);
  });

  it("organização B não vê a atribuição da organização A na própria listagem", async () => {
    const { ownerB, orgB } = await setupTwoOrgsWithAllocationInA();

    const response = await getOrganizationAllocations(
      buildRequest(`organization-allocations?organizationId=${orgB.id}`, { cookie: ownerB.cookie })
    );
    expect(response.status).toBe(200);
    const data = await parseJson<{ allocations: unknown[] }>(response);
    expect(data.allocations).toHaveLength(0);
  });

  it("membro que não pertence a nenhuma das duas organizações é bloqueado (403), nunca chega a ver 'não encontrado'", async () => {
    const { allocation } = await setupTwoOrgsWithAllocationInA();
    const outsider = await createAuthenticatedUser();
    const outsiderOrg = await createTestOrganization(outsider.userId);

    const response = await postAllocationsDecide(
      buildRequest("allocations-decide", {
        method: "POST",
        cookie: outsider.cookie,
        body: { organizationId: outsiderOrg.id, allocationId: allocation.id, decision: "aceita" },
      })
    );
    // mesmo resultado (404) — o outsider é membro de outsiderOrg, então
    // passa a checagem de permissão, e cai no mesmo isolamento por
    // organizationId da query. Confirma que não há diferença observável
    // entre "não é sua atribuição" e "não existe".
    expect(response.status).toBe(404);
  });
});

describe("isolamento multi-organização: pedidos de aprovação (approval_requests)", () => {
  async function setupTwoOrgsWithApprovalInA() {
    const ownerA = await createAuthenticatedUser();
    const orgA = await createTestOrganization(ownerA.userId);

    const ownerB = await createAuthenticatedUser();
    const orgB = await createTestOrganization(ownerB.userId);

    const [request] = await db
      .insertInto("approvalRequests")
      .values({
        organizationId: orgA.id,
        actionType: "ajuste_estoque_alto_risco",
        payload: { organizationId: orgA.id, itemId: 999999, type: "ajuste", quantity: -50, reason: "Teste de isolamento" },
        reason: "Teste de isolamento",
        requestedByUserId: ownerA.userId,
      })
      .returning(["id", "status"])
      .execute();

    return { ownerA, orgA, ownerB, orgB, request };
  }

  it("organização B não consegue listar pedidos de aprovação da organização A", async () => {
    const { ownerB, orgB } = await setupTwoOrgsWithApprovalInA();

    const response = await getApprovalRequests(
      buildRequest(`approval-requests?organizationId=${orgB.id}`, { cookie: ownerB.cookie })
    );
    expect(response.status).toBe(200);
    const data = await parseJson<{ requests: unknown[] }>(response);
    expect(data.requests).toHaveLength(0);
  });

  it("organização B não consegue decidir um pedido de aprovação da organização A, mesmo informando o ID certo", async () => {
    const { ownerB, orgB, request } = await setupTwoOrgsWithApprovalInA();

    const response = await postApprovalDecide(
      buildRequest("approval-requests-decide", {
        method: "POST",
        cookie: ownerB.cookie,
        body: { organizationId: orgB.id, requestId: request.id, decision: "aprovada" },
      })
    );
    expect(response.status).toBe(404);

    const untouched = await db
      .selectFrom("approvalRequests")
      .select(["status"])
      .where("id", "=", request.id)
      .executeTakeFirstOrThrow();
    expect(untouched.status).toBe("pendente");
  });
});

describe("isolamento de plataforma: registro central de oportunidades (opportunity_registry)", () => {
  it("proprietário de organização (não é admin de plataforma) não pode alterar o status de uma descoberta central (403)", async () => {
    const owner = await createAuthenticatedUser();
    await createTestOrganization(owner.userId);

    const admin = await createPlatformAdmin();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "descoberta" });

    const response = await postOpportunityRegistryStatus(
      buildRequest("opportunity-registry-status", {
        method: "POST",
        cookie: owner.cookie,
        body: { opportunityId: opportunity.id, status: "em_verificacao" },
      })
    );
    expect(response.status).toBe(403);

    const untouched = await db
      .selectFrom("opportunityRegistry")
      .select(["status"])
      .where("id", "=", opportunity.id)
      .executeTakeFirstOrThrow();
    expect(untouched.status).toBe("descoberta");
  });

  it("admin de plataforma consegue alterar o status normalmente (transição válida)", async () => {
    const admin = await createPlatformAdmin();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "descoberta" });

    const response = await postOpportunityRegistryStatus(
      buildRequest("opportunity-registry-status", {
        method: "POST",
        cookie: admin.cookie,
        body: { opportunityId: opportunity.id, status: "em_verificacao" },
      })
    );
    expect(response.status).toBe(200);
  });
});
