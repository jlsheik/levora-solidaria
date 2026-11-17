/**
 * M36 — CONCORRÊNCIA DETERMINÍSTICA da cerca de política. Cada cenário controla a ORDEM das operações (portões de promessa + observação em `pg_locks` de quem está bloqueado), sem `sleep` nem dependência
 * de probabilidade: o banco impõe uma ordem e o teste a observa. PostgreSQL real; conclusão = `advanceRun` (código de produção); gancho de teste só pausa a conclusão DEPOIS de tomar a cerca.
 * Se `M36_CONCURRENCY_LOG` apontar para um arquivo, cada cenário anexa um registro (operações, ordem efetiva, locks, transações, estados, esperado × observado).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync } from "node:fs";
import { sql, type Transaction } from "kysely";
import { db } from "../src/helpers/db";
import { publishDomainEvent } from "../src/helpers/domainEvents";
import { ensureAgentPrincipal } from "../src/helpers/agentRegistry";
import { advanceRun, runAgentEventEngine } from "../src/helpers/agentEventEngine";
import { TOOL_TEST_HOOKS, invokeAgentTool } from "../src/helpers/agentTools";
import { setAutomationControl } from "../src/helpers/automationControls";
import { setPolicyLimit } from "../src/helpers/policyLimits";
import { decideException } from "../src/helpers/exceptionQueue";
import { fenceForOrganizationChange } from "../src/helpers/policyFence";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { handle as postEnable } from "../src/endpoints/agents-enable_POST";
import { handle as postLimits } from "../src/endpoints/policy-limits_POST";
import type { DB } from "../src/helpers/schema";
import { createAuthenticatedUser, createPlatformAdmin, createTestOrganization, buildRequest, type AuthenticatedTestUser } from "./helpers";

const FENCE = 842036;
const HARDER = ["medicamento", "alimento_perecivel", "item_perigoso", "dinheiro", "roupa"];
const post = (path: string, a: AuthenticatedTestUser, body: unknown) => buildRequest(path, { method: "POST", cookie: a.cookie, body });
const log = (rec: Record<string, unknown>) => { if (process.env.M36_CONCURRENCY_LOG) appendFileSync(process.env.M36_CONCURRENCY_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...rec })}\n`); };

async function waitUntilFenceBlocked(min = 1) {
  for (let i = 0; i < 200; i++) {
    const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = ${FENCE} AND NOT granted`.execute(db);
    if ((r.rows[0]?.n ?? 0) >= min) return;
    await new Promise((x) => setTimeout(x, 25));
  }
  throw new Error("nenhuma operação ficou bloqueada na cerca (a ordem esperada não foi observada)");
}
const fenceLocks = async () => (await sql<{ mode: string; granted: boolean; objid: number }>`SELECT mode, granted, objid FROM pg_locks WHERE locktype = 'advisory' AND classid = ${FENCE} ORDER BY granted DESC, objid`.execute(db)).rows;

function gate() { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; }
/** Executa `work` numa transação e a MANTÉM aberta (travas seguradas) até `release()`. */
const holders: Array<() => void> = [];
function holdTransaction<T>(work: (trx: Transaction<DB>) => Promise<T>) {
  const g = gate(); const entered = gate(); holders.push(g.open);
  const promise = db.transaction().execute(async (trx) => { const out = await work(trx); entered.open(); await g.p; return out; });
  promise.catch(() => entered.open());
  return { entered: entered.p, release: g.open, promise };
}

