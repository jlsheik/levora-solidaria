/**
 * M46 — agendador seguro e desabilitado por padrão: processAgentEvents só roda com habilitação explícita; nenhum ponto de entrada (cron, tarefa, reprocessamento manual) contorna o controle.
 * Dados 100% sintéticos; nenhuma chamada externa (fetch/http são espionados).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const scheduled: string[] = [];
vi.mock("node-cron", () => ({
  default: {
    validate: () => true,
    schedule: (expr: string) => { scheduled.push(expr); return { stop() {} }; },
  },
}));

import { db } from "../src/helpers/db";
import { publishDomainEvent } from "../src/helpers/domainEvents";
import { processAgentEventsScheduled } from "../src/helpers/processAgentEventsTask";
import { getTaskEnablement, isOptInTaskEnabled, getSchedulerStatus } from "../src/helpers/schedulerControl";
import { startScheduler } from "../src/helpers/scheduler";
import { handle as postEnable } from "../src/endpoints/agents-enable_POST";
import { handle as postRetry } from "../src/endpoints/background-tasks-retry_POST";
import { handle as postPlatformControls } from "../src/endpoints/platform-automation-controls_POST";
import * as engine from "../src/helpers/agentEventEngine";
import { createAuthenticatedUser, createPlatformAdmin, createTestOrganization, buildRequest, type AuthenticatedTestUser } from "./helpers";
import fs from "node:fs";
import path from "node:path";

const ENV = "AGENT_EVENTS_SCHEDULER_ENABLED";
const post = (p: string, a: AuthenticatedTestUser | undefined, body: unknown) => buildRequest(p, { method: "POST", cookie: a?.cookie, body });
async function publish(orgId: number, entityId: string) {
  await db.transaction().execute((trx) => publishDomainEvent(trx, { eventType: "opportunity.created", organizationId: orgId, entityType: "donation_opportunity", entityId, payload: { category: "roupa", quantityOffered: 1, unit: "kg" } as never }));
}
const runsCount = async () => Number((await db.selectFrom("agentEventRuns").select((e) => e.fn.countAll().as("n")).executeTakeFirstOrThrow()).n);
const taskRuns = () => db.selectFrom("backgroundTaskRuns").selectAll().where("taskName", "=", "processAgentEvents").execute();

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { scheduled.length = 0; vi.unstubAllEnvs(); delete process.env[ENV]; fetchSpy = vi.spyOn(globalThis, "fetch"); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("configuração: o estado padrão é desabilitado", () => {
  it("scheduled-jobs.json versionado não deixa processAgentEvents habilitado e exige a variável de ambiente", () => {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../src/static/__dev/scheduled-jobs.json"), "utf-8"));
    expect(cfg.processAgentEvents.enabled).toBe(false);
    expect(cfg.processAgentEvents.enableWith).toBe(ENV);
  });

  it("só o valor exato 'true' habilita; ausente/vazio/1/yes/TRUE/true␠ continuam desabilitados, mesmo com enabled:true no JSON", () => {
    for (const v of [undefined, "", "1", "yes", "TRUE", "true ", "on"]) {
      const env = v === undefined ? {} : { [ENV]: v };
      expect(getTaskEnablement("processAgentEvents", { enabled: true }, env as never).enabled).toBe(false);
      expect(isOptInTaskEnabled("processAgentEvents", env as never)).toBe(false);
    }
    expect(getTaskEnablement("processAgentEvents", { enabled: false }, { [ENV]: "true" } as never).enabled).toBe(true);
    // tarefas existentes seguem como antes
    expect(getTaskEnablement("expireReservations", { enabled: true }).enabled).toBe(true);
    expect(getTaskEnablement("expireReservations", { enabled: false })).toMatchObject({ enabled: false, reason: "desabilitada_no_json" });
  });

  it("startScheduler sem a variável: processAgentEvents NÃO entra no cron e o estado diz isso; as demais tarefas continuam", () => {
    startScheduler();
    expect(scheduled).toHaveLength(7); // as outras 7 tarefas do JSON; processAgentEvents fica de fora
    const st = getSchedulerStatus();
    expect(st.started).toBe(true);
    expect(st.tasks.find((t) => t.task === "processAgentEvents")).toMatchObject({ state: "desabilitada", reason: "habilitacao_explicita_ausente" });
    expect(st.tasks.filter((t) => t.state === "ativa").map((t) => t.task)).toContain("expireReservations");
  });

  it("startScheduler com a variável (ambiente sintético): a tarefa é registrada", () => {
    vi.stubEnv(ENV, "true");
    startScheduler();
    expect(getSchedulerStatus().tasks.find((t) => t.task === "processAgentEvents")).toMatchObject({ state: "ativa" });
    expect(scheduled).toHaveLength(8);
  });
});

describe("a própria tarefa e o reprocessamento manual respeitam o controle", () => {
  let owner: AuthenticatedTestUser; let orgId: number;
  beforeEach(async () => { owner = await createAuthenticatedUser(); orgId = (await createTestOrganization(owner.userId)).id; });

  it("sem habilitação: mesmo com agente LIGADO e evento publicado, nada é lido, registrado ou processado, e não há chamada externa", async () => {
    await postEnable(post("agents-enable", owner, { organizationId: orgId, agent: "risk-engine", enabled: true }));
    await new Promise((x) => setTimeout(x, 15));
    await publish(orgId, "e1");
    const spy = vi.spyOn(engine, "runAgentEventEngine");
    await processAgentEventsScheduled();
    expect(spy).not.toHaveBeenCalled();
    expect(await runsCount()).toBe(0);
    expect(await taskRuns()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("habilitada + agente DESLIGADO: a passada roda mas não cria execução (inerte); habilitada + agente ligado: processa só em simulação", async () => {
    vi.stubEnv(ENV, "true");
    await publish(orgId, "e2");
    await processAgentEventsScheduled();
    expect(await runsCount()).toBe(0);
    expect((await taskRuns()).map((r) => r.status)).toEqual(["concluida"]);

    await postEnable(post("agents-enable", owner, { organizationId: orgId, agent: "risk-engine", enabled: true }));
    await new Promise((x) => setTimeout(x, 15));
    await publish(orgId, "e3");
    await processAgentEventsScheduled();
    expect(await runsCount()).toBe(1);
    const rows = await db.selectFrom("agentEventRuns").select(["simulated", "status"]).execute();
    expect(rows.every((r) => r.simulated === true)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("organização não autorizada: o agente ligado numa organização não processa eventos de outra", async () => {
    vi.stubEnv(ENV, "true");
    const other = await createAuthenticatedUser(); const otherOrg = (await createTestOrganization(other.userId)).id;
    await postEnable(post("agents-enable", owner, { organizationId: orgId, agent: "risk-engine", enabled: true }));
    await new Promise((x) => setTimeout(x, 15));
    await publish(otherOrg, "o1");
    await processAgentEventsScheduled();
    expect(await runsCount()).toBe(0);
  });

  it("pausa global com a tarefa habilitada: o evento fica bloqueado e nada avança", async () => {
    vi.stubEnv(ENV, "true");
    const staff = await createPlatformAdmin();
    await postEnable(post("agents-enable", owner, { organizationId: orgId, agent: "risk-engine", enabled: true }));
    await postPlatformControls(post("platform-automation-controls", staff, { paused: true, emergency: false, reason: "manutenção sintética" }));
    await new Promise((x) => setTimeout(x, 15));
    await publish(orgId, "p1");
    await processAgentEventsScheduled();
    const rows = await db.selectFrom("agentEventRuns").select("status").execute();
    expect(rows.map((r) => r.status)).toEqual(["bloqueado_politica"]);
  });

  it("falha durante o processamento: a execução fica registrada como falha e o erro é propagado (nada silencioso)", async () => {
    vi.stubEnv(ENV, "true");
    vi.spyOn(engine, "runAgentEventEngine").mockRejectedValueOnce(Object.assign(new Error("falha sintética"), { code: "XX000" }));
    await expect(processAgentEventsScheduled()).rejects.toThrow("falha sintética");
    expect((await taskRuns()).map((r) => r.status)).toEqual(["falhou"]);
  });

  it("execuções concorrentes: uma passada só; reinício (nova chamada) não duplica execuções já registradas", async () => {
    vi.stubEnv(ENV, "true");
    await postEnable(post("agents-enable", owner, { organizationId: orgId, agent: "risk-engine", enabled: true }));
    await new Promise((x) => setTimeout(x, 15));
    await publish(orgId, "c1");
    await Promise.all([processAgentEventsScheduled(), processAgentEventsScheduled(), processAgentEventsScheduled()]);
    expect(await runsCount()).toBe(1);
    await processAgentEventsScheduled(); // "reinício": mesma situação, nada novo
    expect(await runsCount()).toBe(1);
  });

  it("reprocessamento manual por administrador da plataforma: 409 enquanto desabilitada (nada é executado); com habilitação, reprocessa", async () => {
    const staff = await createPlatformAdmin();
    const row = await db.insertInto("backgroundTaskRuns").values({ taskName: "processAgentEvents", status: "falhou", startedAt: new Date(), idempotencyKey: "m46-sintetico" } as never).returning("id").executeTakeFirstOrThrow();
    const spy = vi.spyOn(engine, "runAgentEventEngine");
    const blocked = await postRetry(post("background-tasks-retry", staff, { runId: Number(row.id) }));
    expect(blocked.status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
    vi.stubEnv(ENV, "true");
    const ok = await postRetry(post("background-tasks-retry", staff, { runId: Number(row.id) }));
    expect(ok.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
