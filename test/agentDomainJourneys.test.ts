/**
 * M35 — jornadas A–J com os SERVIÇOS REAIS do domínio (endpoints de estoque, recebimento, oportunidades, aprovação) → publicador v2 → motor (Sentinela/Risk Engine, SIMULADO) → decisão explicada →
 * exceção/alerta/auditoria → leitura pela API. PostgreSQL de teste; nenhuma ação externa; nada é publicado “à mão” exceto onde o teste pretende simular um evento LEGADO (v1) ou uma falha.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/helpers/db";
import { publishDomainEvent } from "../src/helpers/domainEvents";
import { publishStockTransactionCreated } from "../src/helpers/domainEventPublishers";
import { advanceRun, runAgentEventEngine } from "../src/helpers/agentEventEngine";
import { setAutomationControl } from "../src/helpers/automationControls";
import { setPolicyLimit } from "../src/helpers/policyLimits";
import { ensureAgentPrincipal } from "../src/helpers/agentRegistry";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { handle as postStock } from "../src/endpoints/stock-transactions_POST";
import { handle as postOpportunity } from "../src/endpoints/opportunities_POST";
import { handle as postReceive } from "../src/endpoints/allocations-receive_POST";
import { handle as postDecideApproval } from "../src/endpoints/approval-requests-decide_POST";
import { handle as postDecideException } from "../src/endpoints/exception-queue-decide_POST";
import { handle as getRuns } from "../src/endpoints/agent-events_GET";
import { handle as postEngineRun } from "../src/endpoints/agent-engine-run_POST";
import type { MembershipRole } from "../src/helpers/schema";
import { createAuthenticatedUser, createTestOrganization, createTestInventoryItem, createTestSource, createTestOpportunityRegistry, addMembership, buildRequest, parseJson, type AuthenticatedTestUser } from "./helpers";

const get = (path: string, a?: AuthenticatedTestUser) => buildRequest(path, { cookie: a?.cookie });
const post = (path: string, a: AuthenticatedTestUser | undefined, body: unknown) => buildRequest(path, { method: "POST", cookie: a?.cookie, body });
async function member(orgId: number, role: MembershipRole) { const u = await createAuthenticatedUser(); await addMembership(orgId, u.userId, role); return u; }
const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));

type Detail = { detail: { run: { id: string; status: string; completeness: string | null; decision: string | null }; explanation: null | { completeness: string; decision: string; facts: Record<string, unknown>; missingRequired: string[]; missingOptional: string[]; rules: Array<{ code: string; result: string; limit?: string; optional?: boolean }>; limits: Record<string, unknown>; pendingRules: Array<{ code: string }>; evaluationCount: number; previous: Array<{ decision: string }>; simulated: boolean }; history: Array<{ toStatus: string }> } };
const eventOf = async (type: string) => (await db.selectFrom("domainEvents").selectAll().where("eventType", "=", type).orderBy("id", "desc").limit(1).executeTakeFirstOrThrow());
const runFor = async (eventId: string) => db.selectFrom("agentEventRuns").selectAll().where("eventId", "=", eventId).executeTakeFirst();

describe("jornadas do domínio → motor de eventos (simulado)", () => {
  let owner: AuthenticatedTestUser; let orgId: number;
  const detailOf = async (runId: string, who = owner, org = orgId) => parseJson<Detail>(await getRuns(get(`agent-events?organizationId=${org}&runId=${runId}`, who)));
  const enable = async (name: "sentinela-integridade" | "risk-engine") => { const p = await ensureAgentPrincipal(db, name, orgId); await wait(); return p; };

  beforeEach(async () => { owner = await createAuthenticatedUser(); orgId = (await createTestOrganization(owner.userId)).id; });

  describe("Jornada A — transação de estoque (Sentinela)", () => {
    it("entrada pelo endpoint real: evento v2 com saldo/ator/origem → Sentinela conclui a simulação com explicação completa e auditoria", async () => {
      await enable("sentinela-integridade");
      const item = await createTestInventoryItem(orgId, owner.userId);
      const res = await postStock(post("stock-transactions", owner, { organizationId: orgId, itemId: item.id, type: "entrada", quantity: 10, reason: "Doação recebida" }));
      expect(res.status).toBe(200);
      const ev = await eventOf("stock_transaction.created");
      expect(ev.payload).toMatchObject({ v: 2, itemId: item.id, type: "entrada", delta: 10, newStock: 10, previousStock: 0, source: "lancamento_manual", itemHasPriorDistribution: false, actorUserId: owner.userId });
      expect(JSON.stringify(ev.payload)).not.toMatch(/Doação recebida|@|reason/); // nenhum texto livre nem dado pessoal
      await runAgentEventEngine({ organizationId: orgId });
      const run = (await runFor(String(ev.id)))!;
      expect(run).toMatchObject({ status: "simulacao_concluida", simulated: true });
      const d = await detailOf(String(run.id));
      expect(d.detail.explanation).toMatchObject({ completeness: "completa", decision: "permitido", simulated: true });
      expect(d.detail.explanation!.facts).toMatchObject({ tipo: "entrada", saldoApos: 10, atorId: owner.userId, versaoContrato: 2 });
      expect(d.detail.explanation!.rules.find((r) => r.code === "R-SENTINELA-SALDO-NEGATIVO")!.result).toBe("ok");
      expect(d.detail.explanation!.pendingRules.map((r) => r.code)).toContain("R-SENTINELA-RAJADA-AJUSTES");
      expect(d.detail.history.map((h) => h.toStatus)).toEqual(["recebido", "validado", "autorizado_simulacao", "simulacao_concluida"]);
      expect((await db.selectFrom("auditLog").select("action").where("entityType", "=", "agent_event_run").execute()).map((a) => a.action)).toEqual(["agente.evento_validado", "agente.evento_autorizado_simulacao", "agente.evento_simulacao_concluida"]);
      expect((await verifyAuditLogChain()).integra).toBe(true);
    });

    it("ajuste de item que JÁ teve saída → exceção (revisão); aprovada por uma pessoa → autorizado só para simulação → concluída", async () => {
      await enable("sentinela-integridade");
      const item = await createTestInventoryItem(orgId, owner.userId);
      await db.insertInto("stockTransactions").values([{ organizationId: orgId, itemId: item.id, type: "entrada", delta: "100", createdByUserId: owner.userId, reason: "carga" }, { organizationId: orgId, itemId: item.id, type: "saida", delta: "-10", createdByUserId: owner.userId, reason: "saída" }]).execute();
      const res = await postStock(post("stock-transactions", owner, { organizationId: orgId, itemId: item.id, type: "ajuste", quantity: -2, reason: "Quebra" }));
      expect(res.status).toBe(200);
      const ev = await eventOf("stock_transaction.created");
      expect(ev.payload).toMatchObject({ v: 2, type: "ajuste", delta: -2, itemHasPriorDistribution: true, newStock: 88 });
      await runAgentEventEngine({ organizationId: orgId });
      const run = (await runFor(String(ev.id)))!;
      expect(run).toMatchObject({ status: "aguardando_aprovacao", ruleCode: "R-SENTINELA-AJUSTE-ITEM-DISTRIBUIDO" });
      const ex = await db.selectFrom("exceptionQueue").selectAll().where("id", "=", run.exceptionId!).executeTakeFirstOrThrow();
      expect(ex).toMatchObject({ approvalsRequired: 1, status: "pendente", organizationId: orgId });
      const d = await detailOf(String(run.id));
      expect(d.detail.explanation!.decision).toBe("revisao"); expect(d.detail.explanation!.rules.find((r) => r.code === "R-SENTINELA-AJUSTE-ITEM-DISTRIBUIDO")!.result).toBe("violada");
      expect((await postDecideException(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: String(ex.id), decision: "aprovar" }))).status).toBe(200);
      expect((await runFor(String(ev.id)))!.status).toBe("autorizado_simulacao");
      await runAgentEventEngine({ organizationId: orgId });
      expect((await runFor(String(ev.id)))!.status).toBe("simulacao_concluida");
      expect((await detailOf(String(run.id))).detail.explanation!.decision).toBe("aprovado_por_pessoas_simulacao");
    });

    it("ajuste de ALTO risco (regra já existente na origem): o pedido de aprovação não gera evento; só quando a SEGUNDA pessoa aprova o ajuste é lançado e o evento nasce (origem 'ajuste_aprovado')", async () => {
      await enable("sentinela-integridade");
      const admin = await member(orgId, "administrador");
      const item = await createTestInventoryItem(orgId, owner.userId);
      await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: "100", createdByUserId: owner.userId, reason: "carga" }).execute();
      const res = await postStock(post("stock-transactions", owner, { organizationId: orgId, itemId: item.id, type: "ajuste", quantity: -50, reason: "Perda grande" }));
      expect(res.status).toBe(202); // o pedido de aprovação foi criado; nada foi lançado
      const body = await parseJson<{ approvalRequestId: number }>(res);
      expect((await db.selectFrom("domainEvents").select("id").where("eventType", "=", "stock_transaction.created").execute()).length).toBe(0); // nada lançado, nada publicado
      expect((await postDecideApproval(post("approval-requests-decide", admin, { organizationId: orgId, requestId: body.approvalRequestId, decision: "aprovada" }))).status).toBe(200);
      const ev = await eventOf("stock_transaction.created");
      expect(ev.payload).toMatchObject({ v: 2, type: "ajuste", delta: -50, newStock: 50, source: "ajuste_aprovado", actorUserId: owner.userId });
      await runAgentEventEngine({ organizationId: orgId });
      expect((await runFor(String(ev.id)))!.status).toBe("simulacao_concluida"); // item nunca distribuído, saldo positivo → permitido
    });
  });

  describe("Jornada B — recebimento de atribuição (Sentinela)", () => {
    async function allocation(quantity: number) {
      const source = await createTestSource(owner.userId); const registry = await createTestOpportunityRegistry(source.id, owner.userId);
      const [a] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: registry.id, organizationId: orgId, quantityAllocated: String(quantity), status: "aceita" }).returning(["id"]).execute();
      return a.id;
    }
    it("quantidade recebida IGUAL à atribuída (mesma unidade) → permitido; evento carrega atribuída, recebida, unidade comparável e ator", async () => {
      await enable("sentinela-integridade");
      const item = await createTestInventoryItem(orgId, owner.userId); const allocationId = await allocation(5);
      expect((await postReceive(post("allocations-receive", owner, { organizationId: orgId, allocationId, itemId: item.id, quantityReceived: 5 }))).status).toBe(200);
      const ev = await eventOf("allocation.received");
      expect(ev.payload).toMatchObject({ v: 2, allocationId, itemId: item.id, quantityReceived: 5, quantityAllocated: 5, sameUnit: true, actorUserId: owner.userId });
      await runAgentEventEngine({ organizationId: orgId });
      const run = (await db.selectFrom("agentEventRuns").selectAll().where("eventId", "=", String(ev.id)).executeTakeFirst())!;
      expect(run.status).toBe("simulacao_concluida");
      expect((await detailOf(String(run.id))).detail.explanation).toMatchObject({ completeness: "completa", decision: "permitido" });
    });
    it("quantidade recebida DIFERENTE da atribuída → divergência → exceção; o usuário vê a regra violada, as quantidades e a nota de tolerância pendente", async () => {
      await enable("sentinela-integridade");
      const item = await createTestInventoryItem(orgId, owner.userId); const allocationId = await allocation(5);
      expect((await postReceive(post("allocations-receive", owner, { organizationId: orgId, allocationId, itemId: item.id, quantityReceived: 4 }))).status).toBe(200);
      const ev = await eventOf("allocation.received");
      await runAgentEventEngine({ organizationId: orgId });
      const run = (await db.selectFrom("agentEventRuns").selectAll().where("eventId", "=", String(ev.id)).executeTakeFirst())!;
      expect(run).toMatchObject({ status: "aguardando_aprovacao", ruleCode: "R-SENTINELA-DIVERGENCIA-RECEBIMENTO" });
      const d = await detailOf(String(run.id));
      expect(d.detail.explanation!.facts).toMatchObject({ quantidadeRecebida: 4, quantidadeAtribuida: 5, mesmaUnidade: true });
      expect(d.detail.explanation!.pendingRules.map((r) => r.code)).toContain("R-SENTINELA-TOLERANCIA-RECEBIMENTO");
    });
  });

  describe("Jornada C/E — oportunidade (Risk Engine) e dados insuficientes", () => {
    const opp = (extra: Record<string, unknown>) => post("opportunities", owner, { organizationId: orgId, title: "Oferta sintética", donorName: "Doador Sintético", ...extra });
    it("com categoria comum → permitido; categoria de alto risco → exceção; os dados usados aparecem na explicação", async () => {
      await enable("risk-engine");
      expect((await postOpportunity(opp({ category: "Roupa", quantityOffered: 3, unit: "kg" }))).status).toBe(200);
      const e1 = await eventOf("opportunity.created");
      expect(e1.payload).toMatchObject({ v: 2, category: "Roupa", quantityOffered: 3, unit: "kg", linkedNeed: false, actorUserId: owner.userId });
      expect((await postOpportunity(opp({ category: "medicamento", quantityOffered: 1, unit: "kg" }))).status).toBe(200);
      const e2 = await eventOf("opportunity.created");
      await runAgentEventEngine({ organizationId: orgId });
      expect((await runFor(String(e1.id)))!.status).toBe("simulacao_concluida");
      const r2 = (await runFor(String(e2.id)))!; expect(r2).toMatchObject({ status: "aguardando_aprovacao", ruleCode: "R-CATEGORIA-ALTO-RISCO" });
      const d = await detailOf(String(r2.id));
      expect(d.detail.explanation!.rules.find((r) => r.code === "R-CATEGORIA-ALTO-RISCO")).toMatchObject({ result: "violada" });
      expect(d.detail.explanation!.limits.highRiskCategories).toContain("medicamento");
      expect(d.detail.explanation!.missingOptional).toEqual(expect.arrayContaining(["estimatedValue", "distanceKm", "logisticsCost"]));
    });
    it("SEM categoria: 'dados insuficientes' — não aprova, não abre exceção, não conclui a simulação e diz o que faltou; a ausência NÃO vira 'sem risco'", async () => {
      await enable("risk-engine");
      expect((await postOpportunity(opp({ quantityOffered: 2, unit: "kg" }))).status).toBe(200);
      const ev = await eventOf("opportunity.created");
      expect((ev.payload as { category: unknown }).category).toBeNull();
      await runAgentEventEngine({ organizationId: orgId });
      const run = (await runFor(String(ev.id)))!;
      expect(run).toMatchObject({ status: "dados_insuficientes", reasonCode: "dados_insuficientes", exceptionId: null });
      const d = await detailOf(String(run.id));
      expect(d.detail.explanation).toMatchObject({ completeness: "insuficiente", decision: "dados_insuficientes", missingRequired: ["category"] });
      expect(d.detail.explanation!.rules.filter((r) => r.code.startsWith("R-CATEGORIA")).every((r) => r.result === "nao_avaliada")).toBe(true);
      expect(d.detail.history.map((h) => h.toStatus)).toEqual(["recebido", "validado", "dados_insuficientes"]);
      expect((await db.selectFrom("exceptionQueue").select("id").execute()).length).toBe(0);
      // reprocessar nunca promove a 'concluída'
      await runAgentEventEngine({ organizationId: orgId }); await runAgentEventEngine({ organizationId: orgId });
      expect((await runFor(String(ev.id)))!.status).toBe("dados_insuficientes");
      const summary = await parseJson<{ summary: { byStatus: Record<string, number> } }>(await getRuns(get(`agent-events?organizationId=${orgId}`, owner)));
      expect(summary.summary.byStatus).toMatchObject({ dados_insuficientes: 1 }); expect(summary.summary.byStatus.simulacao_concluida ?? 0).toBe(0);
    });
    it("evento LEGADO (v1: ajuste sem o fato novo) → insuficiente; evento legado de entrada continua avaliável", async () => {
      await enable("sentinela-integridade");
      await db.transaction().execute((trx) => publishDomainEvent(trx, { eventType: "stock_transaction.created", organizationId: orgId, entityType: "stock_transaction", entityId: "legacy-1", payload: { itemId: 1, type: "ajuste", delta: -2, newStock: 8 } }));
      const a = await eventOf("stock_transaction.created");
      await db.transaction().execute((trx) => publishDomainEvent(trx, { eventType: "stock_transaction.created", organizationId: orgId, entityType: "stock_transaction", entityId: "legacy-2", payload: { itemId: 1, type: "entrada", delta: 2, newStock: 8 } }));
      const b = await eventOf("stock_transaction.created");
      await runAgentEventEngine({ organizationId: orgId });
      expect((await runFor(String(a.id)))!.status).toBe("dados_insuficientes"); expect((await runFor(String(b.id)))!.status).toBe("simulacao_concluida");
    });
  });

  describe("Jornada D — limite da organização", () => {
    it("a organização restringe uma categoria: a MESMA oferta passa a exigir revisão, e a explicação mostra o limite aplicado", async () => {
      await enable("risk-engine");
      await db.transaction().execute((trx) => setPolicyLimit(trx, { organizationId: orgId, key: "HIGH_RISK_CATEGORIES", value: ["medicamento", "alimento_perecivel", "item_perigoso", "dinheiro", "roupa"], userId: owner.userId }));
      await postOpportunity(post("opportunities", owner, { organizationId: orgId, title: "Roupas", donorName: "Doador", category: "roupa", quantityOffered: 1, unit: "kg" }));
      const ev = await eventOf("opportunity.created");
      await runAgentEventEngine({ organizationId: orgId });
      const run = (await runFor(String(ev.id)))!; expect(run.status).toBe("aguardando_aprovacao");
      expect((await detailOf(String(run.id))).detail.explanation!.limits.highRiskCategories).toContain("roupa");
    });
  });

  describe("Jornada F — pausa e mudança de política: nenhuma decisão antiga contorna a política nova", () => {
    it("avaliada 'permitido' → pausa bloqueia → limite endurece → retomada REAVALIA e exige revisão; a decisão anterior fica só como histórico", async () => {
      await enable("risk-engine");
      await db.transaction().execute((trx) => setAutomationControl(trx, { organizationId: orgId, paused: true, emergency: false, reason: "revisão", userId: owner.userId }));
      await postOpportunity(post("opportunities", owner, { organizationId: orgId, title: "Roupas", donorName: "Doador", category: "roupa", quantityOffered: 1, unit: "kg" }));
      const ev = await eventOf("opportunity.created");
      await runAgentEventEngine({ organizationId: orgId });
      let run = (await runFor(String(ev.id)))!; expect(run).toMatchObject({ status: "bloqueado_politica", reasonCode: "automation_paused" });
      expect((await detailOf(String(run.id))).detail.explanation!.decision).toBe("permitido"); // o que a política dizia ANTES
      await db.transaction().execute((trx) => setPolicyLimit(trx, { organizationId: orgId, key: "HIGH_RISK_CATEGORIES", value: ["medicamento", "alimento_perecivel", "item_perigoso", "dinheiro", "roupa"], userId: owner.userId }));
      await db.transaction().execute((trx) => setAutomationControl(trx, { organizationId: orgId, paused: false, emergency: false, userId: owner.userId }));
      await runAgentEventEngine({ organizationId: orgId });
      run = (await runFor(String(ev.id)))!;
      expect(run.status).toBe("aguardando_aprovacao");
      const x = (await detailOf(String(run.id))).detail.explanation!;
      expect(x.decision).toBe("revisao"); expect(x.evaluationCount).toBeGreaterThanOrEqual(2); expect(x.previous.map((p) => p.decision)).toContain("permitido");
    });
    it("agente DESLIGADO durante a pausa: a retomada não acontece enquanto estiver desligado; ligado de novo, segue", async () => {
      const p = await enable("risk-engine");
      await db.transaction().execute((trx) => setAutomationControl(trx, { organizationId: orgId, paused: true, emergency: false, userId: owner.userId }));
      await postOpportunity(post("opportunities", owner, { organizationId: orgId, title: "Roupas", donorName: "Doador", category: "roupa", quantityOffered: 1, unit: "kg" }));
      const ev = await eventOf("opportunity.created");
      await runAgentEventEngine({ organizationId: orgId });
      await db.updateTable("agentPrincipals").set({ enabled: false }).where("id", "=", p.id).execute();
      await db.transaction().execute((trx) => setAutomationControl(trx, { organizationId: orgId, paused: false, emergency: false, userId: owner.userId }));
      await runAgentEventEngine({ organizationId: orgId }); await runAgentEventEngine({ organizationId: orgId });
      expect((await runFor(String(ev.id)))!.status).toBe("bloqueado_politica");
      await db.updateTable("agentPrincipals").set({ enabled: true }).where("id", "=", p.id).execute();
      await runAgentEventEngine({ organizationId: orgId });
      expect((await runFor(String(ev.id)))!.status).toBe("simulacao_concluida");
    });
    it("exceção REJEITADA enquanto havia pausa: a retomada não reabre nem conclui (rejeitado é terminal)", async () => {
      await enable("risk-engine");
      await postOpportunity(post("opportunities", owner, { organizationId: orgId, title: "Remédios", donorName: "Doador", category: "medicamento", quantityOffered: 1, unit: "kg" }));
      const ev = await eventOf("opportunity.created");
      await runAgentEventEngine({ organizationId: orgId });
      const exId = String((await runFor(String(ev.id)))!.exceptionId);
      await db.transaction().execute((trx) => setAutomationControl(trx, { organizationId: orgId, paused: true, emergency: false, userId: owner.userId }));
      expect((await postDecideException(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: exId, decision: "rejeitar" }))).status).toBe(200);
      await db.transaction().execute((trx) => setAutomationControl(trx, { organizationId: orgId, paused: false, emergency: false, userId: owner.userId }));
      await runAgentEventEngine({ organizationId: orgId });
      expect((await runFor(String(ev.id)))!.status).toBe("rejeitado");
    });
  });

  describe("Jornada G — idempotência", () => {
    it("várias passadas: 1 execução, 1 exceção, 1 alerta, mesmo histórico e mesma auditoria", async () => {
      await enable("risk-engine");
      await postOpportunity(post("opportunities", owner, { organizationId: orgId, title: "Remédios", donorName: "Doador", category: "medicamento", quantityOffered: 1, unit: "kg" }));
      const ev = await eventOf("opportunity.created");
      for (let i = 0; i < 4; i++) await runAgentEventEngine({ organizationId: orgId });
      const run = (await runFor(String(ev.id)))!;
      const audit1 = (await db.selectFrom("auditLog").select("id").where("entityType", "=", "agent_event_run").execute()).length;
      for (let i = 0; i < 3; i++) { await runAgentEventEngine({ organizationId: orgId }); await advanceRun(String(run.id)); }
      expect((await db.selectFrom("agentEventRuns").select("id").where("eventId", "=", String(ev.id)).execute()).length).toBe(1);
      expect((await db.selectFrom("exceptionQueue").select("id").execute()).length).toBe(1);
      expect((await db.selectFrom("integrityAlerts").select("id").execute()).length).toBe(1);
      expect((await db.selectFrom("auditLog").select("id").where("entityType", "=", "agent_event_run").execute()).length).toBe(audit1);
      expect((await detailOf(String(run.id))).detail.explanation!.evaluationCount).toBe(1); // nem reavaliou sem necessidade
    });
  });

  describe("Jornada H — falha transacional: sem operação concluída, sem evento", () => {
    it("falha DEPOIS de publicar o evento reverte o evento junto; recusas do domínio não publicam nada", async () => {
      await enable("sentinela-integridade");
      const item = await createTestInventoryItem(orgId, owner.userId);
      await expect(db.transaction().execute(async (trx) => {
        const [tx] = await trx.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: "5", createdByUserId: owner.userId, reason: "x" }).returning(["id"]).execute();
        await publishStockTransactionCreated(trx, { organizationId: orgId, transactionId: String(tx.id), itemId: item.id, type: "entrada", delta: 5, source: "lancamento_manual", actorUserId: owner.userId });
        throw new Error("falha simulada depois do evento");
      })).rejects.toThrow("falha simulada");
      expect((await db.selectFrom("domainEvents").select("id").execute()).length).toBe(0);
      expect((await db.selectFrom("stockTransactions").select("id").where("itemId", "=", item.id).execute()).length).toBe(0);
      // saldo insuficiente (409) e item de outra organização (404): nada publicado
      const other = await createAuthenticatedUser(); const otherOrg = (await createTestOrganization(other.userId)).id; const foreignItem = await createTestInventoryItem(otherOrg, other.userId);
      expect((await postStock(post("stock-transactions", owner, { organizationId: orgId, itemId: item.id, type: "ajuste", quantity: -3, reason: "sem saldo" }))).status).toBe(409);
      expect((await postStock(post("stock-transactions", owner, { organizationId: orgId, itemId: foreignItem.id, type: "entrada", quantity: 3, reason: "item alheio" }))).status).toBe(404);
      expect((await db.selectFrom("domainEvents").select("id").execute()).length).toBe(0);
      expect((await runAgentEventEngine({ organizationId: orgId })).registered).toBe(0);
    });
  });

  describe("Jornada I — segurança entre organizações", () => {
    it("usuário de outra organização não lê a decisão, nem com IDs manipulados; nenhum dado vaza", async () => {
      await enable("risk-engine");
      await postOpportunity(post("opportunities", owner, { organizationId: orgId, title: "Remédios", donorName: "Doador", category: "medicamento", quantityOffered: 1, unit: "kg" }));
      const ev = await eventOf("opportunity.created"); await runAgentEventEngine({ organizationId: orgId });
      const run = (await runFor(String(ev.id)))!;
      const intruder = await createAuthenticatedUser(); const intruderOrg = (await createTestOrganization(intruder.userId)).id;
      const r1 = await getRuns(get(`agent-events?organizationId=${orgId}&runId=${run.id}`, intruder)); expect(r1.status).toBe(403);
      expect(await r1.text()).not.toMatch(/R-CATEGORIA|medicamento|opportunity/);
      expect((await getRuns(get(`agent-events?organizationId=${intruderOrg}&runId=${run.id}`, intruder))).status).toBe(404); // ID de execução de outra organização, organização própria
      expect((await getRuns(get(`agent-events?organizationId=${intruderOrg}&runId=999999999`, intruder))).status).toBe(404);
      const vol = await member(orgId, "voluntario"); expect((await getRuns(get(`agent-events?organizationId=${orgId}&runId=${run.id}`, vol))).status).toBe(403);
    });
  });

  describe("Jornada J — concorrência", () => {
    it("pausa/limite/agente/rejeição/2 motores ao mesmo tempo: nenhuma execução concluída contraria a política final nem existe duplicidade; cadeia íntegra", async () => {
      const p = await enable("risk-engine");
      await db.transaction().execute((trx) => setAutomationControl(trx, { organizationId: orgId, paused: true, emergency: false, userId: owner.userId }));
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) { await postOpportunity(post("opportunities", owner, { organizationId: orgId, title: `Oferta ${i}`, donorName: "Doador", category: i % 2 ? "medicamento" : "roupa", quantityOffered: 1, unit: "kg" })); ids.push(String((await eventOf("opportunity.created")).id)); }
      await runAgentEventEngine({ organizationId: orgId });
      await Promise.all([
        db.transaction().execute((trx) => setAutomationControl(trx, { organizationId: orgId, paused: false, emergency: false, userId: owner.userId })),
        db.transaction().execute((trx) => setPolicyLimit(trx, { organizationId: orgId, key: "HIGH_RISK_CATEGORIES", value: ["medicamento", "alimento_perecivel", "item_perigoso", "dinheiro", "roupa"], userId: owner.userId })),
        runAgentEventEngine({ organizationId: orgId }), runAgentEventEngine({ organizationId: orgId }),
        db.updateTable("agentPrincipals").set({ enabled: false }).where("id", "=", p.id).execute().then(() => db.updateTable("agentPrincipals").set({ enabled: true }).where("id", "=", p.id).execute()),
      ]);
      for (let i = 0; i < 3; i++) await runAgentEventEngine({ organizationId: orgId });
      const runs = await db.selectFrom("agentEventRuns").selectAll().where("organizationId", "=", orgId).execute();
      expect(runs.length).toBe(6); expect(new Set(runs.map((r) => String(r.eventId))).size).toBe(6);
      // política FINAL: todas as categorias das ofertas são de alto risco → NENHUMA pode ter concluído sem aprovação humana
      for (const r of runs) { expect(["aguardando_aprovacao"]).toContain(r.status); expect((r.detail as { decision?: string }).decision).toBe("revisao"); }
      expect((await db.selectFrom("exceptionQueue").select("id").where("organizationId", "=", orgId).execute()).length).toBe(6);
      const hist = await db.selectFrom("agentEventRunHistory").select(["runId", "toStatus"]).execute();
      expect(hist.filter((h) => h.toStatus === "simulacao_concluida").length).toBe(0);
      expect((await verifyAuditLogChain()).integra).toBe(true);
    });
    it("duas conclusões simultâneas depois da aprovação + retomada: uma transição; o motor da organização responde 200", async () => {
      await enable("risk-engine");
      await postOpportunity(post("opportunities", owner, { organizationId: orgId, title: "Remédios", donorName: "Doador", category: "medicamento", quantityOffered: 1, unit: "kg" }));
      const ev = await eventOf("opportunity.created"); await runAgentEventEngine({ organizationId: orgId });
      const run = (await runFor(String(ev.id)))!;
      await postDecideException(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: String(run.exceptionId), decision: "aprovar" }));
      const res = await Promise.all([postEngineRun(post("agent-engine-run", owner, { organizationId: orgId })), postEngineRun(post("agent-engine-run", owner, { organizationId: orgId })), advanceRun(String(run.id))]);
      expect((res[0] as Response).status).toBe(200); expect((res[1] as Response).status).toBe(200);
      expect((await runFor(String(ev.id)))!.status).toBe("simulacao_concluida");
      expect((await db.selectFrom("agentEventRunHistory").select("id").where("runId", "=", run.id).where("toStatus", "=", "simulacao_concluida").execute()).length).toBe(1);
    });
  });
});
