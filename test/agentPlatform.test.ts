import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { db } from "../src/helpers/db";
import { computeAuditEventHash, recordAuditLogEntry } from "../src/helpers/auditLog";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import {
  POLICY_LIMIT_DEFS,
  getEffectivePolicyLimits,
  getGlobalPolicyLimits,
  setPolicyLimit,
} from "../src/helpers/policyLimits";
import { evaluatePolicy } from "../src/helpers/policyRules";
import { getAutomationState, setAutomationControl } from "../src/helpers/automationControls";
import { consumeDomainEvents, publishDomainEvent } from "../src/helpers/domainEvents";
import { ensureAgentPrincipal } from "../src/helpers/agentRegistry";
import { createToolInvoker, defineTool, invokeAgentTool } from "../src/helpers/agentTools";
import { decideException } from "../src/helpers/exceptionQueue";
import { createIntegrityAlert } from "../src/helpers/integrityAlerts";
import { createTestUser, createTestOrganization } from "./helpers";

async function newOrg() {
  const owner = await createTestUser();
  const org = await createTestOrganization(owner.id);
  return { owner, org };
}

async function auditRows(orgId: number | null) {
  return db
    .selectFrom("auditLog")
    .select(["action", "actorType", "actorAgentPrincipalId", "metadata"])
    .where("organizationId", orgId === null ? "is" : "=", orgId)
    .orderBy("id", "asc")
    .execute();
}

describe("auditoria com autor agente/sistema", () => {
  it("hash de evento de usuário não muda (histórico continua verificável)", () => {
    const base = {
      organizationId: 1,
      actorUserId: 2,
      action: "x.y",
      entityType: "t",
      entityId: "1",
      metadata: { a: 1 },
      createdAt: new Date("2026-01-01T00:00:00Z"),
      previousEventHash: null,
    };
    expect(computeAuditEventHash({ ...base, actorType: "user" })).toBe(computeAuditEventHash(base));
  });

  it("autor agente ou sistema entra no hash", () => {
    const base = {
      organizationId: 1,
      actorUserId: null,
      action: "x.y",
      entityType: "t",
      entityId: "1",
      metadata: {},
      createdAt: new Date("2026-01-01T00:00:00Z"),
      previousEventHash: null,
    };
    const user = computeAuditEventHash(base);
    expect(computeAuditEventHash({ ...base, actorType: "system" })).not.toBe(user);
    expect(computeAuditEventHash({ ...base, actorType: "agent", actorAgentPrincipalId: 1 })).not.toBe(
      computeAuditEventHash({ ...base, actorType: "agent", actorAgentPrincipalId: 2 })
    );
  });

  it("evento de agente sem principal é recusado e a cadeia mista continua íntegra", async () => {
    const { org } = await newOrg();
    await expect(
      recordAuditLogEntry({ organizationId: org.id, actorUserId: null, actorType: "agent", action: "a.b", entityType: "t" })
    ).rejects.toThrow(/actorAgentPrincipalId/);

    const principal = await ensureAgentPrincipal(db, "sentinela-integridade", null);
    await recordAuditLogEntry({ organizationId: org.id, actorUserId: null, actorType: "system", action: "a.sistema", entityType: "t" });
    await recordAuditLogEntry({
      organizationId: org.id,
      actorUserId: null,
      actorType: "agent",
      actorAgentPrincipalId: principal.id,
      action: "a.agente",
      entityType: "t",
    });
    await recordAuditLogEntry({ organizationId: org.id, actorUserId: null, action: "a.usuario", entityType: "t" });

    const chain = await verifyAuditLogChain();
    expect(chain.integra).toBe(true);
    expect(chain.divergencias).toHaveLength(0);
  });
});

