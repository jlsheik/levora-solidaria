/**
 * M33 — endpoints de leitura/limites da plataforma de agentes: visão geral (`agents`), limites de política, leitura da pausa global e histórico de decisões da fila.
 * Cobrem permissão no servidor, isolamento entre organizações, regra "só mais restritivo", auditoria e o histórico de decisões. Rodam contra o PostgreSQL de teste.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/helpers/db";
import { handle as getAgents } from "../src/endpoints/agents_GET";
import { handle as getPolicyLimits } from "../src/endpoints/policy-limits_GET";
import { handle as postPolicyLimits } from "../src/endpoints/policy-limits_POST";
import { handle as getPlatformControls } from "../src/endpoints/platform-automation-controls_GET";
import { handle as postPlatformControls } from "../src/endpoints/platform-automation-controls_POST";
import { handle as postControls } from "../src/endpoints/automation-controls_POST";
import { handle as getExceptions } from "../src/endpoints/exception-queue_GET";
import { handle as postExceptionDecide } from "../src/endpoints/exception-queue-decide_POST";
import { createIntegrityAlert } from "../src/helpers/integrityAlerts";
import { ensureAgentPrincipal, AGENT_DEFINITIONS } from "../src/helpers/agentRegistry";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import type { MembershipRole } from "../src/helpers/schema";
import { createAuthenticatedUser, createPlatformAdmin, createTestOrganization, addMembership, buildRequest, parseJson, type AuthenticatedTestUser } from "./helpers";

async function member(orgId: number, role: MembershipRole) {
  const person = await createAuthenticatedUser();
  await addMembership(orgId, person.userId, role);
  return person;
}
const get = (path: string, actor?: AuthenticatedTestUser) => buildRequest(path, { cookie: actor?.cookie });
const post = (path: string, actor: AuthenticatedTestUser | undefined, body: unknown) => buildRequest(path, { method: "POST", cookie: actor?.cookie, body });

type Overview = {
  agents: Array<{ name: string; label: string; purpose: string; registered: boolean; enabled: boolean | null; scope: string; openAlerts: number; pendingExceptions: number; tools: Array<{ name: string; klass: string }> }>;
  summary: { total: number; registered: number; enabled: number; disabled: number; withOpenAlerts: number; withPendingExceptions: number };
  automation: { paused: boolean; emergency: boolean };
};

describe("GET agents (visão geral)", () => {
  let owner: AuthenticatedTestUser;
  let orgId: number;
  beforeEach(async () => {
    owner = await createAuthenticatedUser();
    orgId = (await createTestOrganization(owner.userId)).id;
  });

  it("lista TODAS as definições do código, sem principal = 'não registrado', com ferramentas e sem poder mutador", async () => {
    const res = await getAgents(get(`agents?organizationId=${orgId}`, owner));
    expect(res.status).toBe(200);
    const body = await parseJson<Overview>(res);
    expect(body.agents.map((a) => a.name).sort()).toEqual(Object.keys(AGENT_DEFINITIONS).sort());
    expect(body.summary.total).toBe(Object.keys(AGENT_DEFINITIONS).length);
    expect(body.summary.registered).toBe(0);
    expect(body.agents.every((a) => !a.registered && a.enabled === null && a.scope === "nao_registrado")).toBe(true);
    expect(body.agents.every((a) => a.label && a.purpose)).toBe(true);
    // invariante: nenhuma ferramenta "mutate" existe; M34 acrescenta só a classe "simulate" (registra a avaliação do evento, não executa nada)
    expect(body.agents.flatMap((a) => a.tools).every((t) => ["read", "alert", "simulate"].includes(t.klass))).toBe(true);
    expect(body.agents.flatMap((a) => a.tools).some((t) => t.klass === "mutate")).toBe(false);
    expect(body.agents.find((a) => a.name === "risk-engine")!.eventTypes).toEqual(["opportunity.created"]);
    expect(body.automation).toMatchObject({ paused: false, emergency: false });
  });

  it("conta alertas abertos e exceções pendentes SÓ da própria organização", async () => {
    const other = await createAuthenticatedUser();
    const otherOrg = (await createTestOrganization(other.userId)).id;
    const name = Object.keys(AGENT_DEFINITIONS)[0];
    const principal = await ensureAgentPrincipal(db, name, null);
    await db.transaction().execute((trx) => createIntegrityAlert(trx, { organizationId: orgId, level: "operacional", category: "teste", title: "A", dedupeKey: "k1", agentPrincipalId: principal.id }));
    await db.transaction().execute((trx) => createIntegrityAlert(trx, { organizationId: otherOrg, level: "operacional", category: "teste", title: "B", dedupeKey: "k2", agentPrincipalId: principal.id }));
    for (const o of [orgId, otherOrg, otherOrg]) {
      await db.insertInto("exceptionQueue").values({ organizationId: o, agentPrincipalId: principal.id, toolName: "t", ruleCode: "R", approvalsRequired: 1, request: {}, requestHash: `h-${Math.random()}` }).execute();
    }
    const body = await parseJson<Overview>(await getAgents(get(`agents?organizationId=${orgId}`, owner)));
    const row = body.agents.find((a) => a.name === name)!;
    expect(row.registered).toBe(true); expect(row.enabled).toBe(true); expect(row.openAlerts).toBe(1); expect(row.pendingExceptions).toBe(1);
    expect(body.summary.withOpenAlerts).toBe(1); expect(body.summary.withPendingExceptions).toBe(1);
  });

  it("agente desligado aparece como desligado e a pausa da organização aparece no resumo", async () => {
    const name = Object.keys(AGENT_DEFINITIONS)[0];
    const principal = await ensureAgentPrincipal(db, name, null);
    await db.updateTable("agentPrincipals").set({ enabled: false }).where("id", "=", principal.id).execute();
    await postControls(post("automation-controls", owner, { organizationId: orgId, paused: true, emergency: false }));
    const body = await parseJson<Overview>(await getAgents(get(`agents?organizationId=${orgId}`, owner)));
    expect(body.agents.find((a) => a.name === name)!.enabled).toBe(false); expect(body.summary.disabled).toBe(1); expect(body.automation.paused).toBe(true);
  });

  it("administrador lê; operador, voluntário e quem não é membro são recusados; sem sessão é 401; organização inválida é 400", async () => {
    const admin = await member(orgId, "administrador");
    expect((await getAgents(get(`agents?organizationId=${orgId}`, admin))).status).toBe(200);
    for (const role of ["operador", "voluntario"] as MembershipRole[]) {
      const p = await member(orgId, role);
      expect([401, 403, 404]).toContain((await getAgents(get(`agents?organizationId=${orgId}`, p))).status);
      expect((await getAgents(get(`agents?organizationId=${orgId}`, p))).status).not.toBe(200);
    }
    const stranger = await createAuthenticatedUser();
    expect((await getAgents(get(`agents?organizationId=${orgId}`, stranger))).status).not.toBe(200);
    expect((await getAgents(get(`agents?organizationId=${orgId}`))).status).toBe(401);
    expect((await getAgents(get(`agents?organizationId=abc`, owner))).status).toBe(400);
  });
});

describe("limites de política (GET/POST)", () => {
  let owner: AuthenticatedTestUser;
  let orgId: number;
  beforeEach(async () => {
    owner = await createAuthenticatedUser();
    orgId = (await createTestOrganization(owner.userId)).id;
  });
  type Limits = { limits: Array<{ key: string; kind: string; defaultValue: number | string[]; globalValue: number | string[]; organizationValue: number | string[] | null; effectiveValue: number | string[] }> };
  const read = async (id = orgId, actor = owner) => parseJson<Limits>(await getPolicyLimits(get(`policy-limits?organizationId=${id}`, actor)));

  it("lê padrão, global, da organização e efetivo", async () => {
    const { limits } = await read();
    expect(limits.length).toBeGreaterThan(0);
    for (const l of limits) { expect(l.organizationValue).toBeNull(); expect(l.effectiveValue).toEqual(l.globalValue); expect(l.defaultValue).toEqual(l.globalValue); }
  });

  it("organização restringe (número menor) → efetivo muda, só para ela, e a alteração fica auditada com cadeia íntegra", async () => {
    const other = await createAuthenticatedUser();
    const otherOrg = (await createTestOrganization(other.userId)).id;
    const num = (await read()).limits.find((l) => l.kind === "number")!;
    const stricter = (num.globalValue as number) / 2;
    const res = await postPolicyLimits(post("policy-limits", owner, { organizationId: orgId, key: num.key, value: stricter }));
    expect(res.status).toBe(200);
    const mine = (await read()).limits.find((l) => l.key === num.key)!;
    expect(mine.organizationValue).toBe(stricter); expect(mine.effectiveValue).toBe(stricter); expect(mine.globalValue).toBe(num.globalValue);
    expect((await read(otherOrg, other)).limits.find((l) => l.key === num.key)!.organizationValue).toBeNull();
    const audit = await db.selectFrom("auditLog").select(["action", "organizationId"]).where("action", "=", "politica.limite_alterado").execute();
    expect(audit.length).toBe(1); expect(audit[0].organizationId).toBe(orgId);
    const chain = await verifyAuditLogChain();
    expect(chain.integra).toBe(true);
  });

  it("valor MAIS frouxo que o global é recusado e nada é gravado", async () => {
    const num = (await read()).limits.find((l) => l.kind === "number")!;
    const res = await postPolicyLimits(post("policy-limits", owner, { organizationId: orgId, key: num.key, value: (num.globalValue as number) + 1 }));
    expect(res.status).toBe(409);
    expect((await read()).limits.find((l) => l.key === num.key)!.organizationValue).toBeNull();
    expect((await db.selectFrom("auditLog").select("id").where("action", "=", "politica.limite_alterado").execute()).length).toBe(0);
  });

  it("lista: só pode acrescentar categorias; remover uma global é recusado", async () => {
    const list = (await read()).limits.find((l) => l.kind === "list" && (l.globalValue as string[]).length > 0)!;
    expect(list, "deve existir um limite de lista com padrão").toBeTruthy();
    const g = list.globalValue as string[];
    expect((await postPolicyLimits(post("policy-limits", owner, { organizationId: orgId, key: list.key, value: [...g, "categoria-extra"] }))).status).toBe(200);
    expect((await postPolicyLimits(post("policy-limits", owner, { organizationId: orgId, key: list.key, value: g.slice(1) }))).status).toBe(409);
  });

  it("chave desconhecida (inclusive propriedades herdadas de Object) é recusada", async () => {
    for (const key of ["NAO_EXISTE", "toString", "__proto__", "constructor"]) {
      const res = await postPolicyLimits(post("policy-limits", owner, { organizationId: orgId, key, value: 1 }));
      expect([400, 409]).toContain(res.status);
    }
  });

  it("valores inválidos (negativo, NaN, tipo errado) são recusados", async () => {
    const num = (await read()).limits.find((l) => l.kind === "number")!;
    for (const value of [-1, "abc", null, { a: 1 }]) expect((await postPolicyLimits(post("policy-limits", owner, { organizationId: orgId, key: num.key, value }))).status).toBeGreaterThanOrEqual(400);
  });

  it("administrador altera; operador não lê nem altera; outra organização não lê o que não é dela", async () => {
    const admin = await member(orgId, "administrador");
    const op = await member(orgId, "operador");
    const num = (await read()).limits.find((l) => l.kind === "number")!;
    expect((await postPolicyLimits(post("policy-limits", admin, { organizationId: orgId, key: num.key, value: 0 }))).status).toBe(200);
    expect((await getPolicyLimits(get(`policy-limits?organizationId=${orgId}`, op))).status).not.toBe(200);
    expect((await postPolicyLimits(post("policy-limits", op, { organizationId: orgId, key: num.key, value: 0 }))).status).not.toBe(200);
    const stranger = await createAuthenticatedUser();
    expect((await getPolicyLimits(get(`policy-limits?organizationId=${orgId}`, stranger))).status).not.toBe(200);
    expect((await postPolicyLimits(post("policy-limits", stranger, { organizationId: orgId, key: num.key, value: 0 }))).status).not.toBe(200);
    expect((await getPolicyLimits(get(`policy-limits?organizationId=${orgId}`))).status).toBe(401);
  });
});

describe("pausa global: leitura só pela equipe da plataforma", () => {
  it("administrador da plataforma lê e altera; proprietário de organização NÃO (403); sem sessão 401", async () => {
    const owner = await createAuthenticatedUser();
    await createTestOrganization(owner.userId);
    const staff = await createPlatformAdmin();
    expect((await getPlatformControls(get("platform-automation-controls", owner))).status).toBe(403);
    expect((await getPlatformControls(get("platform-automation-controls"))).status).toBe(401);
    const before = await parseJson<{ global: { paused: boolean } }>(await getPlatformControls(get("platform-automation-controls", staff)));
    expect(before.global.paused).toBe(false);
    expect((await postPlatformControls(post("platform-automation-controls", staff, { paused: true, emergency: false, reason: "manutenção" }))).status).toBe(200);
    const after = await parseJson<{ global: { paused: boolean; reason: string | null } }>(await getPlatformControls(get("platform-automation-controls", staff)));
    expect(after.global).toMatchObject({ paused: true, reason: "manutenção" });
    expect((await postPlatformControls(post("platform-automation-controls", owner, { paused: false, emergency: false }))).status).toBe(403);
  });
});

describe("histórico de decisões na fila de exceções", () => {
  it("duas decisões aparecem com autor, justificativa e 'byYou' coerente para cada leitor", async () => {
    const owner = await createAuthenticatedUser();
    const orgId = (await createTestOrganization(owner.userId)).id;
    const admin = await member(orgId, "administrador");
    const principal = await ensureAgentPrincipal(db, Object.keys(AGENT_DEFINITIONS)[0], null);
    const row = await db.insertInto("exceptionQueue").values({ organizationId: orgId, agentPrincipalId: principal.id, toolName: "t", ruleCode: "R-VALOR-ALTO-DUPLA", approvalsRequired: 2, request: { v: 1 }, requestHash: `h-${Math.random()}` }).returning("id").executeTakeFirstOrThrow();
    const id = String(row.id);
    expect((await postExceptionDecide(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: id, decision: "aprovar", notes: "primeira" }))).status).toBe(200);
    // a mesma pessoa não conta duas vezes
    expect((await postExceptionDecide(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: id, decision: "aprovar" }))).status).toBeGreaterThanOrEqual(400);
    type Q = { exceptions: Array<{ status: string; approvals: number; myDecision: string | null; decisions: Array<{ decision: string; notes: string | null; byYou: boolean; userDisplayName: string }> }> };
    let q = await parseJson<Q>(await getExceptions(get(`exception-queue?organizationId=${orgId}&status=pendente`, admin)));
    expect(q.exceptions[0].approvals).toBe(1); expect(q.exceptions[0].myDecision).toBeNull(); expect(q.exceptions[0].decisions).toHaveLength(1);
    expect(q.exceptions[0].decisions[0]).toMatchObject({ decision: "aprovar", notes: "primeira", byYou: false });
    expect((await postExceptionDecide(post("exception-queue-decide", admin, { organizationId: orgId, exceptionId: id, decision: "aprovar", notes: "segunda" }))).status).toBe(200);
    q = await parseJson<Q>(await getExceptions(get(`exception-queue?organizationId=${orgId}&status=aprovada`, owner)));
    expect(q.exceptions[0].status).toBe("aprovada"); expect(q.exceptions[0].decisions.map((d) => d.byYou).sort()).toEqual([false, true]);
    expect((await verifyAuditLogChain()).integra).toBe(true);
  });
});
