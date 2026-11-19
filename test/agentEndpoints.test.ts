import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/helpers/db";
import { handle as getAlerts } from "../src/endpoints/integrity-alerts_GET";
import { handle as postAlertUpdate } from "../src/endpoints/integrity-alerts-update_POST";
import { handle as getExceptions } from "../src/endpoints/exception-queue_GET";
import { handle as postExceptionDecide } from "../src/endpoints/exception-queue-decide_POST";
import { handle as getControls } from "../src/endpoints/automation-controls_GET";
import { handle as postControls } from "../src/endpoints/automation-controls_POST";
import { handle as postPlatformControls } from "../src/endpoints/platform-automation-controls_POST";
import { handle as postStockTransaction } from "../src/endpoints/stock-transactions_POST";
import { handle as postOpportunity } from "../src/endpoints/opportunities_POST";
import { handle as postOpportunityRegistry } from "../src/endpoints/opportunity-registry_POST";
import { handle as postAllocationsReceive } from "../src/endpoints/allocations-receive_POST";
import { createIntegrityAlert } from "../src/helpers/integrityAlerts";
import { ensureAgentPrincipal } from "../src/helpers/agentRegistry";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import type { MembershipRole } from "../src/helpers/schema";
import {
  createAuthenticatedUser,
  createPlatformAdmin,
  createTestOrganization,
  createTestInventoryItem,
  addMembership,
  buildRequest,
  parseJson,
  type AuthenticatedTestUser,
} from "./helpers";

async function member(orgId: number, role: MembershipRole) {
  const person = await createAuthenticatedUser();
  await addMembership(orgId, person.userId, role);
  return person;
}

function get(path: string, actor: AuthenticatedTestUser) {
  return buildRequest(path, { cookie: actor.cookie });
}

function post(path: string, actor: AuthenticatedTestUser, body: unknown) {
  return buildRequest(path, { method: "POST", cookie: actor.cookie, body });
}

async function seedAlert(orgId: number, extra: { dedupeKey?: string; title?: string } = {}) {
  const principal = await ensureAgentPrincipal(db, "sentinela-integridade", null);
  const result = await db.transaction().execute((trx) =>
    createIntegrityAlert(trx, {
      organizationId: orgId,
      level: "alto_risco",
      category: "divergencia_inventario",
      title: extra.title ?? "Saldo diverge",
      detail: { fisico: 100, sistema: 121 },
      dedupeKey: extra.dedupeKey,
      agentPrincipalId: principal.id,
    })
  );
  return result.id as string;
}

