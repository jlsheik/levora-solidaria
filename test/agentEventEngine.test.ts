/**
 * M34 — motor de eventos dos agentes (SIMULADO), contra o PostgreSQL de teste e os contratos reais (barramento, ferramentas, política, exceções, alertas, auditoria, endpoints).
 * Jornadas: A evento permitido · B bloqueado (limite/pausa) · C dupla autorização · D rejeição · E pausa global · F segurança entre organizações · G idempotência · H concorrência.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/helpers/db";
import { publishDomainEvent } from "../src/helpers/domainEvents";
import { ensureAgentPrincipal } from "../src/helpers/agentRegistry";
import { advanceRun, runAgentEventEngine, countUnprocessedEvents } from "../src/helpers/agentEventEngine";
import { setAutomationControl } from "../src/helpers/automationControls";
import { setPolicyLimit } from "../src/helpers/policyLimits";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { handle as postOpportunity } from "../src/endpoints/opportunities_POST";
import { handle as postDecide } from "../src/endpoints/exception-queue-decide_POST";
import { handle as getRuns } from "../src/endpoints/agent-events_GET";
import { handle as postEngineRun } from "../src/endpoints/agent-engine-run_POST";
import type { MembershipRole } from "../src/helpers/schema";
import { createAuthenticatedUser, createPlatformAdmin, createTestOrganization, addMembership, buildRequest, parseJson, type AuthenticatedTestUser } from "./helpers";
import { handle as postPlatformControls } from "../src/endpoints/platform-automation-controls_POST";

const get = (path: string, a?: AuthenticatedTestUser) => buildRequest(path, { cookie: a?.cookie });
const post = (path: string, a: AuthenticatedTestUser | undefined, body: unknown) => buildRequest(path, { method: "POST", cookie: a?.cookie, body });
async function member(orgId: number, role: MembershipRole) { const u = await createAuthenticatedUser(); await addMembership(orgId, u.userId, role); return u; }

async function publish(orgId: number | null, type: string, payload: Record<string, unknown>, entityId = "1") {
  await db.transaction().execute((trx) => publishDomainEvent(trx, { eventType: type, organizationId: orgId, entityType: "teste", entityId, payload: payload as never }));
  const row = await db.selectFrom("domainEvents").select("id").orderBy("id", "desc").limit(1).executeTakeFirstOrThrow();
  return String(row.id);
}
const opp = (category: string | null, extra: Record<string, unknown> = {}) => ({ category, quantityOffered: 3, unit: "un", ...extra });
async function runOf(eventId: string) {
  return db.selectFrom("agentEventRuns").selectAll().where("eventId", "=", eventId).executeTakeFirst();
}
async function history(runId: string) {
  return (await db.selectFrom("agentEventRunHistory").select(["fromStatus", "toStatus", "reasonCode", "actorType"]).where("runId", "=", runId).orderBy("id", "asc").execute()).map((h) => `${h.fromStatus ?? "∅"}→${h.toStatus}`);
}

describe("motor de eventos (simulado)", () => {
  let owner: AuthenticatedTestUser; let orgId: number; let riskId: number;
  beforeEach(async () => {
    owner = await createAuthenticatedUser();
    orgId = (await createTestOrganization(owner.userId)).id;
    riskId = (await ensureAgentPrincipal(db, "risk-engine", orgId)).id;
  });

  describe("Jornada A — evento permitido (pelo endpoint real de oportunidades)", () => {
    it("recebe → valida → autoriza → conclui a SIMULAÇÃO, com histórico, auditoria e cadeia íntegra; nada fora do sistema", async () => {
      const res = await postOpportunity(post("opportunities", owner, { organizationId: orgId, title: "Roupas de inverno", category: "roupa", quantityOffered: 10, unit: "kg", donorName: "Doador Sintético" }));
      expect(res.status).toBe(200);
      const summary = await runAgentEventEngine({ organizationId: orgId });
      expect(summary.registered).toBe(1); expect(summary.byStatus.simulacao_concluida).toBe(1);
      const run = (await db.selectFrom("agentEventRuns").selectAll().where("organizationId", "=", orgId).executeTakeFirstOrThrow());
      expect(run).toMatchObject({ status: "simulacao_concluida", simulated: true, eventType: "opportunity.created", agentPrincipalId: riskId });
      expect(await history(String(run.id))).toEqual(["∅→recebido", "recebido→validado", "validado→autorizado_simulacao", "autorizado_simulacao→simulacao_concluida"]);
      const audit = await db.selectFrom("auditLog").select(["action", "actorType", "actorAgentPrincipalId"]).where("entityType", "=", "agent_event_run").orderBy("id").execute();
      expect(audit.map((a) => a.action)).toEqual(["agente.evento_validado", "agente.evento_autorizado_simulacao", "agente.evento_simulacao_concluida"]);
      expect(audit.every((a) => a.actorType === "agent" && a.actorAgentPrincipalId === riskId)).toBe(true);
      expect((await verifyAuditLogChain()).integra).toBe(true);
      expect((await db.selectFrom("integrityAlerts").select("id").where("organizationId", "=", orgId).execute()).length).toBe(0);
    });
  });

  describe("Jornada B — bloqueado por política/limite", () => {
    it("categoria de alto risco vira exceção (não avança), com alerta e motivo; a organização que restringe mais passa a exigir revisão de outra categoria", async () => {
      const e1 = await publish(orgId, "opportunity.created", opp("medicamento"));
      await runAgentEventEngine({ organizationId: orgId });
      const r1 = (await runOf(e1))!;
      expect(r1.status).toBe("aguardando_aprovacao"); expect(r1.ruleCode).toBe("R-CATEGORIA-ALTO-RISCO"); expect(r1.exceptionId).not.toBeNull();
      const ex = await db.selectFrom("exceptionQueue").selectAll().where("id", "=", r1.exceptionId!).executeTakeFirstOrThrow();
      expect(ex).toMatchObject({ organizationId: orgId, agentPrincipalId: riskId, approvalsRequired: 1, status: "pendente" });
      const alert = await db.selectFrom("integrityAlerts").selectAll().where("organizationId", "=", orgId).executeTakeFirstOrThrow();
      expect(alert).toMatchObject({ category: "agente_excecao_pendente", level: "operacional", status: "aberto", dedupeKey: `exc:${ex.id}`, entityType: "agent_event_run", entityId: String(r1.id) });

      // restrição própria da organização: "roupa" passa a ser de alto risco
      await db.transaction().execute((trx) => setPolicyLimit(trx, { organizationId: orgId, key: "HIGH_RISK_CATEGORIES", value: ["medicamento", "alimento_perecivel", "item_perigoso", "dinheiro", "roupa"], userId: owner.userId }));
      const e2 = await publish(orgId, "opportunity.created", opp("roupa"), "2");
      await runAgentEventEngine({ organizationId: orgId });
      expect((await runOf(e2))!.status).toBe("aguardando_aprovacao");
      // a mesma categoria em OUTRA organização continua permitida (a restrição é só da organização)
      const other = await createAuthenticatedUser(); const otherOrg = (await createTestOrganization(other.userId)).id; await ensureAgentPrincipal(db, "risk-engine", otherOrg);
      const e3 = await publish(otherOrg, "opportunity.created", opp("roupa"), "3");
      await runAgentEventEngine({ organizationId: otherOrg });
      expect((await runOf(e3))!.status).toBe("simulacao_concluida");
    });

    it("sem agente ligado o motor não faz nada; agente DESLIGADO também não; evento anterior ao registro do agente não é avaliado", async () => {
      const early = await publish(orgId, "opportunity.created", opp("roupa"), "early");
      await new Promise((r) => setTimeout(r, 20));
      await db.updateTable("agentPrincipals").set({ enabled: false, createdAt: new Date() }).where("id", "=", riskId).execute();
      const e = await publish(orgId, "opportunity.created", opp("roupa"), "off");
      expect((await runAgentEventEngine({ organizationId: orgId })).registered).toBe(0);
      expect(await runOf(e)).toBeUndefined();
      await db.updateTable("agentPrincipals").set({ enabled: true }).where("id", "=", riskId).execute();
      const s = await runAgentEventEngine({ organizationId: orgId });
      expect(s.registered).toBe(1); expect(await runOf(early)).toBeUndefined(); expect((await runOf(e))!.status).toBe("simulacao_concluida");
      expect(await countUnprocessedEvents(orgId)).toBe(0);
    });

    it("evento fora do contrato é IGNORADO com motivo (estrutura inválida), sem erro", async () => {
      const bad = await publish(orgId, "opportunity.created", { category: 42, quantityOffered: "x" });
      await runAgentEventEngine({ organizationId: orgId });
      const r = (await runOf(bad))!;
      expect(r).toMatchObject({ status: "ignorado", reasonCode: "estrutura_invalida" });
      expect(await history(String(r.id))).toEqual(["∅→recebido", "recebido→ignorado"]);
    });
  });

  describe("Jornada C — dupla autorização (valor acima do limite de aceite automático)", () => {
    it("dois revisores DISTINTOS; o primeiro mantém aguardando; o segundo autoriza SÓ para simulação; a conclusão é um passo separado; nada externo", async () => {
      const admin = await member(orgId, "administrador");
      const e = await publish(orgId, "opportunity.created", opp("roupa", { estimatedValue: 999999 }));
      await runAgentEventEngine({ organizationId: orgId });
      const run0 = (await runOf(e))!;
      expect(run0).toMatchObject({ status: "aguardando_aprovacao", ruleCode: "R-VALOR-ALTO-DUPLA" });
      const exId = String(run0.exceptionId);
      expect((await db.selectFrom("exceptionQueue").select("approvalsRequired").where("id", "=", exId).executeTakeFirstOrThrow()).approvalsRequired).toBe(2);
      expect((await db.selectFrom("integrityAlerts").select("level").where("organizationId", "=", orgId).executeTakeFirstOrThrow()).level).toBe("alto_risco");

      expect((await postDecide(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: exId, decision: "aprovar", notes: "ok 1" }))).status).toBe(200);
      expect((await runOf(e))!.status).toBe("aguardando_aprovacao");
      // a MESMA pessoa não satisfaz a segunda aprovação
      expect((await postDecide(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: exId, decision: "aprovar" }))).status).toBe(409);
      expect((await runOf(e))!.status).toBe("aguardando_aprovacao");

      expect((await postDecide(post("exception-queue-decide", admin, { organizationId: orgId, exceptionId: exId, decision: "aprovar", notes: "ok 2" }))).status).toBe(200);
      expect((await runOf(e))!.status).toBe("autorizado_simulacao"); // aprovar NÃO conclui
      expect((await db.selectFrom("exceptionQueue").select("consumedAt").where("id", "=", exId).executeTakeFirstOrThrow()).consumedAt).toBeNull();
      const alert = await db.selectFrom("integrityAlerts").selectAll().where("dedupeKey", "=", `exc:${exId}`).executeTakeFirstOrThrow();
      expect(alert.status).toBe("resolvido"); expect(alert.resolvedByUserId).toBe(admin.userId);

      const s = await runAgentEventEngine({ organizationId: orgId });
      expect(s.byStatus.simulacao_concluida).toBe(1);
      expect((await db.selectFrom("exceptionQueue").select("consumedAt").where("id", "=", exId).executeTakeFirstOrThrow()).consumedAt).not.toBeNull(); // uso único
      expect(await history(String(run0.id))).toEqual(["∅→recebido", "recebido→validado", "validado→aguardando_aprovacao", "aguardando_aprovacao→autorizado_simulacao", "autorizado_simulacao→simulacao_concluida"]);
      expect((await runOf(e))!.simulated).toBe(true);
      expect((await verifyAuditLogChain()).integra).toBe(true);
    });

    it("política ENDURECIDA entre a criação e a revisão: a aprovação simples não cobre mais a regra dupla → nova exceção dupla, nada concluído nem consumido", async () => {
      const e = await publish(orgId, "opportunity.created", opp("medicamento", { estimatedValue: 400 }));
      await runAgentEventEngine({ organizationId: orgId });
      const run = (await runOf(e))!; const exId = String(run.exceptionId);
      expect((await db.selectFrom("exceptionQueue").select("approvalsRequired").where("id", "=", exId).executeTakeFirstOrThrow()).approvalsRequired).toBe(1);
      expect((await postDecide(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: exId, decision: "aprovar" }))).status).toBe(200);
      expect((await runOf(e))!.status).toBe("autorizado_simulacao");
      const staff = await createPlatformAdmin();
      await db.transaction().execute((trx) => setPolicyLimit(trx, { organizationId: null, key: "AUTO_ACCEPT_MAX_VALUE", value: 100, userId: staff.userId }));
      await runAgentEventEngine({ organizationId: orgId });
      const after = (await runOf(e))!;
      expect(after.status).toBe("aguardando_aprovacao"); expect(after.reasonCode).toBe("politica_alterada"); expect(after.ruleCode).toBe("R-VALOR-ALTO-DUPLA");
      expect(String(after.exceptionId)).not.toBe(exId);
      expect((await db.selectFrom("exceptionQueue").select("approvalsRequired").where("id", "=", after.exceptionId!).executeTakeFirstOrThrow()).approvalsRequired).toBe(2);
      expect((await db.selectFrom("exceptionQueue").select("consumedAt").where("id", "=", exId).executeTakeFirstOrThrow()).consumedAt).toBeNull();
    });

    it("política AFROUXADA pela plataforma depois da aprovação: a regra deixou de se aplicar, conclui a simulação sem consumir a aprovação", async () => {
      const e = await publish(orgId, "opportunity.created", opp("medicamento"));
      await runAgentEventEngine({ organizationId: orgId });
      const exId = String((await runOf(e))!.exceptionId);
      await postDecide(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: exId, decision: "aprovar" }));
      const staff = await createPlatformAdmin();
      await db.transaction().execute((trx) => setPolicyLimit(trx, { organizationId: null, key: "HIGH_RISK_CATEGORIES", value: ["alimento_perecivel", "item_perigoso", "dinheiro"], userId: staff.userId }));
      await runAgentEventEngine({ organizationId: orgId });
      expect((await runOf(e))!.status).toBe("simulacao_concluida");
    });
  });

  describe("Jornada D — rejeição", () => {
    it("revisor rejeita: operação bloqueada (terminal), histórico preservado, alerta encerrado, reprocessar NÃO reabre", async () => {
      const e = await publish(orgId, "opportunity.created", opp("dinheiro"));
      await runAgentEventEngine({ organizationId: orgId });
      const run = (await runOf(e))!; const exId = String(run.exceptionId);
      expect((await postDecide(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: exId, decision: "rejeitar", notes: "não procede" }))).status).toBe(200);
      expect((await runOf(e))!.status).toBe("rejeitado");
      await runAgentEventEngine({ organizationId: orgId }); await runAgentEventEngine({ organizationId: orgId });
      expect((await runOf(e))!.status).toBe("rejeitado");
      expect(await history(String(run.id))).toEqual(["∅→recebido", "recebido→validado", "validado→aguardando_aprovacao", "aguardando_aprovacao→rejeitado"]);
      expect((await db.selectFrom("integrityAlerts").select("status").where("dedupeKey", "=", `exc:${exId}`).executeTakeFirstOrThrow()).status).toBe("resolvido");
      // decisão contraditória depois de finalizada
      expect((await postDecide(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: exId, decision: "aprovar" }))).status).toBe(409);
      expect((await runOf(e))!.status).toBe("rejeitado");
    });
  });

  describe("Jornada E — pausa global e da organização", () => {
    it("com pausa: o evento é registrado e fica BLOQUEADO (nada avança), com alerta; ao retomar, o motor segue de onde parou e o histórico permanece", async () => {
      const staff = await createPlatformAdmin();
      expect((await postPlatformControls(post("platform-automation-controls", staff, { paused: true, emergency: false, reason: "manutenção" }))).status).toBe(200);
      const e = await publish(orgId, "opportunity.created", opp("roupa"));
      await runAgentEventEngine({ organizationId: orgId });
      const paused = (await runOf(e))!;
      expect(paused).toMatchObject({ status: "bloqueado_politica", reasonCode: "automation_paused" });
      expect((await db.selectFrom("exceptionQueue").select("id").execute()).length).toBe(0);
      expect((await db.selectFrom("integrityAlerts").select("category").where("organizationId", "=", orgId).execute()).map((a) => a.category)).toEqual(["automacao_pausada"]);
      // repetir durante a pausa não faz nada novo
      await runAgentEventEngine({ organizationId: orgId }); await runAgentEventEngine({ organizationId: orgId });
      expect(await history(String(paused.id))).toEqual(["∅→recebido", "recebido→validado", "validado→bloqueado_politica"]);
      expect((await db.selectFrom("integrityAlerts").select("id").where("organizationId", "=", orgId).execute()).length).toBe(1);

      await postPlatformControls(post("platform-automation-controls", staff, { paused: false, emergency: false }));
      await runAgentEventEngine({ organizationId: orgId });
      expect((await runOf(e))!.status).toBe("simulacao_concluida");
      expect(await history(String(paused.id))).toEqual(["∅→recebido", "recebido→validado", "validado→bloqueado_politica", "bloqueado_politica→validado", "validado→autorizado_simulacao", "autorizado_simulacao→simulacao_concluida"]);
    });

    it("pausa ligada DEPOIS da aprovação humana: a execução autorizada não conclui até retomar", async () => {
      const e = await publish(orgId, "opportunity.created", opp("medicamento"));
      await runAgentEventEngine({ organizationId: orgId });
      const exId = String((await runOf(e))!.exceptionId);
      await postDecide(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: exId, decision: "aprovar" }));
      await db.transaction().execute((trx) => setAutomationControl(trx, { organizationId: orgId, paused: true, emergency: false, userId: owner.userId }));
      await runAgentEventEngine({ organizationId: orgId });
      expect((await runOf(e))!.status).toBe("bloqueado_politica");
      expect((await db.selectFrom("exceptionQueue").select("consumedAt").where("id", "=", exId).executeTakeFirstOrThrow()).consumedAt).toBeNull();
      await db.transaction().execute((trx) => setAutomationControl(trx, { organizationId: orgId, paused: false, emergency: false, userId: owner.userId }));
      await runAgentEventEngine({ organizationId: orgId });
      expect((await runOf(e))!.status).toBe("simulacao_concluida");
      expect((await db.selectFrom("exceptionQueue").select("consumedAt").where("id", "=", exId).executeTakeFirstOrThrow()).consumedAt).not.toBeNull();
    });
  });

  describe("Jornada F — segurança entre organizações", () => {
    it("usuário de outra organização não lê execuções nem processa; agente de uma organização não toca evento de outra; dado nenhum vaza", async () => {
      const e = await publish(orgId, "opportunity.created", opp("roupa"));
      await runAgentEventEngine({ organizationId: orgId });
      const intruder = await createAuthenticatedUser(); const intruderOrg = (await createTestOrganization(intruder.userId)).id;
      const denied = await getRuns(get(`agent-events?organizationId=${orgId}`, intruder));
      expect(denied.status).toBe(403); expect(JSON.stringify(await denied.text())).not.toMatch(/opportunity\.created/);
      expect((await postEngineRun(post("agent-engine-run", intruder, { organizationId: orgId }))).status).toBe(403);
      const own = await parseJson<{ runs: unknown[] }>(await getRuns(get(`agent-events?organizationId=${intruderOrg}`, intruder)));
      expect(own.runs).toEqual([]);
      // agente restrito à organização A não processa evento da organização B
      const other = await createAuthenticatedUser(); const orgB = (await createTestOrganization(other.userId)).id;
      const eB = await publish(orgB, "opportunity.created", opp("roupa"), "b");
      await runAgentEventEngine();
      expect(await runOf(eB)).toBeUndefined();
      // chamada direta da ferramenta com organização trocada é recusada pela camada de ferramentas
      const run = (await runOf(e))!;
      const { invokeAgentTool } = await import("../src/helpers/agentTools");
      const swapped = await invokeAgentTool({ principalId: riskId, toolName: "assess_event", input: { organizationId: orgB, runId: String(run.id) } });
      expect(swapped).toMatchObject({ status: "blocked", reason: "organization_mismatch" });
      expect((await verifyAuditLogChain()).integra).toBe(true);
    });

    it("voluntário e operador não leem nem disparam; proprietário e administrador sim", async () => {
      const vol = await member(orgId, "voluntario"); const op = await member(orgId, "operador"); const admin = await member(orgId, "administrador");
      for (const u of [vol, op]) { expect((await getRuns(get(`agent-events?organizationId=${orgId}`, u))).status).toBe(403); expect((await postEngineRun(post("agent-engine-run", u, { organizationId: orgId }))).status).toBe(403); }
      expect((await getRuns(get(`agent-events?organizationId=${orgId}`, admin))).status).toBe(200);
      expect((await postEngineRun(post("agent-engine-run", admin, { organizationId: orgId }))).status).toBe(200);
      expect((await getRuns(get(`agent-events?organizationId=${orgId}`))).status).toBe(401);
    });
  });

  describe("Jornada G — idempotência", () => {
    it("o mesmo evento processado várias vezes (e em sequência de passadas) gera UMA execução, UMA exceção e UM alerta", async () => {
      const e = await publish(orgId, "opportunity.created", opp("medicamento"));
      for (let i = 0; i < 4; i++) await runAgentEventEngine({ organizationId: orgId });
      expect((await db.selectFrom("agentEventRuns").select("id").where("eventId", "=", e).execute()).length).toBe(1);
      expect((await db.selectFrom("exceptionQueue").select("id").where("organizationId", "=", orgId).execute()).length).toBe(1);
      expect((await db.selectFrom("integrityAlerts").select("id").where("organizationId", "=", orgId).execute()).length).toBe(1);
      const run = (await runOf(e))!;
      expect(await history(String(run.id))).toEqual(["∅→recebido", "recebido→validado", "validado→aguardando_aprovacao"]);
      // reavaliar uma execução que já passou do ponto devolve o estado atual sem duplicar nada
      expect((await advanceRun(String(run.id))).status).toBe("aguardando_aprovacao");
      // a UNIQUE do banco impede uma segunda execução para o par (evento, agente)
      await expect(db.insertInto("agentEventRuns").values({ eventId: e, agentPrincipalId: riskId, organizationId: orgId, eventType: "opportunity.created", status: "recebido" }).execute()).rejects.toThrow();
    });
    it("o banco recusa 'simulated = false' e apagar/alterar histórico", async () => {
      const e = await publish(orgId, "opportunity.created", opp("roupa"));
      await runAgentEventEngine({ organizationId: orgId });
      const run = (await runOf(e))!;
      await expect(db.updateTable("agentEventRuns").set({ simulated: false }).where("id", "=", run.id).execute()).rejects.toThrow();
      await expect(db.deleteFrom("agentEventRunHistory").where("runId", "=", run.id).execute()).rejects.toThrow();
      await expect(db.updateTable("agentEventRunHistory").set({ toStatus: "falha" }).where("runId", "=", run.id).execute()).rejects.toThrow();
    });
  });

  describe("Jornada H — concorrência", () => {
    it("duas instâncias do motor ao mesmo tempo: uma execução por evento, sem corrupção de estado", async () => {
      const ids = [] as string[];
      for (let i = 0; i < 6; i++) ids.push(await publish(orgId, "opportunity.created", opp(i % 2 ? "medicamento" : "roupa"), `c${i}`));
      await Promise.all([runAgentEventEngine({ organizationId: orgId }), runAgentEventEngine({ organizationId: orgId }), runAgentEventEngine({ organizationId: orgId })]);
      for (const id of ids) expect((await db.selectFrom("agentEventRuns").select("id").where("eventId", "=", id).execute()).length).toBe(1);
      await runAgentEventEngine({ organizationId: orgId });
      const statuses = (await db.selectFrom("agentEventRuns").select("status").where("organizationId", "=", orgId).execute()).map((r) => r.status).sort();
      expect(statuses).toEqual(["aguardando_aprovacao", "aguardando_aprovacao", "aguardando_aprovacao", "simulacao_concluida", "simulacao_concluida", "simulacao_concluida"]);
      expect((await db.selectFrom("exceptionQueue").select("id").where("organizationId", "=", orgId).execute()).length).toBe(3);
      expect((await verifyAuditLogChain()).integra).toBe(true);
    });
    it("duas decisões simultâneas sobre a MESMA exceção: só uma transição prevalece; a outra recebe conflito", async () => {
      const admin = await member(orgId, "administrador");
      const e = await publish(orgId, "opportunity.created", opp("medicamento"));
      await runAgentEventEngine({ organizationId: orgId });
      const exId = String((await runOf(e))!.exceptionId);
      const [a, b] = await Promise.all([
        postDecide(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: exId, decision: "aprovar" })),
        postDecide(post("exception-queue-decide", admin, { organizationId: orgId, exceptionId: exId, decision: "rejeitar" })),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const final = (await runOf(e))!.status;
      const exStatus = (await db.selectFrom("exceptionQueue").select("status").where("id", "=", exId).executeTakeFirstOrThrow()).status;
      expect(final).toBe(exStatus === "aprovada" ? "autorizado_simulacao" : "rejeitado");
      expect((await db.selectFrom("exceptionDecisions").select("userId").where("exceptionId", "=", exId).execute()).length).toBe(1);
    });
    it("duas conclusões simultâneas da mesma execução autorizada: o uso da aprovação é único", async () => {
      const e = await publish(orgId, "opportunity.created", opp("medicamento"));
      await runAgentEventEngine({ organizationId: orgId });
      const run = (await runOf(e))!; const exId = String(run.exceptionId);
      await postDecide(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: exId, decision: "aprovar" }));
      const results = await Promise.all([advanceRun(String(run.id)), advanceRun(String(run.id)), advanceRun(String(run.id))]);
      expect(results.filter((r) => r.status === "simulacao_concluida").length).toBeGreaterThanOrEqual(1);
      expect((await runOf(e))!.status).toBe("simulacao_concluida");
      expect((await db.selectFrom("agentEventRunHistory").select("id").where("runId", "=", run.id).where("toStatus", "=", "simulacao_concluida").execute()).length).toBe(1);
    });
  });

  describe("falhas inesperadas", () => {
    it("falha repetida encerra com 'falha' (histórico mantido) e cria alerta; não apaga nada", async () => {
      const e2 = await publish(orgId, "opportunity.created", opp("roupa"), "f2");
      await db.transaction().execute(async (trx) => {
        await trx.insertInto("agentEventRuns").values({ eventId: e2, agentPrincipalId: riskId, organizationId: orgId, eventType: "opportunity.created", status: "validado", attempts: 3, reasonCode: "erro_inesperado" }).execute();
      });
      const fresh = await db.selectFrom("agentEventRuns").select("id").where("eventId", "=", e2).executeTakeFirstOrThrow();
      expect((await advanceRun(String(fresh.id))).status).toBe("falha");
      expect((await runOf(e2))!.status).toBe("falha");
      expect((await db.selectFrom("integrityAlerts").select("category").where("organizationId", "=", orgId).where("category", "=", "agente_falha_repetida").execute()).length).toBe(1);
    });
  });
});