describe("limites de política", () => {
  it("padrões conservadores de código quando nada foi configurado", async () => {
    const limits = await getGlobalPolicyLimits(db);
    expect(limits.AUTO_ACCEPT_MAX_VALUE).toBe(POLICY_LIMIT_DEFS.AUTO_ACCEPT_MAX_VALUE.default);
    expect(limits.AUTO_LOGISTICS_MAX_COST).toBe(0);
    expect(limits.HIGH_RISK_CATEGORIES).toContain("medicamento");
  });

  it("organização só pode restringir: mais baixo/mais itens passa; mais frouxo é recusado", async () => {
    const { owner, org } = await newOrg();
    await db.transaction().execute(async (trx) => {
      await setPolicyLimit(trx, { organizationId: org.id, key: "AUTO_ACCEPT_MAX_VALUE", value: 100, userId: owner.id });
      await setPolicyLimit(trx, { organizationId: org.id, key: "HIGH_RISK_CATEGORIES", value: ["roupa_usada", "medicamento", "alimento_perecivel", "item_perigoso", "dinheiro"], userId: owner.id });
    });
    const limits = await getEffectivePolicyLimits(db, org.id);
    expect(limits.AUTO_ACCEPT_MAX_VALUE).toBe(100);
    expect(limits.HIGH_RISK_CATEGORIES).toContain("roupa_usada");

    await expect(
      db.transaction().execute((trx) => setPolicyLimit(trx, { organizationId: org.id, key: "AUTO_ACCEPT_MAX_VALUE", value: 99999, userId: owner.id }))
    ).rejects.toThrow(/mais restritivo/);
    await expect(
      db.transaction().execute((trx) => setPolicyLimit(trx, { organizationId: org.id, key: "HIGH_RISK_CATEGORIES", value: ["so_um"], userId: owner.id }))
    ).rejects.toThrow(/mais restritivo/);
  });

  it("valor frouxo gravado direto no banco nunca vence o global (leitura aplica o mais restritivo)", async () => {
    const { org } = await newOrg();
    await db.insertInto("policyLimits").values({ organizationId: org.id, key: "AUTO_ACCEPT_MAX_VALUE", value: { v: 1_000_000 } }).execute();
    const limits = await getEffectivePolicyLimits(db, org.id);
    expect(limits.AUTO_ACCEPT_MAX_VALUE).toBe(POLICY_LIMIT_DEFS.AUTO_ACCEPT_MAX_VALUE.default);
  });

  it("valor corrompido no banco é ignorado (cai no padrão) e entrada inválida é recusada", async () => {
    const { owner, org } = await newOrg();
    await db.insertInto("policyLimits").values({ organizationId: null, key: "AUTO_PICKUP_MAX_DISTANCE_KM", value: { v: "abc" } }).execute();
    expect((await getGlobalPolicyLimits(db)).AUTO_PICKUP_MAX_DISTANCE_KM).toBe(50);

    await expect(
      db.transaction().execute((trx) => setPolicyLimit(trx, { organizationId: org.id, key: "AUTO_ACCEPT_MAX_VALUE", value: -5, userId: owner.id }))
    ).rejects.toThrow();
    await expect(
      db.transaction().execute((trx) => setPolicyLimit(trx, { organizationId: null, key: "CHAVE_INEXISTENTE", value: 1, userId: owner.id }))
    ).rejects.toThrow(/desconhecido/);
  });

  it("alteração é auditada sem o valor, só chave e escopo", async () => {
    const { owner, org } = await newOrg();
    await db.transaction().execute((trx) => setPolicyLimit(trx, { organizationId: org.id, key: "AUTO_ACCEPT_MAX_VALUE", value: 10, userId: owner.id }));
    const rows = (await auditRows(org.id)).filter((r) => r.action === "politica.limite_alterado");
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toEqual({ chave: "AUTO_ACCEPT_MAX_VALUE", escopo: "organizacao" });
  });
});