describe("endpoints de alertas de integridade", () => {
  let owner: AuthenticatedTestUser;
  let orgId: number;

  beforeEach(async () => {
    owner = await createAuthenticatedUser();
    orgId = (await createTestOrganization(owner.userId)).id;
  });

  it("proprietário e administrador leem os alertas abertos da própria organização, com o nome do agente", async () => {
    const admin = await member(orgId, "administrador");
    await seedAlert(orgId);
    for (const actor of [owner, admin]) {
      const response = await getAlerts(get(`integrity-alerts?organizationId=${orgId}`, actor));
      expect(response.status).toBe(200);
      const data = await parseJson<{ alerts: Array<{ title: string; agentName: string | null; level: string }> }>(response);
      expect(data.alerts).toHaveLength(1);
      expect(data.alerts[0]).toMatchObject({ title: "Saldo diverge", agentName: "sentinela-integridade", level: "alto_risco" });
    }
  });

  it("operador e voluntário não veem alertas (403) e outra organização também não", async () => {
    await seedAlert(orgId);
    const operator = await member(orgId, "operador");
    const volunteer = await member(orgId, "voluntario");
    const outsider = await createAuthenticatedUser();
    await createTestOrganization(outsider.userId);
    for (const actor of [operator, volunteer, outsider]) {
      expect((await getAlerts(get(`integrity-alerts?organizationId=${orgId}`, actor))).status).toBe(403);
    }
  });

  it("filtra por status e nunca vaza alerta de outra organização", async () => {
    const otherOwner = await createAuthenticatedUser();
    const otherOrg = await createTestOrganization(otherOwner.userId);
    await seedAlert(otherOrg.id, { title: "da outra" });
    const mine = await seedAlert(orgId, { title: "minha" });
    await db.updateTable("integrityAlerts").set({ status: "resolvido" }).where("id", "=", mine).execute();

    const open = await parseJson<{ alerts: unknown[] }>(await getAlerts(get(`integrity-alerts?organizationId=${orgId}`, owner)));
    expect(open.alerts).toHaveLength(0);
    const resolved = await parseJson<{ alerts: Array<{ title: string }> }>(
      await getAlerts(get(`integrity-alerts?organizationId=${orgId}&status=resolvido`, owner))
    );
    expect(resolved.alerts.map((a) => a.title)).toEqual(["minha"]);
  });

  it("reconhecer, depois resolver com nota; repetir a ação é conflito e tudo fica auditado", async () => {
    const alertId = await seedAlert(orgId);

    const ack = await postAlertUpdate(post("integrity-alerts-update", owner, { organizationId: orgId, alertId, action: "reconhecer" }));
    expect(ack.status).toBe(200);
    expect((await parseJson<{ alert: { status: string } }>(ack)).alert.status).toBe("reconhecido");
    expect((await postAlertUpdate(post("integrity-alerts-update", owner, { organizationId: orgId, alertId, action: "reconhecer" }))).status).toBe(409);

    const resolved = await postAlertUpdate(
      post("integrity-alerts-update", owner, { organizationId: orgId, alertId, action: "resolver", note: "contagem refeita" })
    );
    expect(resolved.status).toBe(200);
    const row = await db.selectFrom("integrityAlerts").selectAll().where("id", "=", alertId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: "resolvido", resolvedByUserId: owner.userId, resolutionNote: "contagem refeita" });
    expect((await postAlertUpdate(post("integrity-alerts-update", owner, { organizationId: orgId, alertId, action: "descartar" }))).status).toBe(409);

    const audits = await db
      .selectFrom("auditLog")
      .select(["action", "metadata"])
      .where("organizationId", "=", orgId)
      .where("action", "=", "automacao.alerta_atualizado")
      .orderBy("id", "asc")
      .execute();
    expect(audits.map((a) => a.metadata)).toEqual([
      { de: "aberto", para: "reconhecido" },
      { de: "reconhecido", para: "resolvido" },
    ]);
    expect((await verifyAuditLogChain()).integra).toBe(true);
  });

  it("alerta inexistente ou de outra organização é 404; operador não atualiza (403)", async () => {
    const otherOwner = await createAuthenticatedUser();
    const otherOrg = await createTestOrganization(otherOwner.userId);
    const foreign = await seedAlert(otherOrg.id);
    expect((await postAlertUpdate(post("integrity-alerts-update", owner, { organizationId: orgId, alertId: foreign, action: "resolver" }))).status).toBe(404);
    expect((await postAlertUpdate(post("integrity-alerts-update", owner, { organizationId: orgId, alertId: "999999", action: "resolver" }))).status).toBe(404);
    const mine = await seedAlert(orgId);
    const operator = await member(orgId, "operador");
    expect((await postAlertUpdate(post("integrity-alerts-update", operator, { organizationId: orgId, alertId: mine, action: "resolver" }))).status).toBe(403);
    expect((await db.selectFrom("integrityAlerts").select("status").where("id", "=", mine).executeTakeFirstOrThrow()).status).toBe("aberto");
  });

  it("identificador inválido é 400; organização em análise ainda lê mas não atualiza", async () => {
    const alertId = await seedAlert(orgId);
    expect((await postAlertUpdate(post("integrity-alerts-update", owner, { organizationId: orgId, alertId: "1; DROP TABLE x", action: "resolver" }))).status).toBe(400);

    const pendingOrg = await createTestOrganization(owner.userId, { status: "em_analise" });
    const pendingAlert = await seedAlert(pendingOrg.id);
    expect((await getAlerts(get(`integrity-alerts?organizationId=${pendingOrg.id}`, owner))).status).toBe(200);
    expect((await postAlertUpdate(post("integrity-alerts-update", owner, { organizationId: pendingOrg.id, alertId: pendingAlert, action: "resolver" }))).status).toBe(403);
    expect(alertId).toBeDefined();
  });
});

