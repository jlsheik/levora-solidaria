/**
 * M36 — reavaliação controlada de execuções `dados_insuficientes`: o evento e a decisão original permanecem; a nova análise é um registro separado e vinculado; dados novos vêm dos registros de
 * origem (nunca do pedido); permissões, isolamento, pausa, agente desligado, regra temporal de ativação, idempotência e concorrência. PostgreSQL de teste; serviços reais.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/helpers/db";
import { publishDomainEvent } from "../src/helpers/domainEvents";
import { ensureAgentPrincipal } from "../src/helpers/agentRegistry";
import { runAgentEventEngine } from "../src/helpers/agentEventEngine";
import { setAutomationControl } from "../src/helpers/automationControls";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { handle as postOpportunity } from "../src/endpoints/opportunities_POST";
import { handle as postReevaluate } from "../src/endpoints/agent-event-reevaluate_POST";
import { handle as getRuns } from "../src/endpoints/agent-events_GET";
import type { MembershipRole } from "../src/helpers/schema";
import { createAuthenticatedUser, createTestOrganization, createTestInventoryItem, createTestSource, createTestOpportunityRegistry, addMembership, buildRequest, parseJson, type AuthenticatedTestUser } from "./helpers";

const get = (p: string, a?: AuthenticatedTestUser) => buildRequest(p, { cookie: a?.cookie });
const post = (p: string, a: AuthenticatedTestUser | undefined, body: unknown) => buildRequest(p, { method: "POST", cookie: a?.cookie, body });
async function member(orgId: number, role: MembershipRole) { const u = await createAuthenticatedUser(); await addMembership(orgId, u.userId, role); return u; }
const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));
type Detail = { detail: { run: { status: string; reevaluated: boolean }; explanation: { decision: string; facts: Record<string, unknown>; previous: Array<{ decision: string }>; supplement?: { fields: Record<string, unknown>; sources: Array<{ table: string; field: string; recordId: string }>; correlationId: string } } | null; reevaluation: null | { eligibility: { state: string; blockCode: string | null; availableData: Array<{ field: string; table: string }>; stillMissing: string[] }; history: Array<{ outcome: string; previousDecision: string | null; newStatus: string | null; newDecision: string | null; requestedByName: string | null; correlationId: string }> }; history: Array<{ toStatus: string; actorType: string }> } };

describe("reavaliação controlada de dados insuficientes", () => {
  let owner: AuthenticatedTestUser; let orgId: number; let principalId: number;
  beforeEach(async () => { owner = await createAuthenticatedUser(); orgId = (await createTestOrganization(owner.userId)).id; principalId = (await ensureAgentPrincipal(db, "risk-engine", orgId)).id; await wait(); });
  const detail = async (runId: string, who: AuthenticatedTestUser | undefined = owner, org = orgId) => parseJson<Detail>(await getRuns(get(`agent-events?organizationId=${org}&runId=${runId}`, who)));
  const reevaluate = (runId: string, who: AuthenticatedTestUser | undefined = owner, org = orgId, extra: Record<string, unknown> = {}) => postReevaluate(post("agent-event-reevaluate", who, { organizationId: org, runId, ...extra }));

  /** Oportunidade REAL sem categoria → evento v2 → motor → `dados_insuficientes`. */
  async function insufficientRun() {
    expect((await postOpportunity(post("opportunities", owner, { organizationId: orgId, title: "Oferta sem categoria", donorName: "Doador", quantityOffered: 2, unit: "kg" }))).status).toBe(200);
    const opp = await db.selectFrom("donationOpportunities").select("id").where("organizationId", "=", orgId).orderBy("id", "desc").executeTakeFirstOrThrow();
    const ev = await db.selectFrom("domainEvents").select("id").orderBy("id", "desc").limit(1).executeTakeFirstOrThrow();
    await runAgentEventEngine({ organizationId: orgId });
    const run = await db.selectFrom("agentEventRuns").selectAll().where("eventId", "=", String(ev.id)).executeTakeFirstOrThrow();
    expect(run.status).toBe("dados_insuficientes");
    return { runId: String(run.id), eventId: String(ev.id), oppId: opp.id };
  }
  const setCategory = (oppId: number, category: string) => db.updateTable("donationOpportunities").set({ category }).where("id", "=", oppId).execute();

  it("Jornada H — categoria passa a existir no REGISTRO da oferta: elegível, origem verificável, nova análise vinculada; a decisão anterior e o evento ficam intactos", async () => {
    const { runId, eventId, oppId } = await insufficientRun();
    const before = await detail(runId);
    expect(before.detail.reevaluation!.eligibility).toMatchObject({ state: "ainda_insuficiente", stillMissing: ["category"] }); // ainda sem dado novo
    await setCategory(oppId, "roupa");
    const d = await detail(runId);
    expect(d.detail.reevaluation!.eligibility.state).toBe("elegivel");
    expect(d.detail.reevaluation!.eligibility.availableData[0]).toMatchObject({ field: "category", table: "donation_opportunities" });
    const eventBefore = (await db.selectFrom("domainEvents").select("payload").where("id", "=", eventId).executeTakeFirstOrThrow()).payload;

    const res = await reevaluate(runId, owner, orgId, { reason: "Categoria informada depois" });
    expect(res.status).toBe(200);
    const out = await parseJson<{ newStatus: string; newDecision: string; correlationId: string; simulated: boolean }>(res);
    expect(out).toMatchObject({ newStatus: "simulacao_concluida", newDecision: "permitido", simulated: true });

    const after = await detail(runId);
    expect(after.detail.run.reevaluated).toBe(true);
    expect(after.detail.explanation!.facts.categoria).toBe("roupa");
    expect(after.detail.explanation!.previous.map((p) => p.decision)).toContain("dados_insuficientes"); // decisão anterior preservada
    expect(after.detail.explanation!.supplement!.sources[0]).toMatchObject({ table: "donation_opportunities", field: "category" });
    const h = after.detail.history.map((x) => `${x.toStatus}:${x.actorType}`);
    expect(h).toEqual(["recebido:agent", "validado:agent", "dados_insuficientes:agent", "validado:user", "autorizado_simulacao:agent", "simulacao_concluida:agent"]);
    // registro separado e vinculado
    const rows = await db.selectFrom("agentEventReevaluations").selectAll().where("runId", "=", runId).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "concluida", previousStatus: "dados_insuficientes", previousDecision: "dados_insuficientes", newStatus: "simulacao_concluida", newDecision: "permitido", requestedByUserId: owner.userId, organizationId: orgId, reason: "Categoria informada depois", correlationId: out.correlationId });
    expect((rows[0].previousExplanation as { missingRequired: string[] }).missingRequired).toEqual(["category"]);
    // o evento NUNCA muda (payload original, sem categoria)
    expect((await db.selectFrom("domainEvents").select("payload").where("id", "=", eventId).executeTakeFirstOrThrow()).payload).toEqual(eventBefore);
    await expect(db.updateTable("domainEvents").set({ eventType: "x" }).where("id", "=", eventId).execute()).rejects.toThrow();
    // auditoria: pedido humano + transições do agente, com o mesmo identificador de correlação
    const audit = await db.selectFrom("auditLog").select(["action", "actorType", "actorUserId", "metadata"]).where("entityType", "=", "agent_event_run").where("entityId", "=", runId).orderBy("id").execute();
    const req = audit.find((a) => a.action === "agente.reavaliacao_solicitada")!;
    expect(req).toMatchObject({ actorType: "user", actorUserId: owner.userId }); expect((req.metadata as { correlacao: string }).correlacao).toBe(out.correlationId);
    expect(audit.map((a) => a.action)).toContain("agente.evento_simulacao_concluida");
    expect((await verifyAuditLogChain()).integra).toBe(true);
  });

  it("a nova análise passa pelas MESMAS regras: categoria de alto risco informada depois → exceção (não conclui)", async () => {
    const { runId, oppId } = await insufficientRun(); await setCategory(oppId, "medicamento");
    const out = await parseJson<{ newStatus: string; newDecision: string }>(await reevaluate(runId));
    expect(out).toMatchObject({ newStatus: "aguardando_aprovacao", newDecision: "revisao" });
    expect((await db.selectFrom("exceptionQueue").select("id").where("organizationId", "=", orgId).execute()).length).toBe(1);
    expect((await db.selectFrom("agentEventRunHistory").select("id").where("runId", "=", runId).where("toStatus", "=", "simulacao_concluida").execute()).length).toBe(0);
  });

  it("sem dado novo nos registros de origem: 409 'dados ainda insuficientes', o estado NÃO muda e a tentativa fica registrada", async () => {
    const { runId } = await insufficientRun();
    const res = await reevaluate(runId); expect(res.status).toBe(409); expect((await parseJson<{ code: string }>(res)).code).toBe("dados_ainda_insuficientes");
    expect((await db.selectFrom("agentEventRuns").select("status").where("id", "=", runId).executeTakeFirstOrThrow()).status).toBe("dados_insuficientes");
    const rows = await db.selectFrom("agentEventReevaluations").select(["outcome", "newStatus"]).where("runId", "=", runId).execute();
    expect(rows).toEqual([{ outcome: "ainda_insuficiente", newStatus: "dados_insuficientes" }]);
  });

  it("os dados novos NÃO podem vir do pedido: campos extras (categoria) no corpo são ignorados", async () => {
    const { runId } = await insufficientRun();
    const res = await reevaluate(runId, owner, orgId, { category: "roupa", supplement: { fields: { category: "roupa" } } });
    expect(res.status).toBe(409); // o schema não aceita carregar dados; só os registros de origem valem
    expect((await db.selectFrom("agentEventRuns").select("status").where("id", "=", runId).executeTakeFirstOrThrow()).status).toBe("dados_insuficientes");
  });

  it("Jornada I — permissões e isolamento: voluntário/operador 403, sem sessão 401, outra organização 403, ID de outra organização 404; nada vaza nem muda", async () => {
    const { runId, oppId } = await insufficientRun(); await setCategory(oppId, "roupa");
    for (const role of ["voluntario", "operador"] as MembershipRole[]) { const u = await member(orgId, role); expect((await reevaluate(runId, u)).status).toBe(403); }
    expect((await postReevaluate(post("agent-event-reevaluate", undefined, { organizationId: orgId, runId }))).status).toBe(401);
    const intruder = await createAuthenticatedUser(); const intruderOrg = (await createTestOrganization(intruder.userId)).id;
    const r1 = await reevaluate(runId, intruder, orgId); expect(r1.status).toBe(403); expect(await r1.text()).not.toMatch(/categoria|roupa|donation/i);
    expect((await reevaluate(runId, intruder, intruderOrg)).status).toBe(404); // ID manipulado + organização própria
    expect((await reevaluate("999999999", owner)).status).toBe(404);
    const ro = await getRuns(get(`agent-events?organizationId=${orgId}&runId=${runId}`, intruder)); expect(ro.status).toBe(403);
    expect((await db.selectFrom("agentEventRuns").select("status").where("id", "=", runId).executeTakeFirstOrThrow()).status).toBe("dados_insuficientes");
    expect((await db.selectFrom("agentEventReevaluations").select("id").execute()).length).toBe(0);
    const admin = await member(orgId, "administrador"); expect((await reevaluate(runId, admin)).status).toBe(200); // administrador pode
  });

  it("pausa e agente desligado BLOQUEIAM o pedido (registrado, sem mudar o estado); depois de religar/retomar, funciona", async () => {
    const { runId, oppId } = await insufficientRun(); await setCategory(oppId, "roupa");
    await db.transaction().execute((t) => setAutomationControl(t, { organizationId: orgId, paused: true, emergency: false, userId: owner.userId }));
    let res = await reevaluate(runId); expect(res.status).toBe(409); expect((await parseJson<{ code: string }>(res)).code).toBe("automacao_pausada");
    await db.transaction().execute((t) => setAutomationControl(t, { organizationId: orgId, paused: false, emergency: false, userId: owner.userId }));
    await db.updateTable("agentPrincipals").set({ enabled: false }).where("id", "=", principalId).execute();
    res = await reevaluate(runId); expect(res.status).toBe(409); expect((await parseJson<{ code: string }>(res)).code).toBe("agente_desligado");
    expect((await db.selectFrom("agentEventRuns").select("status").where("id", "=", runId).executeTakeFirstOrThrow()).status).toBe("dados_insuficientes");
    expect((await db.selectFrom("agentEventReevaluations").select("outcome").where("runId", "=", runId).execute()).map((r) => r.outcome)).toEqual(["bloqueada", "bloqueada"]);
    await db.updateTable("agentPrincipals").set({ enabled: true }).where("id", "=", principalId).execute();
    expect((await reevaluate(runId)).status).toBe(200);
  });

  it("Jornada J — regra temporal: evento ANTERIOR à ativação do agente não é reavaliável nem com dados completos (e não existe execução para ele)", async () => {
    // oferta criada ANTES de ligar o agente: o motor nunca cria execução para ela
    const other = await createAuthenticatedUser(); const org2 = (await createTestOrganization(other.userId)).id;
    await postOpportunity(post("opportunities", other, { organizationId: org2, title: "Antiga", donorName: "Doador", category: "roupa", quantityOffered: 1, unit: "kg" }));
    await wait(); const p2 = await ensureAgentPrincipal(db, "risk-engine", org2); await wait();
    expect((await runAgentEventEngine({ organizationId: org2 })).registered).toBe(0);
    // execução forjada em dados_insuficientes para um evento anterior à criação do principal (ex.: principal recriado): a checagem temporal recusa
    const ev = await db.selectFrom("domainEvents").select("id").where("organizationId", "=", org2).executeTakeFirstOrThrow();
    await db.updateTable("agentPrincipals").set({ createdAt: new Date(Date.now() + 60_000) }).where("id", "=", p2.id).execute();
    const run = await db.insertInto("agentEventRuns").values({ eventId: String(ev.id), agentPrincipalId: p2.id, organizationId: org2, eventType: "opportunity.created", status: "dados_insuficientes", reasonCode: "dados_insuficientes", detail: { decision: "dados_insuficientes", completeness: "insuficiente" } as never }).returning("id").executeTakeFirstOrThrow();
    const res = await reevaluate(String(run.id), other, org2);
    expect(res.status).toBe(409); expect((await parseJson<{ code: string }>(res)).code).toBe("anterior_a_ativacao");
    expect((await db.selectFrom("agentEventRuns").select("status").where("id", "=", run.id).executeTakeFirstOrThrow()).status).toBe("dados_insuficientes");
  });

  it("estado inválido e idempotência: só 'dados insuficientes' é reavaliável; o segundo pedido recebe conflito e não duplica", async () => {
    const { runId, oppId } = await insufficientRun(); await setCategory(oppId, "roupa");
    expect((await reevaluate(runId)).status).toBe(200);
    const again = await reevaluate(runId); expect(again.status).toBe(409); expect((await parseJson<{ code: string }>(again)).code).toBe("estado_invalido");
    expect((await db.selectFrom("agentEventReevaluations").select("id").where("runId", "=", runId).execute()).length).toBe(1);
    expect((await db.selectFrom("agentEventRunHistory").select("id").where("runId", "=", runId).where("toStatus", "=", "simulacao_concluida").execute()).length).toBe(1);
  });

  it("Jornada K — dois pedidos SIMULTÂNEOS: exatamente um avança; o outro recebe conflito; uma única conclusão", async () => {
    const { runId, oppId } = await insufficientRun(); await setCategory(oppId, "roupa");
    const admin = await member(orgId, "administrador");
    const [a, b] = await Promise.all([reevaluate(runId, owner), reevaluate(runId, admin)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await db.selectFrom("agentEventReevaluations").select("outcome").where("runId", "=", runId).execute()).map((r) => r.outcome)).toEqual(["concluida"]);
    expect((await db.selectFrom("agentEventRunHistory").select("id").where("runId", "=", runId).where("toStatus", "=", "simulacao_concluida").execute()).length).toBe(1);
  });

  it("a tabela de reavaliações é append-only: sem DELETE; só o resultado final preenchido uma vez; o que foi finalizado não muda", async () => {
    const { runId, oppId } = await insufficientRun(); await setCategory(oppId, "roupa"); await reevaluate(runId);
    const row = await db.selectFrom("agentEventReevaluations").select("id").where("runId", "=", runId).executeTakeFirstOrThrow();
    await expect(db.deleteFrom("agentEventReevaluations").where("id", "=", row.id).execute()).rejects.toThrow(/append-only|DELETE/);
    await expect(db.updateTable("agentEventReevaluations").set({ newDecision: "adulterada" }).where("id", "=", row.id).execute()).rejects.toThrow(/resultado final/);
    await expect(db.updateTable("agentEventReevaluations").set({ runId: "1" }).where("id", "=", row.id).execute()).rejects.toThrow();
  });

  it("eventos LEGADOS (v1): ajuste de estoque sem o fato novo é recalculado do ledger imutável (antes do lançamento), com origem registrada", async () => {
    await ensureAgentPrincipal(db, "sentinela-integridade", orgId); await wait();
    const item = await createTestInventoryItem(orgId, owner.userId);
    await db.insertInto("stockTransactions").values([{ organizationId: orgId, itemId: item.id, type: "entrada", delta: "100", createdByUserId: owner.userId, reason: "a" }, { organizationId: orgId, itemId: item.id, type: "saida", delta: "-10", createdByUserId: owner.userId, reason: "b" }]).execute();
    const adj = await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "ajuste", delta: "-2", createdByUserId: owner.userId, reason: "c" }).returning("id").executeTakeFirstOrThrow();
    await db.transaction().execute((trx) => publishDomainEvent(trx, { eventType: "stock_transaction.created", organizationId: orgId, entityType: "stock_transaction", entityId: String(adj.id), payload: { itemId: item.id, type: "ajuste", delta: -2, newStock: 88 } as never }));
    const ev = await db.selectFrom("domainEvents").select("id").orderBy("id", "desc").limit(1).executeTakeFirstOrThrow();
    await runAgentEventEngine({ organizationId: orgId });
    const run = await db.selectFrom("agentEventRuns").select(["id", "status"]).where("eventId", "=", String(ev.id)).executeTakeFirstOrThrow(); expect(run.status).toBe("dados_insuficientes");
    const d = await detail(String(run.id)); expect(d.detail.reevaluation!.eligibility.state).toBe("elegivel"); expect(d.detail.reevaluation!.eligibility.availableData[0]).toMatchObject({ field: "itemHasPriorDistribution", table: "stock_transactions" });
    const res = await reevaluate(String(run.id)); expect(res.status).toBe(200);
    // o item JÁ teve saída antes do ajuste → regra da Sentinela → revisão (nunca 'permitido' por falta de dado)
    expect((await parseJson<{ newStatus: string }>(res)).newStatus).toBe("aguardando_aprovacao");
  });

  it("eventos LEGADOS (v1): recebimento sem quantidade atribuída é completado pela atribuição real", async () => {
    await ensureAgentPrincipal(db, "sentinela-integridade", orgId); await wait();
    const item = await createTestInventoryItem(orgId, owner.userId, { unit: "kg" });
    const src = await createTestSource(owner.userId); const reg = await createTestOpportunityRegistry(src.id, owner.userId, { unit: "kg" });
    const [al] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: reg.id, organizationId: orgId, quantityAllocated: "5", status: "recebida" as never }).returning("id").executeTakeFirstOrThrow().then((r) => [r]);
    await db.transaction().execute((trx) => publishDomainEvent(trx, { eventType: "allocation.received", organizationId: orgId, entityType: "opportunity_allocation", entityId: String(al.id), payload: { itemId: item.id, quantityReceived: 4, stockTransactionId: "1", opportunityConcluded: false } as never }));
    const ev = await db.selectFrom("domainEvents").select("id").orderBy("id", "desc").limit(1).executeTakeFirstOrThrow();
    await runAgentEventEngine({ organizationId: orgId });
    const run = await db.selectFrom("agentEventRuns").select(["id", "status"]).where("eventId", "=", String(ev.id)).executeTakeFirstOrThrow(); expect(run.status).toBe("dados_insuficientes");
    const res = await reevaluate(String(run.id)); expect(res.status).toBe(200);
    expect((await parseJson<{ newStatus: string }>(res)).newStatus).toBe("aguardando_aprovacao"); // 4 recebido × 5 atribuído, mesma unidade → divergência
  });
});