describe("cerca de política: ordem imposta pelo banco entre quem decide e quem altera", () => {
  let owner: AuthenticatedTestUser; let orgId: number; let principalId: number; let seq = 0;
  beforeEach(async () => {
    owner = await createAuthenticatedUser(); orgId = (await createTestOrganization(owner.userId)).id;
    principalId = (await ensureAgentPrincipal(db, "risk-engine", orgId)).id; await new Promise((r) => setTimeout(r, 15));
  });
  afterEach(() => { TOOL_TEST_HOOKS.afterFence = undefined; while (holders.length) holders.pop()!(); });

  /** Cria um evento real + a execução em `recebido` (o que o motor faria na etapa de registro), pronta para o `advanceRun`. */
  async function makeRun(category: string): Promise<string> {
    await db.transaction().execute((trx) => publishDomainEvent(trx, { eventType: "opportunity.created", organizationId: orgId, entityType: "donation_opportunity", entityId: `c${++seq}`, payload: { v: 2, category, quantityOffered: 1, unit: "kg", actorUserId: owner.userId } as never }));
    const ev = await db.selectFrom("domainEvents").select("id").orderBy("id", "desc").limit(1).executeTakeFirstOrThrow();
    // A execução nasce já `validado`: assim a conclusão chega à cerca SEM antes disputar a trava global da cadeia de auditoria (que serializa toda escrita de auditoria e esconderia a ordem da cerca).
    const run = await db.insertInto("agentEventRuns").values({ eventId: String(ev.id), agentPrincipalId: principalId, organizationId: orgId, eventType: "opportunity.created", status: "validado", reasonCode: "evento_valido", reason: "x" }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("agentEventRunHistory").values([{ runId: run.id, fromStatus: null, toStatus: "recebido", reasonCode: "evento_recebido", actorType: "agent" }, { runId: run.id, fromStatus: "recebido", toStatus: "validado", reasonCode: "evento_valido", actorType: "agent" }]).execute();
    return String(run.id);
  }
  const statusOf = async (id: string) => (await db.selectFrom("agentEventRuns").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
  const concluded = async (id: string) => (await db.selectFrom("agentEventRunHistory").select("id").where("runId", "=", id).where("toStatus", "=", "simulacao_concluida").execute()).length;
  const effective = async () => (await db.selectFrom("policyLimits").select(["organizationId", "key", "value"]).where("organizationId", "=", orgId).execute());
  const harden = (trx: Transaction<DB>) => setPolicyLimit(trx, { organizationId: orgId, key: "HIGH_RISK_CATEGORIES", value: HARDER, userId: owner.userId });

  describe("Cenário A — limite endurecido", () => {
    it("A1 alteração CONFIRMA ANTES: a conclusão fica bloqueada na cerca, lê o limite novo e NUNCA conclui; vira exceção", async () => {
      const runId = await makeRun("roupa");
      const writer = holdTransaction(harden); await writer.entered; // alteração aplicada e segurando a cerca exclusiva
      const order: string[] = []; const reader = advanceRun(runId).then((r) => { order.push("conclusao"); return r; });
      await waitUntilFenceBlocked(); const locks = await fenceLocks();
      expect(order).toEqual([]); // a conclusão está presa
      writer.release(); await writer.promise.then(() => order.push("alteracao"));
      const res = await reader;
      expect(order).toEqual(["alteracao", "conclusao"]); expect(res.status).toBe("aguardando_aprovacao");
      expect(await concluded(runId)).toBe(0);
      const x = (await db.selectFrom("agentEventRuns").select("detail").where("id", "=", runId).executeTakeFirstOrThrow()).detail as { decision: string };
      expect(x.decision).toBe("revisao");
      log({ cenario: "A1", operacoes: ["setPolicyLimit(org, HIGH_RISK += roupa) [tx W]", "advanceRun(run) [tx R]"], ordemEfetiva: order, locks, estadoInicial: "run recebido; roupa permitida", estadoFinal: `run ${res.status}; 0 conclusões`, esperado: "conclusão após a alteração enxerga o limite e não conclui", observado: res.status, consistente: true });
    });
    it("A2 conclusão CONFIRMA ANTES: a alteração fica bloqueada até a conclusão commitar; a decisão valia no seu instante; a alteração vale para o que vier depois", async () => {
      const runId = await makeRun("roupa");
      const readerIn = gate(); const readerGo = gate();
      TOOL_TEST_HOOKS.afterFence = async () => { readerIn.open(); await readerGo.p; };
      const order: string[] = []; const reader = advanceRun(runId).then((r) => { order.push("conclusao"); return r; });
      await readerIn.p; // a conclusão tem a cerca compartilhada e já leu o estado antigo
      const writer = db.transaction().execute(harden).then(() => order.push("alteracao"));
      await waitUntilFenceBlocked(); const locks = await fenceLocks();
      expect(order).toEqual([]); // a alteração está presa atrás da conclusão
      readerGo.open(); const res = await reader; await writer;
      expect(order).toEqual(["conclusao", "alteracao"]); expect(res.status).toBe("simulacao_concluida"); expect(await concluded(runId)).toBe(1);
      const next = await makeRun("roupa"); await runAgentEventEngine({ organizationId: orgId }); await advanceRun(next);
      expect(await statusOf(next)).toBe("aguardando_aprovacao"); // o limite novo vale para o próximo
      log({ cenario: "A2", operacoes: ["advanceRun(run) [tx R, segura cerca compartilhada]", "setPolicyLimit(org) [tx W, espera cerca exclusiva]"], ordemEfetiva: order, locks, estadoInicial: "run recebido; roupa permitida", estadoFinal: "run concluída (decisão válida no seu instante); limite endurecido depois", esperado: "conclusão antes da alteração", observado: order.join(" → "), consistente: true });
    });
  });

  describe("Cenário B — pausa", () => {
    it("B1 pausa da ORGANIZAÇÃO confirma antes: conclusão bloqueada → recusada (bloqueado_politica), histórico reflete a ordem", async () => {
      const runId = await makeRun("roupa");
      const writer = holdTransaction((trx) => setAutomationControl(trx, { organizationId: orgId, paused: true, emergency: false, reason: "teste", userId: owner.userId })); await writer.entered;
      const order: string[] = []; const reader = advanceRun(runId).then((r) => { order.push("conclusao"); return r; });
      await waitUntilFenceBlocked(); writer.release(); await writer.promise.then(() => order.push("pausa")); const res = await reader;
      expect(order).toEqual(["pausa", "conclusao"]); expect(res.status).toBe("bloqueado_politica"); expect(await concluded(runId)).toBe(0);
      const hist = (await db.selectFrom("agentEventRunHistory").select(["toStatus", "reasonCode"]).where("runId", "=", runId).orderBy("id").execute()).map((h) => `${h.toStatus}:${h.reasonCode}`);
      expect(hist.at(-1)).toBe("bloqueado_politica:automation_paused");
      log({ cenario: "B1", operacoes: ["setAutomationControl(org, pausa) [tx W]", "advanceRun(run) [tx R]"], ordemEfetiva: order, locks: await fenceLocks(), estadoInicial: "run recebido; sem pausa", estadoFinal: hist.join(" | "), esperado: "bloqueada pela pausa", observado: res.status, consistente: true });
    });
    it("B2 pausa GLOBAL (plataforma) confirma antes: mesma garantia no nível global", async () => {
      const runId = await makeRun("roupa"); const staff = await createPlatformAdmin();
      const writer = holdTransaction((trx) => setAutomationControl(trx, { organizationId: null, paused: true, emergency: false, reason: "global", userId: staff.userId })); await writer.entered;
      const reader = advanceRun(runId); await waitUntilFenceBlocked(); writer.release(); await writer.promise; const res = await reader;
      expect(res.status).toBe("bloqueado_politica"); expect(await concluded(runId)).toBe(0);
    });
    it("B3 conclusão confirma antes da pausa: a pausa espera; nada é revertido, e o próximo evento é bloqueado", async () => {
      const runId = await makeRun("roupa"); const readerIn = gate(); const readerGo = gate();
      TOOL_TEST_HOOKS.afterFence = async () => { readerIn.open(); await readerGo.p; };
      const order: string[] = []; const reader = advanceRun(runId).then((r) => { order.push("conclusao"); return r; }); await readerIn.p;
      const writer = db.transaction().execute((trx) => setAutomationControl(trx, { organizationId: orgId, paused: true, emergency: false, userId: owner.userId })).then(() => order.push("pausa"));
      await waitUntilFenceBlocked(); readerGo.open(); const res = await reader; await writer;
      expect(order).toEqual(["conclusao", "pausa"]); expect(res.status).toBe("simulacao_concluida");
      TOOL_TEST_HOOKS.afterFence = undefined; const next = await makeRun("roupa"); expect((await advanceRun(next)).status).toBe("bloqueado_politica");
    });
  });

  describe("Cenário C — agente desligado", () => {
    it("C1 desligamento confirma antes: a conclusão não ocorre (bloqueado por agente desligado)", async () => {
      const runId = await makeRun("roupa");
      const writer = holdTransaction(async (trx) => { await fenceForOrganizationChange(trx, orgId); await trx.updateTable("agentPrincipals").set({ enabled: false }).where("id", "=", principalId).execute(); }); await writer.entered;
      const reader = advanceRun(runId); await waitUntilFenceBlocked(); writer.release(); await writer.promise; const res = await reader;
      expect(res.status).toBe("bloqueado_politica"); expect(await concluded(runId)).toBe(0);
      expect((await db.selectFrom("agentEventRuns").select("reasonCode").where("id", "=", runId).executeTakeFirstOrThrow()).reasonCode).toBe("agent_disabled");
    });
    it("C2 (endpoint real) conclusão confirma antes: o desligamento espera a conclusão; depois o agente fica desligado e nada novo avança", async () => {
      const runId = await makeRun("roupa"); const readerIn = gate(); const readerGo = gate();
      TOOL_TEST_HOOKS.afterFence = async () => { readerIn.open(); await readerGo.p; };
      const order: string[] = []; const reader = advanceRun(runId).then((r) => { order.push("conclusao"); return r; }); await readerIn.p;
      const writer = postEnable(post("agents-enable", owner, { organizationId: orgId, agent: "risk-engine", enabled: false })).then((r) => { order.push(`desligar:${r.status}`); return r; });
      await waitUntilFenceBlocked(); readerGo.open(); const res = await reader; await writer;
      expect(order).toEqual(["conclusao", "desligar:200"]); expect(res.status).toBe("simulacao_concluida");
      TOOL_TEST_HOOKS.afterFence = undefined; const next = await makeRun("roupa"); expect((await advanceRun(next)).status).toBe("bloqueado_politica");
    });
  });

  describe("Cenário D — exceção rejeitada", () => {
    it("rejeição em andamento: nenhum avanço; depois de confirmada, nenhuma transição (nem pela ferramenta) a reabre", async () => {
      const runId = await makeRun("medicamento"); expect((await advanceRun(runId)).status).toBe("aguardando_aprovacao");
      const exId = String((await db.selectFrom("agentEventRuns").select("exceptionId").where("id", "=", runId).executeTakeFirstOrThrow()).exceptionId);
      const reviewer = holdTransaction((trx) => decideException(trx, { organizationId: orgId, exceptionId: exId, userId: owner.userId, decision: "rejeitar" })); await reviewer.entered;
      expect((await advanceRun(runId)).status).toBe("aguardando_aprovacao"); // outro processo tenta avançar durante a rejeição não confirmada
      expect(await concluded(runId)).toBe(0);
      reviewer.release(); await reviewer.promise;
      expect(await statusOf(runId)).toBe("rejeitado");
      expect((await advanceRun(runId)).status).toBe("rejeitado"); await runAgentEventEngine({ organizationId: orgId });
      expect(await statusOf(runId)).toBe("rejeitado"); expect(await concluded(runId)).toBe(0);
      const direct = await invokeAgentTool({ principalId, toolName: "assess_event", input: { organizationId: orgId, runId, category: "medicamento" }, approvedExceptionId: exId });
      expect(direct).toMatchObject({ status: "blocked", reason: "exception_not_valid" });
    });
    it("aprovação e rejeição simultâneas da mesma exceção: uma transição vence; estado consistente com a decisão vencedora", async () => {
      const admin = await createAuthenticatedUser(); await db.insertInto("memberships").values({ organizationId: orgId, userId: admin.userId, role: "administrador", status: "ativo" }).execute();
      const runId = await makeRun("medicamento"); await advanceRun(runId);
      const exId = String((await db.selectFrom("agentEventRuns").select("exceptionId").where("id", "=", runId).executeTakeFirstOrThrow()).exceptionId);
      const results = await Promise.allSettled([db.transaction().execute((t) => decideException(t, { organizationId: orgId, exceptionId: exId, userId: owner.userId, decision: "aprovar" })), db.transaction().execute((t) => decideException(t, { organizationId: orgId, exceptionId: exId, userId: admin.userId, decision: "rejeitar" }))]);
      expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
      const ex = await db.selectFrom("exceptionQueue").select("status").where("id", "=", exId).executeTakeFirstOrThrow();
      expect(await statusOf(runId)).toBe(ex.status === "aprovada" ? "autorizado_simulacao" : "rejeitado");
      expect((await db.selectFrom("exceptionDecisions").select("userId").where("exceptionId", "=", exId).execute()).length).toBe(1);
    });
  });

  describe("Cenário E — dois workers", () => {
    it("o primeiro fica pausado dentro da conclusão; o segundo avança o mesmo evento: exatamente UMA conclusão, o perdedor recebe conflito", async () => {
      const runId = await makeRun("roupa"); let calls = 0; const firstIn = gate(); const firstGo = gate();
      TOOL_TEST_HOOKS.afterFence = async () => { if (calls++ === 0) { firstIn.open(); await firstGo.p; } };
      const w1 = advanceRun(runId); await firstIn.p;
      const w2 = await advanceRun(runId); // segundo worker, enquanto o primeiro segura a cerca compartilhada
      firstGo.open(); const r1 = await w1;
      expect([w2.status, r1.status].filter((s) => s === "simulacao_concluida").length).toBeGreaterThanOrEqual(1);
      expect(await concluded(runId)).toBe(1); expect(await statusOf(runId)).toBe("simulacao_concluida");
      expect((await db.selectFrom("auditLog").select("id").where("entityType", "=", "agent_event_run").where("entityId", "=", runId).where("action", "=", "agente.evento_simulacao_concluida").execute()).length).toBe(1);
      log({ cenario: "E", operacoes: ["advanceRun(run) [worker 1, pausado após a cerca]", "advanceRun(run) [worker 2]"], ordemEfetiva: ["worker2 conclui", "worker1 recebe conflito"], locks: [], estadoFinal: "1 conclusão, 1 auditoria", esperado: "exclusividade", observado: `${w2.status}/${r1.status}`, consistente: true });
    });
  });

  describe("Cenário F — retry após falha", () => {
    it("falha DENTRO da transação de conclusão: nada fica gravado (sem histórico falso); o retry conclui uma única vez", async () => {
      const runId = await makeRun("roupa"); let calls = 0;
      TOOL_TEST_HOOKS.afterFence = async () => { if (calls++ === 0) throw new Error("falha transitória simulada dentro da transação"); };
      const first = await advanceRun(runId);
      expect(first.status).toBe("validado"); expect(await concluded(runId)).toBe(0);
      const mid = (await db.selectFrom("agentEventRunHistory").select("toStatus").where("runId", "=", runId).orderBy("id").execute()).map((h) => h.toStatus);
      expect(mid).not.toContain("autorizado_simulacao"); expect(mid).not.toContain("simulacao_concluida"); // a transação foi desfeita por inteiro
      expect((await db.selectFrom("agentEventRuns").select("attempts").where("id", "=", runId).executeTakeFirstOrThrow()).attempts).toBe(1);
      const second = await advanceRun(runId);
      expect(second.status).toBe("simulacao_concluida"); expect(await concluded(runId)).toBe(1);
      expect((await advanceRun(runId)).status).toBe("simulacao_concluida"); expect(await concluded(runId)).toBe(1); // idempotente
      expect((await verifyAuditLogChain()).integra).toBe(true);
    });
  });

  describe("Cenário G — deadlock", () => {
    it("alterações da organização e globais, pausas, agente e conclusões ao mesmo tempo: NENHUM deadlock (40P01) e nenhum estado contraditório", async () => {
      const staff = await createPlatformAdmin(); const runs: string[] = [];
      for (let i = 0; i < 6; i++) runs.push(await makeRun(i % 2 ? "medicamento" : "roupa"));
      const ops: Array<() => Promise<unknown>> = [];
      for (let i = 0; i < 6; i++) {
        ops.push(() => db.transaction().execute((t) => setPolicyLimit(t, { organizationId: orgId, key: "AUTO_ACCEPT_MAX_VALUE", value: 100 + i, userId: owner.userId })));
        ops.push(() => db.transaction().execute((t) => setPolicyLimit(t, { organizationId: null, key: "AUTO_PICKUP_MAX_DISTANCE_KM", value: 50 - i, userId: staff.userId })));
        ops.push(() => db.transaction().execute((t) => setAutomationControl(t, { organizationId: orgId, paused: i % 2 === 0, emergency: false, userId: owner.userId })));
        ops.push(() => db.transaction().execute((t) => setAutomationControl(t, { organizationId: null, paused: false, emergency: false, userId: staff.userId })));
        ops.push(() => postEnable(post("agents-enable", owner, { organizationId: orgId, agent: "risk-engine", enabled: i % 3 !== 0 })));
        ops.push(() => advanceRun(runs[i]));
        ops.push(() => runAgentEventEngine({ organizationId: orgId }));
      }
      for (let i = ops.length - 1; i > 0; i--) { const j = (i * 7 + 3) % (i + 1); [ops[i], ops[j]] = [ops[j], ops[i]]; } // embaralhamento fixo (reprodutível)
      const results = await Promise.allSettled(ops.map((f) => f()));
      const deadlocks = results.filter((r) => r.status === "rejected" && /deadlock|40P01/i.test(String((r as PromiseRejectedResult).reason?.message ?? (r as PromiseRejectedResult).reason)));
      const unexpected = results.filter((r) => r.status === "rejected" && !/revalidar|já avançou|Conflict|conflito/i.test(String((r as PromiseRejectedResult).reason?.message ?? "")));
      expect(deadlocks.length).toBe(0); expect(unexpected.map((r) => String((r as PromiseRejectedResult).reason?.message)).slice(0, 3)).toEqual([]);
      await db.transaction().execute((t) => setAutomationControl(t, { organizationId: orgId, paused: false, emergency: false, userId: owner.userId }));
      await postEnable(post("agents-enable", owner, { organizationId: orgId, agent: "risk-engine", enabled: true }));
      for (let i = 0; i < 3; i++) await runAgentEventEngine({ organizationId: orgId });
      for (const id of runs) expect(await concluded(id)).toBeLessThanOrEqual(1);
      expect((await verifyAuditLogChain()).integra).toBe(true);
      log({ cenario: "G", operacoes: `${ops.length} operações concorrentes (limite org/global, pausa org/global, agente, conclusões, motor)`, deadlocks: deadlocks.length, ordemDeAquisicao: "global(compartilhada|exclusiva) → organização", estadoFinal: "sem conclusão duplicada; cadeia íntegra", esperado: "0 deadlocks", observado: `${deadlocks.length} deadlocks`, consistente: deadlocks.length === 0, observacao: "o teste é estresse COMPLEMENTAR; a garantia vem da ordem fixa global→organização" });
    });
  });

  describe("Cenário H — alteração simultânea da política", () => {
    it("H1 duas pessoas alteram o MESMO limite: a cerca as serializa (a segunda espera a primeira); nenhuma duplicata; as duas ficam auditadas", async () => {
      const admin = await createAuthenticatedUser(); await db.insertInto("memberships").values({ organizationId: orgId, userId: admin.userId, role: "administrador", status: "ativo" }).execute();
      const first = holdTransaction((t) => setPolicyLimit(t, { organizationId: orgId, key: "AUTO_ACCEPT_MAX_VALUE", value: 300, userId: owner.userId })); await first.entered;
      const order: string[] = []; const second = db.transaction().execute((t) => setPolicyLimit(t, { organizationId: orgId, key: "AUTO_ACCEPT_MAX_VALUE", value: 200, userId: admin.userId })).then(() => order.push("segunda"));
      await waitUntilFenceBlocked(); expect(order).toEqual([]);
      first.release(); await first.promise.then(() => order.push("primeira")); await second;
      expect(order).toEqual(["primeira", "segunda"]);
      const rows = await db.selectFrom("policyLimits").select(["value", "updatedByUserId"]).where("organizationId", "=", orgId).where("key", "=", "AUTO_ACCEPT_MAX_VALUE").execute();
      expect(rows).toHaveLength(1); expect((rows[0].value as { v: number }).v).toBe(200); expect(rows[0].updatedByUserId).toBe(admin.userId); // a última a confirmar prevalece
      const audit = await db.selectFrom("auditLog").select("actorUserId").where("action", "=", "politica.limite_alterado").where("organizationId", "=", orgId).orderBy("id").execute();
      expect(audit.map((a) => a.actorUserId)).toEqual([owner.userId, admin.userId]);
      log({ cenario: "H1", operacoes: ["setPolicyLimit 300 [owner, tx segurando a cerca]", "setPolicyLimit 200 [admin]"], ordemEfetiva: order, locks: [], estadoInicial: "sem restrição própria", estadoFinal: "1 linha, valor 200 (última), 2 auditorias na ordem", esperado: "serialização", observado: order.join(" → "), consistente: true });
    });
    it("H2 duas requisições reais simultâneas ao endpoint: ambas 200, 1 linha, 2 auditorias, valor final = o da última auditada", async () => {
      const admin = await createAuthenticatedUser(); await db.insertInto("memberships").values({ organizationId: orgId, userId: admin.userId, role: "administrador", status: "ativo" }).execute();
      const [a, b] = await Promise.all([postLimits(post("policy-limits", owner, { organizationId: orgId, key: "AUTO_ACCEPT_MAX_VALUE", value: 250 })), postLimits(post("policy-limits", admin, { organizationId: orgId, key: "AUTO_ACCEPT_MAX_VALUE", value: 150 }))]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const rows = await db.selectFrom("policyLimits").select(["value", "updatedByUserId"]).where("organizationId", "=", orgId).where("key", "=", "AUTO_ACCEPT_MAX_VALUE").execute();
      expect(rows).toHaveLength(1);
      const last = (await db.selectFrom("auditLog").select("actorUserId").where("action", "=", "politica.limite_alterado").where("organizationId", "=", orgId).orderBy("id", "desc").limit(1).executeTakeFirstOrThrow()).actorUserId;
      expect(rows[0].updatedByUserId).toBe(last); // o autor persistido é o da última alteração auditada
      expect((await effective()).length).toBe(1);
    });
  });
});