describe("endpoints da fila de exceções", () => {
  let owner: AuthenticatedTestUser;
  let orgId: number;
  let principalId: number;

  beforeEach(async () => {
    owner = await createAuthenticatedUser();
    orgId = (await createTestOrganization(owner.userId)).id;
    principalId = (await ensureAgentPrincipal(db, "risk-engine", null)).id;
  });

  async function seedException(approvalsRequired: 1 | 2, organizationId = orgId) {
    const row = await db
      .insertInto("exceptionQueue")
      .values({
        organizationId,
        agentPrincipalId: principalId,
        toolName: "test_tool",
        ruleCode: approvalsRequired === 2 ? "R-VALOR-ALTO-DUPLA" : "R-CATEGORIA-ALTO-RISCO",
        approvalsRequired,
        request: { organizationId, estimatedValue: 9999 },
        requestHash: `hash-${Math.random()}`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return String(row.id);
  }

  it("lista as pendentes com o agente, contagem de aprovações e a decisão do próprio usuário", async () => {
    const admin = await member(orgId, "administrador");
    const exceptionId = await seedException(2);
    await postExceptionDecide(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId, decision: "aprovar" }));

    const data = await parseJson<{ exceptions: Array<{ id: string; agentName: string; approvals: number; approvalsRequired: number; myDecision: string | null }> }>(
      await getExceptions(get(`exception-queue?organizationId=${orgId}`, admin))
    );
    expect(data.exceptions).toHaveLength(1);
    expect(data.exceptions[0]).toMatchObject({ id: exceptionId, agentName: "risk-engine", approvals: 1, approvalsRequired: 2, myDecision: null });
    const asOwner = await parseJson<{ exceptions: Array<{ myDecision: string | null }> }>(
      await getExceptions(get(`exception-queue?organizationId=${orgId}`, owner))
    );
    expect(asOwner.exceptions[0].myDecision).toBe("aprovar");
  });

  it("dupla autorização: a mesma pessoa não conta duas vezes; a segunda pessoa conclui", async () => {
    const admin = await member(orgId, "administrador");
    const exceptionId = await seedException(2);

    const first = await postExceptionDecide(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId, decision: "aprovar" }));
    expect((await parseJson<{ exception: { status: string } }>(first)).exception.status).toBe("pendente");
    expect((await postExceptionDecide(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId, decision: "aprovar" }))).status).toBe(409);

    const second = await postExceptionDecide(post("exception-queue-decide", admin, { organizationId: orgId, exceptionId, decision: "aprovar", notes: "ok" }));
    expect((await parseJson<{ exception: { status: string } }>(second)).exception.status).toBe("aprovada");
    expect((await postExceptionDecide(post("exception-queue-decide", admin, { organizationId: orgId, exceptionId, decision: "rejeitar" }))).status).toBe(409);
  });

  it("rejeição encerra na hora e é auditada sem texto livre", async () => {
    const exceptionId = await seedException(1);
    const response = await postExceptionDecide(
      post("exception-queue-decide", owner, { organizationId: orgId, exceptionId, decision: "rejeitar", notes: "dados pessoais de fulano" })
    );
    expect((await parseJson<{ exception: { status: string } }>(response)).exception.status).toBe("rejeitada");
    const audit = await db
      .selectFrom("auditLog")
      .select("metadata")
      .where("action", "=", "automacao.excecao_decidida")
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(audit.metadata)).not.toContain("fulano");
  });

  it("operador não decide (403); exceção de outra organização é 404", async () => {
    const operator = await member(orgId, "operador");
    const exceptionId = await seedException(1);
    expect((await postExceptionDecide(post("exception-queue-decide", operator, { organizationId: orgId, exceptionId, decision: "aprovar" }))).status).toBe(403);
    expect((await getExceptions(get(`exception-queue?organizationId=${orgId}`, operator))).status).toBe(403);

    const otherOwner = await createAuthenticatedUser();
    const otherOrg = await createTestOrganization(otherOwner.userId);
    const foreign = await seedException(1, otherOrg.id);
    expect((await postExceptionDecide(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: foreign, decision: "aprovar" }))).status).toBe(404);
  });
});

