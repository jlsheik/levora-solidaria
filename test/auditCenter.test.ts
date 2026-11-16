/**
 * M38 — Central de Auditoria, rastreabilidade e verificação da cadeia (serviços reais, PostgreSQL descartável).
 * Cobre as jornadas A–J: auditoria legítima, evento de agente, dupla autorização, categoria alterada depois da decisão, reavaliação, cadeia íntegra, cadeia adulterada (SOMENTE em fixture
 * descartável: o teste desliga o gatilho append-only do banco de teste e o religa), organização indevida, paginação com escrita concorrente e falha técnica simulada.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { recordAuditLogEntry } from "../src/helpers/auditLog";
import { ensureAgentPrincipal } from "../src/helpers/agentRegistry";
import { runAgentEventEngine } from "../src/helpers/agentEventEngine";
import { publishDomainEvent } from "../src/helpers/domainEvents";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { AUDIT_CHAIN_TEST_HOOKS, awaitVerification } from "../src/helpers/auditChainVerification";
import { summarize } from "../src/helpers/auditCenter";
import { handle as postOpportunity } from "../src/endpoints/opportunities_POST";
import { handle as postCategory } from "../src/endpoints/opportunities-category_POST";
import { handle as postReevaluate } from "../src/endpoints/agent-event-reevaluate_POST";
import { handle as postDecideException } from "../src/endpoints/exception-queue-decide_POST";
import { handle as getList } from "../src/endpoints/audit-center_GET";
import { handle as getEntry } from "../src/endpoints/audit-center-entry_GET";
import { handle as getSummary } from "../src/endpoints/audit-center-summary_GET";
import { handle as getTrace } from "../src/endpoints/audit-trace_GET";
import { handle as getVerifications } from "../src/endpoints/audit-chain-verifications_GET";
import { handle as postVerify } from "../src/endpoints/audit-chain-verify_POST";
import { handle as getLegacyVerify } from "../src/endpoints/audit-log-verify_GET";
import type { MembershipRole } from "../src/helpers/schema";
import { createAuthenticatedUser, createPlatformAdmin, createTestOrganization, addMembership, buildRequest, parseJson, type AuthenticatedTestUser } from "./helpers";

const get = (p: string, a?: AuthenticatedTestUser) => buildRequest(p, { cookie: a?.cookie });
const post = (p: string, a: AuthenticatedTestUser | undefined, body: unknown) => buildRequest(p, { method: "POST", cookie: a?.cookie, body });
async function member(orgId: number, role: MembershipRole) { const u = await createAuthenticatedUser(); await addMembership(orgId, u.userId, role); return u; }
const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

type Entry = { id: string; action: string; entityType: string; entityId: string | null; actorType: string; actorUserId: number | null; actorName: string | null; createdAt: string; outcome: string | null; correlationId: string | null; chained: boolean };
type List = { entries: Entry[]; nextCursor: string | null; total: { count: number; capped: boolean }; newerCount: number | null };
type Trace = {
  subject: { kind: string; id: string }; opportunity: null | { id: number; currentCategory: string | null; version: number };
  steps: Array<{ key: string; at: string; title: string; auditEntryId: string | null; correlationId: string | null; actor: string | null }>;
  decisions: Array<{ runId: string; status: string; decision: string | null; categoryConsidered: string | null; currentCategory: string | null; categoryDiffers: boolean | null; recalculated: boolean; versionConsidered: number | null; laterChanges: Array<{ previousValue: string | null; newValue: string | null; auditEntryId: string | null }> }>;
  auditEntries: Entry[]; limits: string[];
};
type Verifs = { canRun: boolean; isPlatformAdmin: boolean; verifications: Array<{ id: string; status: string; totalEvents: number | null; verifiedEvents: number | null; unhashedEvents: number | null; divergenceCount: number | null; divergences: Array<{ id: string; reason: string }> | null; divergencesInYourOrganization: number | null; coveredUpToEventId: string | null; errorKind: string | null; requestedByName: string | null }> };

const listOf = async (who: AuthenticatedTestUser | undefined, query: string) => parseJson<List>(await getList(get(`audit-center?${query}`, who)));

describe("Central de Auditoria (M38)", () => {
  let owner: AuthenticatedTestUser; let orgId: number; let platform: AuthenticatedTestUser;
  beforeEach(async () => {
    owner = await createAuthenticatedUser(); orgId = (await createTestOrganization(owner.userId)).id;
    platform = await createPlatformAdmin(); await ensureAgentPrincipal(db, "risk-engine", orgId); await wait();
  });
  afterEach(async () => {
    AUDIT_CHAIN_TEST_HOOKS.beforeVerify = undefined;
    // fixtures descartáveis: religa os gatilhos append-only que alguns testes desligam (nunca em banco operacional)
    await sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update`.execute(db);
    await sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_delete`.execute(db);
  });

  const createOpp = async (extra: Record<string, unknown> = {}) => {
    const res = await postOpportunity(post("opportunities", owner, { organizationId: orgId, title: "Oferta sintética", donorName: "Doador Sintético", quantityOffered: 3, unit: "kg", ...extra }));
    expect(res.status).toBe(200);
    return db.selectFrom("donationOpportunities").select(["id", "version"]).where("organizationId", "=", orgId).orderBy("id", "desc").executeTakeFirstOrThrow();
  };
  const runOf = (oppId: number) => db.selectFrom("agentEventRuns as r").innerJoin("domainEvents as e", "e.id", "r.eventId").select(["r.id", "r.status", "r.exceptionId"]).where("e.entityId", "=", String(oppId)).where("e.entityType", "=", "donation_opportunity").executeTakeFirst();
  const editCat = (oppId: number, category: string, version: number, who: AuthenticatedTestUser = owner) => postCategory(post("opportunities-category", who, { organizationId: orgId, opportunityId: oppId, category, expectedVersion: version }));
  const traceOf = async (query: string, who: AuthenticatedTestUser = owner) => parseJson<Trace>(await getTrace(get(`audit-trace?organizationId=${orgId}&${query}`, who)));
  const verify = async (who: AuthenticatedTestUser = platform) => { const r = await postVerify(post("audit-chain-verify", who, {})); if (r.status === 202) { const { id } = await parseJson<{ id: string }>(r.clone()); await awaitVerification(id); } return r; };
  const verifs = async (who: AuthenticatedTestUser | undefined, org: number | null = orgId) => parseJson<Verifs>(await getVerifications(get(`audit-chain-verifications${org ? `?organizationId=${org}` : ""}`, who)));

  describe("Jornada A — auditoria legítima (escopo, ator e recurso corretos; paginação, filtros, minimização)", () => {
    it("uma operação concluída aparece na Central com ator, recurso e escopo; só quem tem auditoria.leia vê; hash nunca sai", async () => {
      const opp = await createOpp();
      expect((await editCat(opp.id, "Roupa", opp.version)).status).toBe(200);
      const l = await listOf(owner, `organizationId=${orgId}`);
      const e = l.entries.find((x) => x.action === "oportunidade.categoria_alterada")!;
      expect(e).toMatchObject({ entityType: "donation_opportunity", entityId: String(opp.id), actorType: "user", actorUserId: owner.userId, outcome: "concluida", chained: true }); // M39: resultado EXPLÍCITO gravado pelo ponto que conhece o desfecho
      expect(e.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      const detail = await getEntry(get(`audit-center-entry?organizationId=${orgId}&id=${e.id}`, owner));
      expect(detail.status).toBe(200);
      const body = await detail.text();
      const row = await db.selectFrom("auditLog").select(["eventHash", "previousEventHash", "organizationId"]).where("id", "=", e.id).executeTakeFirstOrThrow();
      expect(row.organizationId).toBe(orgId);
      expect(body).not.toContain(row.eventHash!); expect(body).not.toContain(row.previousEventHash ?? "§§"); // valores de hash são internos
      // papéis sem auditoria.leia
      for (const role of ["operador", "voluntario"] as const) {
        const u = await member(orgId, role);
        expect((await getList(get(`audit-center?organizationId=${orgId}`, u))).status).toBe(403);
        expect((await getSummary(get(`audit-center-summary?organizationId=${orgId}`, u))).status).toBe(403);
        expect((await getTrace(get(`audit-trace?organizationId=${orgId}&opportunityId=${opp.id}`, u))).status).toBe(403);
      }
      expect((await getList(get(`audit-center?organizationId=${orgId}`))).status).toBe(401);
    });

    it("filtros combináveis no banco: área, ação, quem agiu, falhas/recusas, correlação, recurso e período; intervalo inválido = 400", async () => {
      const opp = await createOpp(); await editCat(opp.id, "Roupa", opp.version);
      await recordAuditLogEntry({ organizationId: orgId, actorUserId: owner.userId, action: "usuario.login_falhou", entityType: "usuario", entityId: "x1", metadata: { motivo: "senha" }, outcome: "falhou" }); // M39: o resultado é informado, não deduzido do nome
      await recordAuditLogEntry({ organizationId: orgId, actorUserId: null, actorType: "system", action: "automacao.alerta_criado", entityType: "integrity_alert", entityId: "9", metadata: {} });
      const all = await listOf(owner, `organizationId=${orgId}`); expect(all.total).toEqual({ count: all.entries.length, capped: false });
      expect((await listOf(owner, `organizationId=${orgId}&resultado=falhou`)).entries.map((e) => e.action)).toEqual(["usuario.login_falhou"]);
      expect((await listOf(owner, `organizationId=${orgId}&resultado=falhou`)).entries[0].outcome).toBe("falhou");
      expect((await listOf(owner, `organizationId=${orgId}&area=oportunidades`)).entries.every((e) => e.action.startsWith("oportunidade."))).toBe(true);
      expect((await listOf(owner, `organizationId=${orgId}&actorType=system`)).entries.map((e) => e.action)).toEqual(["automacao.alerta_criado"]);
      expect((await listOf(owner, `organizationId=${orgId}&action=oportunidade.categoria_alterada&actorType=user`)).entries).toHaveLength(1);
      expect((await listOf(owner, `organizationId=${orgId}&entityType=donation_opportunity&entityId=${opp.id}`)).entries.length).toBeGreaterThan(0);
      const corr = all.entries.find((e) => e.correlationId)!.correlationId!;
      expect((await listOf(owner, `organizationId=${orgId}&correlationId=${corr}`)).entries.every((e) => e.correlationId === corr)).toBe(true);
      const future = new Date(Date.now() + 86400000).toISOString(); const past = new Date(Date.now() - 86400000).toISOString();
      expect((await listOf(owner, `organizationId=${orgId}&from=${encodeURIComponent(future)}`)).entries).toHaveLength(0);
      expect((await listOf(owner, `organizationId=${orgId}&from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}`)).entries.length).toBe(all.entries.length);
      expect((await getList(get(`audit-center?organizationId=${orgId}&from=${encodeURIComponent(future)}&to=${encodeURIComponent(past)}`, owner))).status).toBe(400);
      for (const bad of ["beforeId=abc", "limit=0", "limit=101", "area=inexistente", "correlationId=xyz", "action=UPPER;DROP", "resultado=sucesso", "actorType=robo"]) {
        expect((await getList(get(`audit-center?organizationId=${orgId}&${bad}`, owner))).status, bad).toBe(400);
      }
    });

    it("resumo: período separado do histórico total; sem permissão de automação o campo é null (nunca zero); contagens batem com o banco", async () => {
      const opp = await createOpp(); await editCat(opp.id, "Roupa", opp.version);
      await recordAuditLogEntry({ organizationId: orgId, actorUserId: owner.userId, action: "usuario.login_falhou", entityType: "usuario", entityId: "x1", metadata: {}, outcome: "falhou" });
      await recordAuditLogEntry({ organizationId: orgId, actorUserId: owner.userId, action: "legado.sem_resultado", entityType: "teste", entityId: "l1", metadata: {} }); // formato histórico, sem resultado
      const dbCount = Number((await db.selectFrom("auditLog").select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", orgId).executeTakeFirstOrThrow()).n);
      const s = await parseJson<Awaited<ReturnType<typeof summarize>>>(await getSummary(get(`audit-center-summary?organizationId=${orgId}`, owner)));
      expect(s.operations).toEqual({ count: dbCount, capped: false }); expect(s.history).toEqual({ count: dbCount, capped: false }); expect(s.byOutcome.falhou.count).toBe(1); expect(s.byOutcome.naoRegistrado.count).toBe(1); // registros sem resultado gravado NÃO são contados como sucesso
      expect(s.automation).not.toBeNull(); expect(s.automation!.agentDecisions.total).toBe(Number((await db.selectFrom("agentEventRuns").select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", orgId).executeTakeFirstOrThrow()).n));
      const past = new Date(Date.now() - 86400000).toISOString();
      const old = await parseJson<Awaited<ReturnType<typeof summarize>>>(await getSummary(get(`audit-center-summary?organizationId=${orgId}&to=${encodeURIComponent(past)}`, owner)));
      expect(old.operations.count).toBe(0); expect(old.history.count).toBe(dbCount); // total do período ≠ histórico total
      expect((await summarize(orgId, null, null, false)).automation).toBeNull(); // perfil sem automacao.leia: desconhecido, não zero
    });
  });

  describe("Jornadas B, C, D, E — rastreabilidade de oportunidades, agentes, exceções e reavaliações", () => {
    it("B evento de agente: a decisão do Risk Engine é registrada e encontrada pela Central (execução, evento, auditoria vinculada)", async () => {
      const opp = await createOpp({ category: "Roupa" });
      await runAgentEventEngine({ organizationId: orgId });
      const run = (await runOf(opp.id))!; expect(run.status).toBe("simulacao_concluida");
      const l = await listOf(owner, `organizationId=${orgId}&area=agentes`);
      expect(l.entries.length).toBeGreaterThan(0); expect(l.entries.every((e) => e.actorType === "agent" && e.actorName === "risk-engine")).toBe(true);
      expect(l.entries.map((e) => e.action)).toContain("agente.evento_simulacao_concluida");
      const t = await traceOf(`opportunityId=${opp.id}`);
      expect(t.subject).toEqual({ kind: "oportunidade", id: String(opp.id) });
      expect(t.steps.map((s) => s.key)).toEqual(expect.arrayContaining(["oportunidade", "evento", "transicao", "decisao"]));
      expect(t.decisions).toHaveLength(1); expect(t.decisions[0]).toMatchObject({ runId: String(run.id), status: "simulacao_concluida", categoryConsidered: "roupa", currentCategory: "Roupa", categoryDiffers: false, recalculated: false });
      expect(t.auditEntries.some((e) => e.entityType === "agent_event_run" && e.entityId === String(run.id))).toBe(true);
      const byRun = await traceOf(`runId=${run.id}`); expect(byRun.subject.kind).toBe("execucao"); expect(byRun.opportunity?.id).toBe(opp.id);
      // transições feitas por agente apontam para o seu registro de auditoria; nada é inventado quando o vínculo não existe
      const linked = t.steps.filter((s) => s.key === "transicao" && s.auditEntryId);
      expect(linked.length).toBeGreaterThan(0);
      for (const s of linked) expect((await getEntry(get(`audit-center-entry?organizationId=${orgId}&id=${s.auditEntryId}`, owner))).status).toBe(200);
    });

    it("C dupla autorização: dois revisores distintos, sequência e atores preservados na rastreabilidade e na auditoria", async () => {
      const admin = await member(orgId, "administrador");
      const opp = await createOpp({ category: "Roupa" });
      await db.transaction().execute((trx) => publishDomainEvent(trx, { eventType: "opportunity.created", organizationId: orgId, entityType: "donation_opportunity", entityId: String(opp.id), payload: { v: 2, category: "Roupa", quantityOffered: 3, unit: "kg", estimatedValue: 999999, actorUserId: owner.userId } as never }));
      await runAgentEventEngine({ organizationId: orgId });
      const run = await db.selectFrom("agentEventRuns").select(["id", "status", "exceptionId", "ruleCode"]).where("status", "=", "aguardando_aprovacao").executeTakeFirstOrThrow();
      expect(run.ruleCode).toBe("R-VALOR-ALTO-DUPLA"); const exId = String(run.exceptionId);
      expect((await postDecideException(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: exId, decision: "aprovar" }))).status).toBe(200);
      expect((await postDecideException(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: exId, decision: "aprovar" }))).status).toBe(409); // mesma pessoa não conta duas vezes
      expect((await postDecideException(post("exception-queue-decide", admin, { organizationId: orgId, exceptionId: exId, decision: "aprovar" }))).status).toBe(200);
      for (const q of [`exceptionId=${exId}`, `runId=${run.id}`]) {
        const t = await traceOf(q);
        const humans = t.steps.filter((s) => s.key === "revisao_humana");
        expect(humans).toHaveLength(2); expect(new Set(humans.map((h) => h.actor)).size).toBe(2);
        expect(humans.every((h) => h.auditEntryId !== null)).toBe(true); // cada decisão aponta para o SEU registro de auditoria
        expect(new Set(humans.map((h) => h.auditEntryId)).size).toBe(2);
        expect(t.steps.some((s) => s.key === "excecao" && s.auditEntryId !== null)).toBe(true);
      }
      const decided = (await listOf(owner, `organizationId=${orgId}&action=automacao.excecao_decidida`)).entries;
      expect(decided.map((d) => d.actorUserId).sort()).toEqual([owner.userId, admin.userId].sort());
      const s = await parseJson<Awaited<ReturnType<typeof summarize>>>(await getSummary(get(`audit-center-summary?organizationId=${orgId}`, owner)));
      expect(s.automation!.exceptionsCreated).toBe(1); expect(s.automation!.exceptionsResolved).toBe(1);
    });

    it("D categoria alterada DEPOIS da decisão: a auditoria mostra a alteração, a decisão histórica não é reescrita nem recalculada", async () => {
      const opp = await createOpp({ category: "Roupa" });
      await runAgentEventEngine({ organizationId: orgId });
      const run = (await runOf(opp.id))!; expect(run.status).toBe("simulacao_concluida");
      const before = await db.selectFrom("agentEventRuns").select(["status", "detail", "updatedAt"]).where("id", "=", run.id).executeTakeFirstOrThrow();
      await wait(20);
      expect((await editCat(opp.id, "Calçado", opp.version)).status).toBe(200);
      const t = await traceOf(`opportunityId=${opp.id}`);
      expect(t.opportunity).toMatchObject({ currentCategory: "Calçado", version: 2 });
      const d = t.decisions[0];
      expect(d).toMatchObject({ status: "simulacao_concluida", categoryConsidered: "roupa", currentCategory: "Calçado", categoryDiffers: true, recalculated: false });
      expect(d.laterChanges).toHaveLength(1); expect(d.laterChanges[0]).toMatchObject({ previousValue: "Roupa", newValue: "Calçado" }); expect(d.laterChanges[0].auditEntryId).not.toBeNull();
      const aud = (await db.selectFrom("auditLog").select(["id", "metadata"]).where("id", "=", d.laterChanges[0].auditEntryId!).executeTakeFirstOrThrow());
      expect(JSON.stringify(aud.metadata)).not.toContain("Calçado"); // auditoria sem valores (minimização preservada)
      // decisão histórica intacta
      const after = await db.selectFrom("agentEventRuns").select(["status", "detail", "updatedAt"]).where("id", "=", run.id).executeTakeFirstOrThrow();
      expect(after.status).toBe(before.status); expect(after.detail).toEqual(before.detail); expect(after.updatedAt).toEqual(before.updatedAt);
      await runAgentEventEngine({ organizationId: orgId }); // outra passada do motor não reavalia a decisão concluída
      expect((await db.selectFrom("agentEventRuns").select("status").where("id", "=", run.id).executeTakeFirstOrThrow()).status).toBe("simulacao_concluida");
      expect((await db.selectFrom("agentEventReevaluations").select("id").where("runId", "=", run.id).execute())).toHaveLength(0); // nenhuma reavaliação automática
    });

    it("E reavaliação: dados insuficientes → categoria corrigida → nova análise; a sequência completa aparece com auditoria em cada passo", async () => {
      const opp = await createOpp(); await runAgentEventEngine({ organizationId: orgId });
      const run = (await runOf(opp.id))!; expect(run.status).toBe("dados_insuficientes");
      expect((await editCat(opp.id, "Roupa", opp.version)).status).toBe(200);
      expect((await postReevaluate(post("agent-event-reevaluate", owner, { organizationId: orgId, runId: String(run.id) }))).status).toBe(200);
      const t = await traceOf(`opportunityId=${opp.id}`);
      const keys = t.steps.map((s) => s.key);
      expect(keys).toEqual(expect.arrayContaining(["alteracao_categoria", "reavaliacao", "decisao"]));
      expect(keys.indexOf("alteracao_categoria")).toBeLessThan(keys.indexOf("reavaliacao"));
      const re = t.steps.find((s) => s.key === "reavaliacao")!; const ch = t.steps.find((s) => s.key === "alteracao_categoria")!;
      expect(re.auditEntryId).not.toBeNull(); expect(ch.auditEntryId).not.toBeNull(); expect(re.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(t.decisions[0]).toMatchObject({ status: "simulacao_concluida", categoryConsidered: "roupa", categoryDiffers: false, recalculated: false });
      const byCorr = await traceOf(`correlationId=${re.correlationId}`); expect(byCorr.subject.kind).toBe("correlacao"); expect(byCorr.steps.some((s) => s.key === "reavaliacao")).toBe(true);
      const byChange = await traceOf(`correlationId=${ch.correlationId}`); expect(byChange.opportunity?.id).toBe(opp.id);
      // a avaliação anterior permanece registrada
      const re0 = await db.selectFrom("agentEventReevaluations").select(["previousStatus", "newStatus"]).where("runId", "=", run.id).executeTakeFirstOrThrow();
      expect(re0).toMatchObject({ previousStatus: "dados_insuficientes", newStatus: "simulacao_concluida" });
    });
  });

  describe("Jornadas F, G, J — verificação da cadeia (íntegra, adulterada, falha técnica)", () => {
    it("F cadeia íntegra: a verificação reutiliza o algoritmo existente, registra escopo e momento e só a plataforma executa; organizações leem o resultado sem ids alheios", async () => {
      const opp = await createOpp(); await editCat(opp.id, "Roupa", opp.version);
      expect((await verifs(owner)).verifications).toHaveLength(0); // ainda não verificado ≠ aprovado
      expect((await postVerify(post("audit-chain-verify", owner, {}))).status).toBe(403); // organização não executa (cadeia global)
      expect((await postVerify(post("audit-chain-verify", undefined, {}))).status).toBe(401);
      expect((await postVerify(post("audit-chain-verify", platform, { scope: "organizacao" }))).status).toBe(400);
      const r = await verify(); expect(r.status).toBe(202);
      const canonical = await verifyAuditLogChain();
      const v = (await verifs(owner)).verifications[0];
      expect(v).toMatchObject({ status: "integra", divergenceCount: 0, divergences: null, divergencesInYourOrganization: 0, requestedByName: null });
      expect(v.verifiedEvents).toBe(canonical.eventosVerificados); expect(v.unhashedEvents).toBe(canonical.eventosPreExistentesSemHash);
      expect(Number(v.coveredUpToEventId)).toBeGreaterThan(0);
      const asPlatform = await verifs(platform, null); expect(asPlatform).toMatchObject({ canRun: true, isPlatformAdmin: true }); expect(asPlatform.verifications[0].divergences).toEqual([]);
      expect((await verifs(owner)).canRun).toBe(false);
      expect((await getVerifications(get("audit-chain-verifications", owner))).status).toBe(403); // sem organização = consulta de plataforma
      expect((await db.selectFrom("auditLog").select("id").where("action", "=", "auditoria.verificacao_solicitada").execute())).toHaveLength(1); // o PEDIDO é auditado
      expect((await getLegacyVerify(get("audit-log-verify", platform))).status).toBe(200); // endpoint antigo preservado
      expect((await verifyAuditLogChain()).integra).toBe(true);
    });

    it("G adulteração em fixture descartável: conteúdo alterado, registro ausente, elo quebrado e hash removido são DETECTADOS; nada é reparado; escopo por organização", async () => {
      const other = await createAuthenticatedUser(); const otherOrg = (await createTestOrganization(other.userId)).id;
      for (let i = 0; i < 4; i++) { await recordAuditLogEntry({ organizationId: orgId, actorUserId: owner.userId, action: "teste.registro", entityType: "teste_chain", entityId: `a${i}`, metadata: { i } }); await recordAuditLogEntry({ organizationId: otherOrg, actorUserId: other.userId, action: "teste.registro", entityType: "teste_chain", entityId: `b${i}`, metadata: { i } }); }
      expect((await verify()).status).toBe(202); expect((await verifs(owner)).verifications[0].status).toBe("integra");
      const rows = await db.selectFrom("auditLog").select(["id", "metadata", "eventHash", "previousEventHash"]).where("entityType", "=", "teste_chain").orderBy("id", "asc").execute();
      const limitId = (await db.selectFrom("auditLog").select((eb) => eb.fn.max("id").as("m")).executeTakeFirstOrThrow()).m!;
      const snapshot = async () => JSON.stringify(await db.selectFrom("auditLog").select(["id", "metadata", "eventHash", "previousEventHash"]).where("id", "<=", limitId).orderBy("id", "asc").execute()); // só o que existia antes das verificações
      await sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update`.execute(db);
      // 1) conteúdo alterado numa linha da organização do dono
      const mine = rows[0]; // organização do dono
      await sql`UPDATE audit_log SET metadata = metadata || '{"adulterado":true}'::jsonb WHERE id = ${mine.id}`.execute(db);
      const tampered = await snapshot();
      expect((await verify()).status).toBe(202);
      const v1 = (await verifs(platform, null)).verifications[0];
      expect(v1.status).toBe("inconsistencia"); expect(v1.divergenceCount).toBeGreaterThanOrEqual(1);
      expect(v1.divergences!.some((d) => d.id === String(mine.id) && d.reason === "hash_nao_bate")).toBe(true);
      expect(JSON.stringify(v1)).not.toMatch(/[0-9a-f]{64}/); // hashes nunca saem
      expect(await snapshot()).toBe(tampered); // NADA foi reparado nem recalculado
      // escopo: a organização do dono vê que há divergência nos eventos DELA; a outra vê 0 e nenhum id
      const mineView = (await verifs(owner)).verifications[0]; expect(mineView).toMatchObject({ status: "inconsistencia", divergences: null }); expect(mineView.divergencesInYourOrganization).toBeGreaterThanOrEqual(1);
      const otherView = (await verifs(other, otherOrg)).verifications[0]; expect(otherView).toMatchObject({ status: "inconsistencia", divergences: null, divergencesInYourOrganization: 0 });
      // 2) elo quebrado (sequência incompleta): previous_event_hash zerado
      await sql`UPDATE audit_log SET metadata = metadata - 'adulterado' WHERE id = ${mine.id}`.execute(db);
      const link = rows[5]; await sql`UPDATE audit_log SET previous_event_hash = NULL WHERE id = ${link.id}`.execute(db);
      await verify(); const v2 = (await verifs(platform, null)).verifications[0];
      expect(v2.status).toBe("inconsistencia"); expect(v2.divergences!.some((d) => d.id === String(link.id) && d.reason === "previous_hash_nao_bate_com_evento_anterior")).toBe(true);
      await sql`UPDATE audit_log SET previous_event_hash = ${link.previousEventHash} WHERE id = ${link.id}`.execute(db);
      // 3) hash removido no meio: o evento vira "não verificável" e o elo seguinte acusa
      const mid = rows[3]; await sql`UPDATE audit_log SET event_hash = NULL WHERE id = ${mid.id}`.execute(db);
      await verify(); const v3 = (await verifs(platform, null)).verifications[0];
      expect(v3.status).toBe("inconsistencia"); expect(v3.unhashedEvents).toBeGreaterThanOrEqual(1);
      await sql`UPDATE audit_log SET event_hash = ${mid.eventHash} WHERE id = ${mid.id}`.execute(db);
      // 4) registro AUSENTE (removido): o evento seguinte aponta para um hash que já não está na sequência
      await sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_delete`.execute(db);
      const gone = rows[2]; await sql`DELETE FROM audit_log WHERE id = ${gone.id}`.execute(db);
      await verify(); const v4 = (await verifs(platform, null)).verifications[0];
      expect(v4.status).toBe("inconsistencia"); expect(v4.divergences!.some((d) => d.id === String(rows[3].id) && d.reason === "previous_hash_nao_bate_com_evento_anterior")).toBe(true);
      expect((await db.selectFrom("auditLog").select("id").where("id", "=", gone.id).execute())).toHaveLength(0); // continua ausente: nada foi recriado
      // a Central continua consultável e não "melhora" o resultado
      expect((await getList(get(`audit-center?organizationId=${orgId}`, owner))).status).toBe(200);
      expect((await verifs(owner)).verifications.map((x) => x.status).every((s) => s === "inconsistencia" || s === "integra")).toBe(true);
    });

    it("J falha técnica: indisponibilidade simulada NUNCA vira íntegra; dois pedidos simultâneos → um 409; verificação interrompida vira incompleta; registro final é imutável", async () => {
      AUDIT_CHAIN_TEST_HOOKS.beforeVerify = async () => { throw new Error("banco indisponível (simulado) postgres://segredo"); };
      expect((await verify()).status).toBe(202);
      const failed = (await verifs(owner)).verifications[0];
      expect(failed).toMatchObject({ status: "falha_tecnica", errorKind: "verificacao_nao_concluida", divergenceCount: null, verifiedEvents: null });
      expect(JSON.stringify(failed)).not.toContain("segredo"); // nenhuma mensagem interna vaza
      // pedidos simultâneos: o limite operacional é uma verificação por vez
      const g = gate(); AUDIT_CHAIN_TEST_HOOKS.beforeVerify = () => g.p;
      const first = await postVerify(post("audit-chain-verify", platform, {})); expect(first.status).toBe(202); const firstId = (await parseJson<{ id: string }>(first)).id;
      const second = await postVerify(post("audit-chain-verify", platform, {})); expect(second.status).toBe(409);
      expect((await parseJson<{ code?: string }>(second)).code).toBe("verificacao_em_andamento");
      expect((await verifs(owner)).verifications[0].status).toBe("em_andamento");
      g.open(); await awaitVerification(firstId); expect((await verifs(owner)).verifications[0].status).toBe("integra");
      // verificação "em andamento" velha demais (processo reiniciado) → incompleta, sem resultado de integridade
      await db.insertInto("auditChainVerifications").values({ scope: "global_chain", requestedByUserId: platform.userId, startedAt: new Date(Date.now() - 3600_000) }).execute();
      expect((await verify()).status).toBe(202);
      const all = (await verifs(owner)).verifications;
      expect(all.map((x) => x.status)).toEqual(["integra", "incompleta", "integra", "falha_tecnica"]);
      expect(all[1].errorKind).toBe("interrompida");
      // append-only operacional
      await expect(db.updateTable("auditChainVerifications").set({ status: "integra", divergenceCount: 0 }).where("id", "=", all[3].id).execute()).rejects.toThrow();
      await expect(sql`DELETE FROM audit_chain_verifications`.execute(db)).rejects.toThrow();
    });
  });

  describe("Jornadas H, I — organização indevida e paginação com escrita concorrente", () => {
    it("H outra organização: lista, registro, resumo, rastreabilidade e verificação respondem 403/404 sem expor dados", async () => {
      const opp = await createOpp(); await editCat(opp.id, "Roupa", opp.version); await runAgentEventEngine({ organizationId: orgId });
      const intruder = await createAuthenticatedUser(); const foreignOrg = (await createTestOrganization(intruder.userId)).id;
      const aId = (await listOf(owner, `organizationId=${orgId}`)).entries[0].id; const run = (await runOf(opp.id))!;
      expect((await getList(get(`audit-center?organizationId=${orgId}`, intruder))).status).toBe(403);
      expect((await getSummary(get(`audit-center-summary?organizationId=${orgId}`, intruder))).status).toBe(403);
      expect((await getVerifications(get(`audit-chain-verifications?organizationId=${orgId}`, intruder))).status).toBe(403);
      expect((await getTrace(get(`audit-trace?organizationId=${orgId}&opportunityId=${opp.id}`, intruder))).status).toBe(403);
      // com o PRÓPRIO organizationId mas ids da outra organização: 404, indistinguível de inexistente
      expect((await getEntry(get(`audit-center-entry?organizationId=${foreignOrg}&id=${aId}`, intruder))).status).toBe(404);
      expect((await getEntry(get(`audit-center-entry?organizationId=${foreignOrg}&id=999999999`, intruder))).status).toBe(404);
      for (const q of [`opportunityId=${opp.id}`, `runId=${run.id}`, `correlationId=${(await listOf(owner, `organizationId=${orgId}`)).entries.find((e) => e.correlationId)!.correlationId}`]) {
        expect((await getTrace(get(`audit-trace?organizationId=${foreignOrg}&${q}`, intruder))).status, q).toBe(404);
      }
      expect((await listOf(intruder, `organizationId=${foreignOrg}`)).entries.every((e) => e.entityId !== String(opp.id) || e.entityType !== "donation_opportunity")).toBe(true);
      expect((await getTrace(get(`audit-trace?organizationId=${orgId}`, owner))).status).toBe(400); // exige exatamente um ponto de partida
      expect((await getTrace(get(`audit-trace?organizationId=${orgId}&opportunityId=1&runId=1`, owner))).status).toBe(400);
    });

    it("I paginação por cursor: registros novos durante a leitura não duplicam nem omitem; ordem estável; contagem de novos separada", async () => {
      for (let i = 0; i < 9; i++) await recordAuditLogEntry({ organizationId: orgId, actorUserId: owner.userId, action: "teste.paginacao", entityType: "teste_pag", entityId: String(i), metadata: { i } });
      const q = `organizationId=${orgId}&entityType=teste_pag&limit=4`;
      const p1 = await listOf(owner, q); expect(p1.entries.map((e) => e.entityId)).toEqual(["8", "7", "6", "5"]); expect(p1.total.count).toBe(9); expect(p1.nextCursor).toBe(p1.entries[3].id);
      for (let i = 9; i < 12; i++) await recordAuditLogEntry({ organizationId: orgId, actorUserId: owner.userId, action: "teste.paginacao", entityType: "teste_pag", entityId: String(i), metadata: { i } }); // chegam enquanto o usuário lê
      const p2 = await listOf(owner, `${q}&beforeId=${p1.nextCursor}`); expect(p2.entries.map((e) => e.entityId)).toEqual(["4", "3", "2", "1"]);
      const p3 = await listOf(owner, `${q}&beforeId=${p2.nextCursor}`); expect(p3.entries.map((e) => e.entityId)).toEqual(["0"]); expect(p3.nextCursor).toBeNull();
      const seen = [...p1.entries, ...p2.entries, ...p3.entries].map((e) => e.id); expect(new Set(seen).size).toBe(seen.length); // sem duplicatas
      const ids = seen.map((s) => BigInt(s)); expect(ids.every((v, i) => i === 0 || v < ids[i - 1])).toBe(true); // ordem estritamente decrescente
      const fresh = await listOf(owner, `${q}&sinceId=${p1.entries[0].id}`); expect(fresh.newerCount).toBe(3);
      expect(fresh.entries.map((e) => e.entityId)).toEqual(["11", "10", "9", "8"]); // a página 1 nova mostra os recém-chegados no topo
      expect(p1.newerCount).toBeNull();
    });
  });
});