describe("motor de regras (puro)", () => {
  async function limits() {
    return getGlobalPolicyLimits(db);
  }

  it("segue automático quando nada ultrapassa os limites", async () => {
    expect(evaluatePolicy({ estimatedValue: 100, category: "roupa", distanceKm: 10, logisticsCost: 0 }, await limits()).effect).toBe("allow");
  });

  it("qualquer valor financeiro acima do limite padrão (0) exige dupla autorização", async () => {
    const decision = evaluatePolicy({ financialAmount: 1 }, await limits());
    expect(decision.effect).toBe("dual_approval");
    if (decision.effect !== "allow") expect(decision.approvalsRequired).toBe(2);
  });

  it("categoria de alto risco exige revisão simples; distância e custo também", async () => {
    const l = await limits();
    expect(evaluatePolicy({ category: " Medicamento " }, l)).toMatchObject({ effect: "require_review", approvalsRequired: 1 });
    expect(evaluatePolicy({ distanceKm: 51 }, l)).toMatchObject({ effect: "require_review", ruleCode: "R-DISTANCIA-COLETA" });
    expect(evaluatePolicy({ logisticsCost: 1 }, l)).toMatchObject({ effect: "require_review", ruleCode: "R-CUSTO-LOGISTICO" });
  });

  it("com várias violações vale a mais severa e todas ficam listadas", async () => {
    const decision = evaluatePolicy({ estimatedValue: 9999, category: "medicamento", distanceKm: 500 }, await limits());
    expect(decision.effect).toBe("dual_approval");
    expect(decision.violations.length).toBeGreaterThanOrEqual(3);
  });
});

describe("pausar automação e emergência", () => {
  it("sem registro não está pausada; pausa da organização não afeta outra", async () => {
    const a = await newOrg();
    const b = await newOrg();
    expect((await getAutomationState(db, a.org.id)).paused).toBe(false);
    await db.transaction().execute((trx) =>
      setAutomationControl(trx, { organizationId: a.org.id, paused: true, emergency: false, reason: "teste", userId: a.owner.id })
    );
    expect((await getAutomationState(db, a.org.id)).paused).toBe(true);
    expect((await getAutomationState(db, b.org.id)).paused).toBe(false);
  });

  it("pausa global vale para todas; emergência implica pausa e não aceita 'não pausada'", async () => {
    const a = await newOrg();
    await db.transaction().execute((trx) =>
      setAutomationControl(trx, { organizationId: null, paused: true, emergency: true, userId: a.owner.id })
    );
    const state = await getAutomationState(db, a.org.id);
    expect(state.paused).toBe(true);
    expect(state.emergency).toBe(true);
    await expect(
      db.transaction().execute((trx) => setAutomationControl(trx, { organizationId: null, paused: false, emergency: true, userId: a.owner.id }))
    ).rejects.toThrow(/emergência/);
  });

  it("retomar a organização não vence a pausa global e a mudança é auditada", async () => {
    const a = await newOrg();
    await db.transaction().execute(async (trx) => {
      await setAutomationControl(trx, { organizationId: null, paused: true, emergency: false, userId: a.owner.id });
      await setAutomationControl(trx, { organizationId: a.org.id, paused: true, emergency: false, userId: a.owner.id });
      await setAutomationControl(trx, { organizationId: a.org.id, paused: false, emergency: false, userId: a.owner.id });
    });
    expect((await getAutomationState(db, a.org.id)).paused).toBe(true);
    const rows = (await auditRows(a.org.id)).filter((r) => r.action === "automacao.controle_alterado");
    expect(rows).toHaveLength(2);
  });
});