describe("endpoints de pausa e emergência", () => {
  let owner: AuthenticatedTestUser;
  let orgId: number;

  beforeEach(async () => {
    owner = await createAuthenticatedUser();
    orgId = (await createTestOrganization(owner.userId)).id;
  });

  it("proprietário pausa a própria organização; administrador lê; operador não lê nem altera", async () => {
    const admin = await member(orgId, "administrador");
    const operator = await member(orgId, "operador");

    const paused = await postControls(post("automation-controls", owner, { organizationId: orgId, paused: true, emergency: false, reason: "revisão semanal" }));
    expect(paused.status).toBe(200);

    const state = await parseJson<{ paused: boolean; emergency: boolean; organization: { reason: string | null } }>(
      await getControls(get(`automation-controls?organizationId=${orgId}`, admin))
    );
    expect(state).toMatchObject({ paused: true, emergency: false, organization: { reason: "revisão semanal" } });

    expect((await getControls(get(`automation-controls?organizationId=${orgId}`, operator))).status).toBe(403);
    expect((await postControls(post("automation-controls", operator, { organizationId: orgId, paused: false, emergency: false }))).status).toBe(403);
  });

  it("emergência sem pausa é conflito (409) e a alteração fica auditada", async () => {
    expect((await postControls(post("automation-controls", owner, { organizationId: orgId, paused: false, emergency: true }))).status).toBe(409);
    await postControls(post("automation-controls", owner, { organizationId: orgId, paused: true, emergency: true }));
    const audit = await db.selectFrom("auditLog").select("action").where("organizationId", "=", orgId).where("action", "=", "automacao.controle_alterado").execute();
    expect(audit).toHaveLength(1);
  });

  it("pausa de uma organização não afeta a outra; pausa global só pela equipe da plataforma e vale para todas", async () => {
    const otherOwner = await createAuthenticatedUser();
    const otherOrg = await createTestOrganization(otherOwner.userId);
    await postControls(post("automation-controls", owner, { organizationId: orgId, paused: true, emergency: false }));
    const other = await parseJson<{ paused: boolean }>(await getControls(get(`automation-controls?organizationId=${otherOrg.id}`, otherOwner)));
    expect(other.paused).toBe(false);

    expect((await postPlatformControls(post("platform-automation-controls", owner, { paused: true, emergency: false }))).status).toBe(403);

    const platformAdmin = await createPlatformAdmin();
    const global = await postPlatformControls(post("platform-automation-controls", platformAdmin, { paused: true, emergency: true, reason: "incidente" }));
    expect(global.status).toBe(200);
    const afterGlobal = await parseJson<{ paused: boolean; emergency: boolean; global: { reason: string | null } }>(
      await getControls(get(`automation-controls?organizationId=${otherOrg.id}`, otherOwner))
    );
    expect(afterGlobal).toMatchObject({ paused: true, emergency: true, global: { reason: "incidente" } });
  });
});

