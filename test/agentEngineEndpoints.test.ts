/**
 * M34 — endpoints do motor: ligar/desligar agente (ação humana), processar agora, listagem/detalhe com paginação e filtros, retenção (só simulação), limites globais (só leitura), histórico de limites.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/helpers/db";
import { publishDomainEvent } from "../src/helpers/domainEvents";
import { handle as getRuns } from "../src/endpoints/agent-events_GET";
import { handle as postRun } from "../src/endpoints/agent-engine-run_POST";
import { handle as postEnable } from "../src/endpoints/agents-enable_POST";
import { handle as getRetention } from "../src/endpoints/retention-preview_GET";
import { handle as getPlatformLimits } from "../src/endpoints/platform-policy-limits_GET";
import { handle as getLimits } from "../src/endpoints/policy-limits_GET";
import { handle as postLimits } from "../src/endpoints/policy-limits_POST";
import { handle as getAgents } from "../src/endpoints/agents_GET";
import { handle as postDecide } from "../src/endpoints/exception-queue-decide_POST";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { processAgentEventsScheduled } from "../src/helpers/processAgentEventsTask";
import type { MembershipRole } from "../src/helpers/schema";
import { createAuthenticatedUser, createPlatformAdmin, createTestOrganization, addMembership, buildRequest, parseJson, type AuthenticatedTestUser } from "./helpers";

const get = (path: string, a?: AuthenticatedTestUser) => buildRequest(path, { cookie: a?.cookie });
const post = (path: string, a: AuthenticatedTestUser | undefined, body: unknown) => buildRequest(path, { method: "POST", cookie: a?.cookie, body });
async function member(orgId: number, role: MembershipRole) { const u = await createAuthenticatedUser(); await addMembership(orgId, u.userId, role); return u; }
async function publish(orgId: number, category: string | null, extra: Record<string, unknown> = {}, entityId = "1") {
  await db.transaction().execute((trx) => publishDomainEvent(trx, { eventType: "opportunity.created", organizationId: orgId, entityType: "donation_opportunity", entityId, payload: { category, quantityOffered: 1, unit: "kg", ...extra } as never }));
}
type Runs = { summary: { total: number; byStatus: Record<string, number>; unprocessedEvents: number; enabledEngineAgents: number }; runs: Array<{ id: string; status: string; simulated: boolean; agentName: string; eventType: string }>; nextBeforeId: string | null; detail: null | { history: Array<{ toStatus: string; actorType: string; actorName: string | null }> } };

describe("ligar o agente é uma decisão humana; sem isso o motor é inerte", () => {
  let owner: AuthenticatedTestUser; let orgId: number;
  beforeEach(async () => { owner = await createAuthenticatedUser(); orgId = (await createTestOrganization(owner.userId)).id; });

  it("sem agente ligado, eventos esperam (contagem real) e 'processar agora' não faz nada; ao ligar, só eventos NOVOS são avaliados", async () => {
    await publish(orgId, "roupa");
    let r = await parseJson<Runs>(await getRuns(get(`agent-events?organizationId=${orgId}`, owner)));
    expect(r.summary).toMatchObject({ total: 0, unprocessedEvents: 0, enabledEngineAgents: 0 });
    expect(await parseJson<{ registered: number; simulated: boolean }>(await postRun(post("agent-engine-run", owner, { organizationId: orgId })))).toMatchObject({ registered: 0, simulated: true });

    expect((await postEnable(post("agents-enable", owner, { organizationId: orgId, agent: "risk-engine", enabled: true }))).status).toBe(200);
    await new Promise((x) => setTimeout(x, 15));
    await publish(orgId, "roupa", {}, "2");
    r = await parseJson<Runs>(await getRuns(get(`agent-events?organizationId=${orgId}`, owner)));
    expect(r.summary.unprocessedEvents).toBe(1); expect(r.summary.enabledEngineAgents).toBe(1);
    const run = await parseJson<{ registered: number; byStatus: Record<string, number> }>(await postRun(post("agent-engine-run", owner, { organizationId: orgId })));
    expect(run.registered).toBe(1); expect(run.byStatus.simulacao_concluida).toBe(1);
    r = await parseJson<Runs>(await getRuns(get(`agent-events?organizationId=${orgId}`, owner)));
    expect(r.runs).toHaveLength(1); expect(r.runs[0]).toMatchObject({ simulated: true, agentName: "risk-engine", eventType: "opportunity.created", status: "simulacao_concluida" });
    expect(r.summary.unprocessedEvents).toBe(0);
    // o payload do evento nunca sai
    expect(JSON.stringify(r)).not.toMatch(/quantityOffered|donorName/);
  });

  it("ligar/desligar: só proprietário/administrador, só agente do motor, principal restrito à organização, auditado; desligar para o processamento", async () => {
    const admin = await member(orgId, "administrador"); const op = await member(orgId, "operador"); const vol = await member(orgId, "voluntario");
    for (const u of [op, vol]) expect((await postEnable(post("agents-enable", u, { organizationId: orgId, agent: "risk-engine", enabled: true }))).status).toBe(403);
    expect((await postEnable(post("agents-enable", undefined, { organizationId: orgId, agent: "risk-engine", enabled: true }))).status).toBe(401);
    expect((await postEnable(post("agents-enable", owner, { organizationId: orgId, agent: "agente-estoque", enabled: true }))).status).toBe(400);
    expect((await postEnable(post("agents-enable", admin, { organizationId: orgId, agent: "sentinela-integridade", enabled: true }))).status).toBe(200);
    const p = await db.selectFrom("agentPrincipals").selectAll().where("name", "=", "sentinela-integridade").executeTakeFirstOrThrow();
    expect(p).toMatchObject({ organizationId: orgId, enabled: true });
    expect((await postEnable(post("agents-enable", owner, { organizationId: orgId, agent: "sentinela-integridade", enabled: false }))).status).toBe(200);
    expect((await db.selectFrom("agentPrincipals").select("enabled").where("id", "=", p.id).executeTakeFirstOrThrow()).enabled).toBe(false);
    const audit = await db.selectFrom("auditLog").select(["action", "actorUserId"]).where("entityType", "=", "agent_principal").orderBy("id").execute();
    expect(audit.map((a) => a.action)).toEqual(["automacao.agente_ligado", "automacao.agente_desligado"]);
    // não toca o principal de outra organização
    const other = await createAuthenticatedUser(); const otherOrg = (await createTestOrganization(other.userId)).id;
    expect((await postEnable(post("agents-enable", owner, { organizationId: otherOrg, agent: "risk-engine", enabled: true }))).status).toBe(403);
    expect((await verifyAuditLogChain()).integra).toBe(true);
  });

  it("a tarefa agendada processa TODAS as organizações com agente ligado e deixa registro só com contagens", async () => {
    const o2 = await createAuthenticatedUser(); const org2 = (await createTestOrganization(o2.userId)).id;
    await postEnable(post("agents-enable", owner, { organizationId: orgId, agent: "risk-engine", enabled: true }));
    await postEnable(post("agents-enable", o2, { organizationId: org2, agent: "risk-engine", enabled: true }));
    await new Promise((x) => setTimeout(x, 15));
    await publish(orgId, "roupa", {}, "a"); await publish(org2, "medicamento", {}, "b");
    await processAgentEventsScheduled();
    const rows = await db.selectFrom("agentEventRuns").select(["organizationId", "status"]).orderBy("organizationId").execute();
    expect(rows.map((r) => r.status).sort()).toEqual(["aguardando_aprovacao", "simulacao_concluida"]);
    const task = await db.selectFrom("backgroundTaskRuns").selectAll().where("taskName", "=", "processAgentEvents").executeTakeFirstOrThrow();
    expect(task.status).toBe("concluida");
    expect(JSON.stringify(task.result)).toMatch(/"simulated":true/);
  });
});

describe("listagem, filtros, paginação e detalhe", () => {
  it("filtra por estado e tipo, pagina por cursor, e o detalhe traz o histórico com o ator (agente e pessoa)", async () => {
    const owner = await createAuthenticatedUser(); const orgId = (await createTestOrganization(owner.userId)).id;
    await postEnable(post("agents-enable", owner, { organizationId: orgId, agent: "risk-engine", enabled: true }));
    await new Promise((x) => setTimeout(x, 15));
    for (let i = 0; i < 5; i++) await publish(orgId, i === 0 ? "medicamento" : "roupa", {}, `p${i}`);
    await postRun(post("agent-engine-run", owner, { organizationId: orgId }));
    const page1 = await parseJson<Runs>(await getRuns(get(`agent-events?organizationId=${orgId}&limit=2`, owner)));
    expect(page1.runs).toHaveLength(2); expect(page1.nextBeforeId).not.toBeNull();
    const page2 = await parseJson<Runs>(await getRuns(get(`agent-events?organizationId=${orgId}&limit=2&beforeId=${page1.nextBeforeId}`, owner)));
    expect(page2.runs.every((r) => Number(r.id) < Number(page1.nextBeforeId))).toBe(true);
    const only = await parseJson<Runs>(await getRuns(get(`agent-events?organizationId=${orgId}&status=aguardando_aprovacao`, owner)));
    expect(only.runs).toHaveLength(1); expect(only.summary.byStatus).toMatchObject({ aguardando_aprovacao: 1, simulacao_concluida: 4 });
    // decide e vê o ator humano no histórico
    const ex = await db.selectFrom("exceptionQueue").select("id").where("organizationId", "=", orgId).executeTakeFirstOrThrow();
    await postDecide(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: String(ex.id), decision: "rejeitar" }));
    const detail = await parseJson<Runs>(await getRuns(get(`agent-events?organizationId=${orgId}&runId=${only.runs[0].id}`, owner)));
    expect(detail.detail!.history.map((h) => h.toStatus)).toEqual(["recebido", "validado", "aguardando_aprovacao", "rejeitado"]);
    expect(detail.detail!.history.at(-1)).toMatchObject({ actorType: "user" }); expect(detail.detail!.history.at(-1)!.actorName).toBeTruthy();
    // filtros inválidos e execução de outra organização
    expect((await getRuns(get(`agent-events?organizationId=${orgId}&status=inexistente`, owner))).status).toBe(400);
    const other = await createAuthenticatedUser(); const otherOrg = (await createTestOrganization(other.userId)).id;
    expect((await getRuns(get(`agent-events?organizationId=${otherOrg}&runId=${only.runs[0].id}`, other))).status).toBe(404);
  });
});

describe("retenção: só classificação e simulação", () => {
  it("conta por categoria, simula 'mais antigos que N dias' e NUNCA apaga; permissão e isolamento", async () => {
    const owner = await createAuthenticatedUser(); const orgId = (await createTestOrganization(owner.userId)).id;
    await publish(orgId, "roupa");
    const before = Number((await db.selectFrom("domainEvents").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);
    const res = await parseJson<{ rows: Array<{ key: string; total: number; olderThanSimulated: number | null; group: string }>; retentionDefined: boolean; deletionEnabled: boolean; decisionsPending: string[] }>(await getRetention(get(`retention-preview?organizationId=${orgId}&olderThanDays=30`, owner)));
    expect(res).toMatchObject({ retentionDefined: false, deletionEnabled: false });
    expect(res.rows.map((r) => r.key)).toEqual(["eventos", "execucoes", "excecoes", "alertas", "auditoria"]);
    expect(res.rows.find((r) => r.key === "eventos")).toMatchObject({ total: 1, olderThanSimulated: 0 });
    expect(res.rows.find((r) => r.key === "auditoria")!.group).toBe("auditoria");
    expect(res.decisionsPending.length).toBeGreaterThan(0);
    expect(Number((await db.selectFrom("domainEvents").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n)).toBe(before);
    const vol = await member(orgId, "voluntario");
    expect((await getRetention(get(`retention-preview?organizationId=${orgId}`, vol))).status).toBe(403);
    expect((await getRetention(get(`retention-preview?organizationId=${orgId}&olderThanDays=0`, owner))).status).toBe(400);
    const other = await createAuthenticatedUser();
    expect((await getRetention(get(`retention-preview?organizationId=${orgId}`, other))).status).toBe(403);
  });
});

describe("limites: histórico e visão global somente leitura", () => {
  it("histórico mostra quem alterou e quando (sem valores: a auditoria nunca os guarda); o nome da equipe da plataforma não aparece para a organização", async () => {
    const owner = await createAuthenticatedUser(); const orgId = (await createTestOrganization(owner.userId)).id;
    await postLimits(post("policy-limits", owner, { organizationId: orgId, key: "AUTO_ACCEPT_MAX_VALUE", value: 300 }));
    await postLimits(post("policy-limits", owner, { organizationId: orgId, key: "AUTO_ACCEPT_MAX_VALUE", value: 200 }));
    const res = await parseJson<{ history: Array<{ key: string; byName: string | null; scope: string }> }>(await getLimits(get(`policy-limits?organizationId=${orgId}`, owner)));
    expect(res.history).toHaveLength(2); expect(JSON.stringify(res.history)).not.toMatch(/300|200/);
    expect(res.history[0]).toMatchObject({ key: "AUTO_ACCEPT_MAX_VALUE", scope: "organizacao" }); expect(res.history[0].byName).toBeTruthy();
  });
  it("a visão global é só da plataforma, sem identificar organizações, e declara que a escrita global não existe", async () => {
    const owner = await createAuthenticatedUser(); const orgId = (await createTestOrganization(owner.userId)).id;
    await postLimits(post("policy-limits", owner, { organizationId: orgId, key: "AUTO_ACCEPT_MAX_VALUE", value: 100 }));
    const staff = await createPlatformAdmin();
    expect((await getPlatformLimits(get("platform-policy-limits", owner))).status).toBe(403);
    expect((await getPlatformLimits(get("platform-policy-limits"))).status).toBe(401);
    const res = await parseJson<{ limits: Array<{ key: string; organizationsRestricting: number }>; globalWriteEnabled: boolean; pendingDecisions: string[] }>(await getPlatformLimits(get("platform-policy-limits", staff)));
    expect(res.globalWriteEnabled).toBe(false); expect(res.pendingDecisions.length).toBeGreaterThan(0);
    expect(res.limits.find((l) => l.key === "AUTO_ACCEPT_MAX_VALUE")!.organizationsRestricting).toBe(1);
    expect(JSON.stringify(res)).not.toContain(String(orgId) + '"');
  });
});

describe("totais para a navegação são REAIS e isolados", () => {
  it("agents_GET devolve pendências e alertas abertos da própria organização, sem somar as de outras", async () => {
    const a = await createAuthenticatedUser(); const orgA = (await createTestOrganization(a.userId)).id;
    const b = await createAuthenticatedUser(); const orgB = (await createTestOrganization(b.userId)).id;
    for (const [u, o] of [[a, orgA], [b, orgB]] as const) await postEnable(post("agents-enable", u, { organizationId: o, agent: "risk-engine", enabled: true }));
    await new Promise((x) => setTimeout(x, 15));
    await publish(orgA, "medicamento", {}, "a1"); await publish(orgB, "medicamento", {}, "b1"); await publish(orgB, "dinheiro", {}, "b2");
    await postRun(post("agent-engine-run", a, { organizationId: orgA })); await postRun(post("agent-engine-run", b, { organizationId: orgB }));
    const ra = await parseJson<{ totals: { pendingExceptions: number; openAlerts: number } }>(await getAgents(get(`agents?organizationId=${orgA}`, a)));
    const rb = await parseJson<{ totals: { pendingExceptions: number; openAlerts: number } }>(await getAgents(get(`agents?organizationId=${orgB}`, b)));
    expect(ra.totals).toEqual({ pendingExceptions: 1, openAlerts: 1 }); expect(rb.totals).toEqual({ pendingExceptions: 2, openAlerts: 2 });
  });
});