describe("barramento de eventos", () => {
  it("evento só existe se a transação do negócio confirmou", async () => {
    const { org } = await newOrg();
    await expect(
      db.transaction().execute(async (trx) => {
        await publishDomainEvent(trx, { eventType: "teste.criado", organizationId: org.id, entityType: "teste", entityId: "1" });
        throw new Error("falha no negócio");
      })
    ).rejects.toThrow("falha no negócio");
    expect(await db.selectFrom("domainEvents").select("id").execute()).toHaveLength(0);
  });

  async function publish(count: number, orgId: number, type = "teste.criado") {
    for (let i = 0; i < count; i++) {
      await db.transaction().execute((trx) =>
        publishDomainEvent(trx, { eventType: type, organizationId: orgId, entityType: "teste", entityId: String(i), payload: { i } })
      );
    }
  }

  it("cada consumidor processa cada evento uma vez e consumidores são independentes", async () => {
    const { org } = await newOrg();
    await publish(3, org.id);
    const seenA: string[] = [];
    const seenB: string[] = [];

    const first = await consumeDomainEvents({ consumer: "a", handler: async (_trx, e) => void seenA.push(e.id) });
    expect(first).toEqual({ processed: 3, failed: 0, skipped: 0 });
    const second = await consumeDomainEvents({ consumer: "a", handler: async (_trx, e) => void seenA.push(e.id) });
    expect(second.processed).toBe(0);
    await consumeDomainEvents({ consumer: "b", handler: async (_trx, e) => void seenB.push(e.id) });
    expect(seenA).toHaveLength(3);
    expect(seenB).toHaveLength(3);
  });

  it("filtra por tipo", async () => {
    const { org } = await newOrg();
    await publish(2, org.id, "estoque.criado");
    await publish(1, org.id, "outro.tipo");
    const seen: string[] = [];
    await consumeDomainEvents({ consumer: "f", eventTypes: ["estoque.criado"], handler: async (_t, e) => void seen.push(e.eventType) });
    expect(seen).toEqual(["estoque.criado", "estoque.criado"]);
  });

  it("falha reverte os efeitos do handler, é repetida até o limite e depois desiste", async () => {
    const { org } = await newOrg();
    await publish(1, org.id);
    let calls = 0;
    const handler = async (trx: Parameters<Parameters<typeof consumeDomainEvents>[0]["handler"]>[0]) => {
      calls += 1;
      await createIntegrityAlert(trx, { organizationId: org.id, level: "operacional", category: "teste", title: "efeito" });
      throw new Error("boom");
    };
    for (let i = 0; i < 5; i++) await consumeDomainEvents({ consumer: "falha", maxAttempts: 3, handler });
    expect(calls).toBe(3);
    const alerts = await db.selectFrom("integrityAlerts").select("id").execute();
    expect(alerts).toHaveLength(0);
    const consumption = await db.selectFrom("domainEventConsumptions").selectAll().executeTakeFirstOrThrow();
    expect(consumption.outcome).toBe("erro");
    expect(consumption.attempts).toBe(3);
  });

  it("dois executores do mesmo consumidor em paralelo nunca duplicam o efeito", async () => {
    const { org } = await newOrg();
    await publish(6, org.id);
    const counts = new Map<string, number>();
    const handler = async (_trx: unknown, e: { id: string }) => {
      counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    await Promise.all([
      consumeDomainEvents({ consumer: "par", handler }),
      consumeDomainEvents({ consumer: "par", handler }),
      consumeDomainEvents({ consumer: "par", handler }),
    ]);
    expect(counts.size).toBe(6);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });

  it("eventos são imutáveis (append-only)", async () => {
    const { org } = await newOrg();
    await publish(1, org.id);
    await expect(db.updateTable("domainEvents").set({ eventType: "x" }).execute()).rejects.toThrow();
    await expect(db.deleteFrom("domainEvents").execute()).rejects.toThrow();
  });
});

describe("camada de ferramentas dos agentes", () => {
  it("ensureAgentPrincipal é idempotente, por escopo, e não reativa agente desligado", async () => {
    const { org } = await newOrg();
    const g1 = await ensureAgentPrincipal(db, "sentinela-integridade", null);
    const g2 = await ensureAgentPrincipal(db, "sentinela-integridade", null);
    const scoped = await ensureAgentPrincipal(db, "sentinela-integridade", org.id);
    expect(g1.id).toBe(g2.id);
    expect(scoped.id).not.toBe(g1.id);

    await db.updateTable("agentPrincipals").set({ enabled: false }).where("id", "=", g1.id).execute();
    expect((await ensureAgentPrincipal(db, "sentinela-integridade", null)).enabled).toBe(false);
  });

  it("criar alerta: executa, audita com autor agente, deduplica e mantém a cadeia íntegra", async () => {
    const { org } = await newOrg();
    const agent = await ensureAgentPrincipal(db, "agente-estoque", null);
    const input = { organizationId: org.id, level: "alto_risco", category: "divergencia_inventario", title: "Saldo diverge", detail: { fisico: 100, sistema: 121 }, dedupeKey: "inv:1" };

    const first = await invokeAgentTool({ principalId: agent.id, toolName: "create_integrity_alert", input });
    expect(first).toMatchObject({ status: "ok", result: { created: true } });
    const second = await invokeAgentTool({ principalId: agent.id, toolName: "create_integrity_alert", input });
    expect(second).toMatchObject({ status: "ok", result: { created: false } });

    const alerts = await db.selectFrom("integrityAlerts").selectAll().execute();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].createdByAgentPrincipalId).toBe(agent.id);

    const row = (await auditRows(org.id)).find((r) => r.action === "automacao.alerta_criado");
    expect(row).toMatchObject({ actorType: "agent", actorAgentPrincipalId: agent.id });
    expect((await verifyAuditLogChain()).integra).toBe(true);
  });

  it("alerta resolvido libera um novo com a mesma chave", async () => {
    const { org } = await newOrg();
    const agent = await ensureAgentPrincipal(db, "agente-estoque", null);
    const input = { organizationId: org.id, level: "operacional", category: "validade", title: "Perto da validade", dedupeKey: "k" };
    await invokeAgentTool({ principalId: agent.id, toolName: "create_integrity_alert", input });
    await db.updateTable("integrityAlerts").set({ status: "resolvido" }).execute();
    const again = await invokeAgentTool({ principalId: agent.id, toolName: "create_integrity_alert", input });
    expect(again).toMatchObject({ status: "ok", result: { created: true } });
  });

  it("entrada inválida, agente desligado e organização inexistente são bloqueados sem lançar", async () => {
    const { org } = await newOrg();
    const agent = await ensureAgentPrincipal(db, "risk-engine", null);

    expect(await invokeAgentTool({ principalId: agent.id, toolName: "create_integrity_alert", input: { organizationId: org.id, level: "inventado", category: "X", title: "" } }))
      .toMatchObject({ status: "blocked", reason: "invalid_input" });

    expect(await invokeAgentTool({ principalId: agent.id, toolName: "list_open_alerts", input: { organizationId: 999999 } }))
      .toMatchObject({ status: "blocked", reason: "organization_mismatch" });

    await db.updateTable("agentPrincipals").set({ enabled: false }).where("id", "=", agent.id).execute();
    expect(await invokeAgentTool({ principalId: agent.id, toolName: "list_open_alerts", input: { organizationId: org.id } }))
      .toMatchObject({ status: "blocked", reason: "agent_disabled" });
  });

  it("ferramenta fora da matriz: bloqueia e gera alerta de segurança (uma vez só)", async () => {
    const { org } = await newOrg();
    const agent = await ensureAgentPrincipal(db, "vigia-prazos", org.id);

    for (let i = 0; i < 2; i++) {
      expect(await invokeAgentTool({ principalId: agent.id, toolName: "alterar_estoque", input: { organizationId: org.id } }))
        .toMatchObject({ status: "blocked", reason: "tool_not_allowed" });
    }
    const alerts = await db.selectFrom("integrityAlerts").selectAll().where("category", "=", "agente_ferramenta_negada").execute();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe("seguranca");
    expect(alerts[0].createdByAgentPrincipalId).toBeNull();
  });

  it("agente de uma organização não age em outra", async () => {
    const a = await newOrg();
    const b = await newOrg();
    const agent = await ensureAgentPrincipal(db, "agente-estoque", a.org.id);
    expect(await invokeAgentTool({ principalId: agent.id, toolName: "list_open_alerts", input: { organizationId: b.org.id } }))
      .toMatchObject({ status: "blocked", reason: "organization_mismatch" });
    expect(await invokeAgentTool({ principalId: agent.id, toolName: "list_open_alerts", input: { organizationId: null } }))
      .toMatchObject({ status: "blocked", reason: "organization_mismatch" });
    expect(await invokeAgentTool({ principalId: agent.id, toolName: "list_open_alerts", input: { organizationId: a.org.id } }))
      .toMatchObject({ status: "ok" });
  });

  it("emergência bloqueia leitura mas deixa alertar; pausa não bloqueia leitura nem alerta", async () => {
    const { owner, org } = await newOrg();
    const agent = await ensureAgentPrincipal(db, "sentinela-integridade", null);
    const alertInput = { organizationId: org.id, level: "alto_risco", category: "teste", title: "t" };

    await db.transaction().execute((trx) => setAutomationControl(trx, { organizationId: org.id, paused: true, emergency: false, userId: owner.id }));
    expect(await invokeAgentTool({ principalId: agent.id, toolName: "list_open_alerts", input: { organizationId: org.id } })).toMatchObject({ status: "ok" });
    expect(await invokeAgentTool({ principalId: agent.id, toolName: "create_integrity_alert", input: alertInput })).toMatchObject({ status: "ok" });

    await db.transaction().execute((trx) => setAutomationControl(trx, { organizationId: org.id, paused: true, emergency: true, userId: owner.id }));
    expect(await invokeAgentTool({ principalId: agent.id, toolName: "list_open_alerts", input: { organizationId: org.id } }))
      .toMatchObject({ status: "blocked", reason: "automation_emergency" });
    expect(await invokeAgentTool({ principalId: agent.id, toolName: "create_integrity_alert", input: { ...alertInput, title: "outro" } }))
      .toMatchObject({ status: "ok" });
  });

  it("get_policy_limits devolve os limites efetivos da organização", async () => {
    const { owner, org } = await newOrg();
    await db.transaction().execute((trx) => setPolicyLimit(trx, { organizationId: org.id, key: "AUTO_PICKUP_MAX_DISTANCE_KM", value: 5, userId: owner.id }));
    const agent = await ensureAgentPrincipal(db, "agente-estoque", null);
    const result = await invokeAgentTool({ principalId: agent.id, toolName: "get_policy_limits", input: { organizationId: org.id } });
    expect(result).toMatchObject({ status: "ok", result: { AUTO_PICKUP_MAX_DISTANCE_KM: 5 } });
  });
});

