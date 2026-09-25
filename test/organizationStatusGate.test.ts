import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { handle as postStockTransaction } from "../src/endpoints/stock-transactions_POST";
import { handle as postInventoryItem } from "../src/endpoints/inventory-items_POST";
import { handle as getNeeds } from "../src/endpoints/needs_GET";
import { handle as getOrganizationMembers } from "../src/endpoints/organization-members_GET";
import { handle as getAuditLog } from "../src/endpoints/audit-log_GET";
import { handle as getImpactReport } from "../src/endpoints/impact-report_GET";
import { handle as getApprovalRequests } from "../src/endpoints/approval-requests_GET";
import { handle as getOrganizationInvites } from "../src/endpoints/organization-invites_GET";
import { createAuthenticatedUser, createTestOrganization, createTestInventoryItem, buildRequest, parseJson } from "./helpers";

describe("organização não aprovada não pode executar ações restritas por permissão", () => {
  it("bloqueia (403) lançar estoque numa organização 'em_analise'", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { status: "em_analise" });
    const item = await createTestInventoryItem(org.id, owner.userId);

    const response = await postStockTransaction(
      buildRequest("stock-transactions", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: org.id, itemId: item.id, type: "entrada", quantity: 10, reason: "Teste" },
      })
    );
    expect(response.status).toBe(403);
    const data = await parseJson<{ message: string }>(response);
    expect(data.message).toContain("aprovação");
  });

  it("bloqueia (403) cadastrar item de inventário numa organização 'suspensa'", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { status: "suspensa" });

    const response = await postInventoryItem(
      buildRequest("inventory-items", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: org.id, name: "Item qualquer", unit: "unidade" },
      })
    );
    expect(response.status).toBe(403);
  });

  it("permite lançar estoque normalmente assim que a organização é aprovada", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { status: "em_analise" });
    const item = await createTestInventoryItem(org.id, owner.userId);

    const blocked = await postStockTransaction(
      buildRequest("stock-transactions", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, itemId: item.id, type: "entrada", quantity: 10, reason: "Teste" } })
    );
    expect(blocked.status).toBe(403);

    await db.updateTable("organizations").set({ status: "ativa" }).where("id", "=", org.id).execute();

    const allowed = await postStockTransaction(
      buildRequest("stock-transactions", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, itemId: item.id, type: "entrada", quantity: 10, reason: "Teste" } })
    );
    expect(allowed.status).toBe(200);
  });

  it("continua permitindo leitura (requireOrganizationMembership, sem permissão) mesmo com a organização 'em_analise'", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { status: "em_analise" });

    // Leituras usam requireOrganizationMembership (sem checar status da
    // organização, de propósito) — o dono precisa continuar vendo os
    // próprios dados enquanto espera aprovação.
    const needsResponse = await getNeeds(buildRequest(`needs?organizationId=${org.id}`, { cookie: owner.cookie }));
    expect(needsResponse.status).toBe(200);

    const membersResponse = await getOrganizationMembers(buildRequest(`organization-members?organizationId=${org.id}`, { cookie: owner.cookie }));
    expect(membersResponse.status).toBe(200);
  });

  it("continua permitindo LEITURAS RESTRITAS POR PERMISSÃO (requirePermissionToRead) mesmo com a organização 'em_analise' — regressão: essas 4 rotas ficaram bloqueadas por engano quando a checagem de status foi adicionada dentro de requirePermission", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { status: "em_analise" });

    const auditResponse = await getAuditLog(buildRequest(`audit-log?organizationId=${org.id}`, { cookie: owner.cookie }));
    expect(auditResponse.status).toBe(200);

    const impactResponse = await getImpactReport(
      buildRequest(`impact-report?organizationId=${org.id}&startDate=2026-01-01&endDate=2026-12-31`, { cookie: owner.cookie })
    );
    expect(impactResponse.status).toBe(200);

    const approvalsResponse = await getApprovalRequests(buildRequest(`approval-requests?organizationId=${org.id}`, { cookie: owner.cookie }));
    expect(approvalsResponse.status).toBe(200);

    const invitesResponse = await getOrganizationInvites(buildRequest(`organization-invites?organizationId=${org.id}`, { cookie: owner.cookie }));
    expect(invitesResponse.status).toBe(200);
  });
});