describe("eventos publicados pelos fluxos de negócio", () => {
  let owner: AuthenticatedTestUser;
  let orgId: number;

  beforeEach(async () => {
    owner = await createAuthenticatedUser();
    orgId = (await createTestOrganization(owner.userId)).id;
  });

  async function events(type: string) {
    return db.selectFrom("domainEvents").selectAll().where("eventType", "=", type).execute();
  }

  it("movimento de estoque publica stock_transaction.created na mesma transação e recusa não publica nada", async () => {
    const item = await createTestInventoryItem(orgId, owner.userId);
    const ok = await postStockTransaction(post("stock-transactions", owner, { organizationId: orgId, itemId: item.id, type: "entrada", quantity: 10, reason: "doação recebida" }));
    expect(ok.status).toBe(200);
    const [event] = await events("stock_transaction.created");
    expect(event.organizationId).toBe(orgId);
    expect(event.payload).toMatchObject({ itemId: item.id, type: "entrada", delta: 10, newStock: 10 });
    expect(JSON.stringify(event.payload)).not.toContain("doação");

    // M33: desde a Fase 99E a saída física só existe pela destinação (`POST /stock-destinations`); `stock-transactions` recusa `saida` com 400 — e uma recusa não publica evento.
    const refused = await postStockTransaction(post("stock-transactions", owner, { organizationId: orgId, itemId: item.id, type: "saida", quantity: 999, reason: "saída grande" }));
    expect(refused.status).toBe(400);
    expect(await events("stock_transaction.created")).toHaveLength(1);
  });

  it("oportunidade da organização publica opportunity.created sem dados do doador", async () => {
    const response = await postOpportunity(
      post("opportunities", owner, { organizationId: orgId, title: "20 cadeiras", donorName: "Fulano de Tal", donorContact: "fulano@example.com", category: "mobiliario", quantityOffered: 20, unit: "unidade" })
    );
    expect(response.status).toBe(200);
    const [event] = await events("opportunity.created");
    expect(event.organizationId).toBe(orgId);
    expect(event.payload).toMatchObject({ category: "mobiliario", quantityOffered: 20, unit: "unidade" });
    expect(JSON.stringify(event.payload)).not.toContain("Fulano");
    expect(JSON.stringify(event.payload)).not.toContain("example.com");
  });

  it("descoberta central publica opportunity_registry.created sem organização", async () => {
    const admin = await createPlatformAdmin();
    const source = await db.insertInto("sources").values({ name: "Fonte manual", type: "manual", connectorKey: "manual", status: "ativa", createdByUserId: admin.userId }).returning("id").executeTakeFirstOrThrow();
    const response = await postOpportunityRegistry(
      post("opportunity-registry", admin, { sourceId: source.id, title: "40 cobertores", quantity: 40, unit: "unidade", urgency: "alta" })
    );
    expect(response.status).toBe(200);
    const [event] = await events("opportunity_registry.created");
    expect(event.organizationId).toBeNull();
    expect(event.payload).toMatchObject({ sourceId: source.id, quantity: 40, urgency: "alta" });
  });

  it("recebimento de atribuição publica allocation.received com o movimento de estoque", async () => {
    const item = await createTestInventoryItem(orgId, owner.userId);
    const source = await db.insertInto("sources").values({ name: "Fonte manual", type: "manual", connectorKey: "manual", createdByUserId: owner.userId }).returning("id").executeTakeFirstOrThrow();
    const registry = await db.insertInto("opportunityRegistry").values({ sourceId: source.id, title: "40 cobertores doados", quantity: 40, unit: "unidade", discoveryAgent: "manual" }).returning("id").executeTakeFirstOrThrow();
    const allocation = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: registry.id, organizationId: orgId, quantityAllocated: 40, status: "aceita" }).returning("id").executeTakeFirstOrThrow();

    const response = await postAllocationsReceive(post("allocations-receive", owner, { organizationId: orgId, allocationId: allocation.id, itemId: item.id, quantityReceived: 40 }));
    expect(response.status).toBe(200);
    const [event] = await events("allocation.received");
    expect(event).toMatchObject({ organizationId: orgId, entityId: String(allocation.id) });
    expect(event.payload).toMatchObject({ itemId: item.id, quantityReceived: 40 });
    expect(typeof (event.payload as { opportunityConcluded: unknown }).opportunityConcluded).toBe("boolean");
    expect((event.payload as { stockTransactionId: string }).stockTransactionId).toMatch(/^[0-9]+$/);
  });
});