describe("regras de proteção e fila de exceções", () => {
  let runs: number;
  const mutateTool = defineTool({
    name: "create_integrity_alert",
    klass: "mutate",
    input: z.object({
      organizationId: z.number().int().positive().nullable(),
      estimatedValue: z.number().optional(),
      category: z.string().optional(),
    }),
    policyContext: (input) => ({ estimatedValue: input.estimatedValue, category: input.category }),
    run: async () => {
      runs += 1;
      return { executed: true };
    },
    audit: () => ({ action: "teste.acao_mutadora", entityType: "teste", entityId: "1" }),
  });
  const invoke = createToolInvoker({
    tools: { test_mutate: mutateTool },
    definitions: { "agente-teste": { tools: ["test_mutate"] } },
  });

  async function testAgent(orgId: number | null = null) {
    const row = await db
      .insertInto("agentPrincipals")
      .values({ name: "agente-teste", version: "0.0.1", organizationId: orgId })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }

  beforeEach(() => {
    runs = 0;
  });

  it("dentro dos limites executa e audita como agente", async () => {
    const { org } = await newOrg();
    const principalId = await testAgent();
    const result = await invoke({ principalId, toolName: "test_mutate", input: { organizationId: org.id, estimatedValue: 100 } });
    expect(result).toMatchObject({ status: "ok" });
    expect(runs).toBe(1);
    const row = (await auditRows(org.id)).find((r) => r.action === "teste.acao_mutadora");
    expect(row).toMatchObject({ actorType: "agent", actorAgentPrincipalId: principalId });
  });

  it("acima do limite não executa: vai para a fila (dupla autorização) e repetir não duplica a exceção", async () => {
    const { org } = await newOrg();
    const principalId = await testAgent();
    const input = { organizationId: org.id, estimatedValue: 5000 };
    const first = await invoke({ principalId, toolName: "test_mutate", input });
    expect(first).toMatchObject({ status: "needs_review", approvalsRequired: 2, ruleCode: "R-VALOR-ALTO-DUPLA" });
    if (first.status === "needs_review") expect(first.message).toBe("A automação foi interrompida por uma regra de proteção");
    const second = await invoke({ principalId, toolName: "test_mutate", input });
    expect(second).toMatchObject({ status: "needs_review" });
    expect(runs).toBe(0);
    expect(await db.selectFrom("exceptionQueue").select("id").execute()).toHaveLength(1);
    expect((await auditRows(org.id)).filter((r) => r.action === "agente.excecao_criada")).toHaveLength(1);
  });

  async function pendingException(orgId: number, principalId: number, input: Record<string, unknown>) {
    const result = await invoke({ principalId, toolName: "test_mutate", input: { organizationId: orgId, ...input } });
    if (result.status !== "needs_review") throw new Error("esperava needs_review");
    return result.exceptionId;
  }

  it("dupla autorização exige duas pessoas diferentes; só então a ação pode ser reexecutada, uma vez", async () => {
    const { org } = await newOrg();
    const reviewerA = await createTestUser();
    const reviewerB = await createTestUser();
    const principalId = await testAgent();
    const input = { estimatedValue: 5000 };
    const exceptionId = await pendingException(org.id, principalId, input);

    expect(await invoke({ principalId, toolName: "test_mutate", input: { organizationId: org.id, ...input }, approvedExceptionId: exceptionId }))
      .toMatchObject({ status: "blocked", reason: "exception_not_valid" });

    const afterA = await db.transaction().execute((trx) => decideException(trx, { organizationId: org.id, exceptionId, userId: reviewerA.id, decision: "aprovar" }));
    expect(afterA).toMatchObject({ status: "pendente", approvals: 1, approvalsRequired: 2 });
    await expect(
      db.transaction().execute((trx) => decideException(trx, { organizationId: org.id, exceptionId, userId: reviewerA.id, decision: "aprovar" }))
    ).rejects.toThrow(/outra pessoa/);
    const afterB = await db.transaction().execute((trx) => decideException(trx, { organizationId: org.id, exceptionId, userId: reviewerB.id, decision: "aprovar" }));
    expect(afterB?.status).toBe("aprovada");

    const run = await invoke({ principalId, toolName: "test_mutate", input: { organizationId: org.id, ...input }, approvedExceptionId: exceptionId });
    expect(run).toMatchObject({ status: "ok" });
    expect(runs).toBe(1);
    const again = await invoke({ principalId, toolName: "test_mutate", input: { organizationId: org.id, ...input }, approvedExceptionId: exceptionId });
    expect(again).toMatchObject({ status: "blocked", reason: "exception_not_valid" });
    expect(runs).toBe(1);
  });

  it("exceção aprovada não autoriza outra entrada nem outro agente", async () => {
    const { org } = await newOrg();
    const reviewer = await createTestUser();
    const principalId = await testAgent();
    const otherAgent = (await db.insertInto("agentPrincipals").values({ name: "agente-teste", version: "0.0.1", organizationId: org.id }).returning("id").executeTakeFirstOrThrow()).id;
    const exceptionId = await pendingException(org.id, principalId, { category: "medicamento" });
    await db.transaction().execute((trx) => decideException(trx, { organizationId: org.id, exceptionId, userId: reviewer.id, decision: "aprovar" }));

    expect(await invoke({ principalId, toolName: "test_mutate", input: { organizationId: org.id, category: "medicamento", estimatedValue: 1 }, approvedExceptionId: exceptionId }))
      .toMatchObject({ status: "blocked", reason: "exception_not_valid" });
    expect(await invoke({ principalId: otherAgent, toolName: "test_mutate", input: { organizationId: org.id, category: "medicamento" }, approvedExceptionId: exceptionId }))
      .toMatchObject({ status: "blocked", reason: "exception_not_valid" });
    expect(runs).toBe(0);
  });

  it("revisão simples: uma aprovação basta; qualquer rejeição encerra e não deixa executar", async () => {
    const { org } = await newOrg();
    const reviewer = await createTestUser();
    const principalId = await testAgent();

    const approvedId = await pendingException(org.id, principalId, { category: "medicamento" });
    const approved = await db.transaction().execute((trx) => decideException(trx, { organizationId: org.id, exceptionId: approvedId, userId: reviewer.id, decision: "aprovar" }));
    expect(approved?.status).toBe("aprovada");
    await expect(
      db.transaction().execute((trx) => decideException(trx, { organizationId: org.id, exceptionId: approvedId, userId: reviewer.id, decision: "rejeitar" }))
    ).rejects.toThrow(/já foi decidida/);

    const rejectedId = await pendingException(org.id, principalId, { category: "item_perigoso" });
    const rejected = await db.transaction().execute((trx) => decideException(trx, { organizationId: org.id, exceptionId: rejectedId, userId: reviewer.id, decision: "rejeitar" }));
    expect(rejected?.status).toBe("rejeitada");
    expect(await invoke({ principalId, toolName: "test_mutate", input: { organizationId: org.id, category: "item_perigoso" }, approvedExceptionId: rejectedId }))
      .toMatchObject({ status: "blocked", reason: "exception_not_valid" });
  });

  it("decidir exceção de outra organização não encontra nada", async () => {
    const a = await newOrg();
    const b = await newOrg();
    const reviewer = await createTestUser();
    const principalId = await testAgent();
    const exceptionId = await pendingException(a.org.id, principalId, { category: "medicamento" });
    const result = await db.transaction().execute((trx) => decideException(trx, { organizationId: b.org.id, exceptionId, userId: reviewer.id, decision: "aprovar" }));
    expect(result).toBeNull();
  });

  it("duas reexecuções simultâneas da mesma exceção aprovada: exatamente uma executa", async () => {
    const { org } = await newOrg();
    const reviewer = await createTestUser();
    const principalId = await testAgent();
    const exceptionId = await pendingException(org.id, principalId, { category: "medicamento" });
    await db.transaction().execute((trx) => decideException(trx, { organizationId: org.id, exceptionId, userId: reviewer.id, decision: "aprovar" }));

    const call = () => invoke({ principalId, toolName: "test_mutate", input: { organizationId: org.id, category: "medicamento" }, approvedExceptionId: exceptionId });
    const results = await Promise.all([call(), call(), call()]);
    expect(results.filter((r) => r.status === "ok")).toHaveLength(1);
    expect(runs).toBe(1);
  });

  it("pausa bloqueia ferramenta que muda dados, mesmo dentro dos limites", async () => {
    const { owner, org } = await newOrg();
    const principalId = await testAgent();
    await db.transaction().execute((trx) => setAutomationControl(trx, { organizationId: org.id, paused: true, emergency: false, userId: owner.id }));
    expect(await invoke({ principalId, toolName: "test_mutate", input: { organizationId: org.id, estimatedValue: 1 } }))
      .toMatchObject({ status: "blocked", reason: "automation_paused" });
    expect(runs).toBe(0);
  });
});
