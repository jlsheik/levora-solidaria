/**
 * M39 — resultado EXPLÍCITO, compatibilidade histórica do hash (v1/v2) e correlação persistida (serviços reais, PostgreSQL descartável).
 * Jornadas A–F: concluída, recusada, falha+rollback, registro histórico sem resultado, correlação completa e reavaliação. Nada é inferido pelo nome da ação.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { recordAuditLogEntry, recordAuditFailure, computeAuditEventHash } from "../src/helpers/auditLog";
import { ensureAgentPrincipal } from "../src/helpers/agentRegistry";
import { runAgentEventEngine, advanceRun } from "../src/helpers/agentEventEngine";
import { outcomeForRunStatus } from "../src/helpers/agentEventRuns";
import { setAutomationControl } from "../src/helpers/automationControls";
import { publishDomainEvent } from "../src/helpers/domainEvents";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { isCorrelationId } from "../src/helpers/correlation";
import { handle as postOpportunity } from "../src/endpoints/opportunities_POST";
import { handle as postCategory } from "../src/endpoints/opportunities-category_POST";
import { handle as postReevaluate } from "../src/endpoints/agent-event-reevaluate_POST";
import { handle as postDecideException } from "../src/endpoints/exception-queue-decide_POST";
import { handle as getList } from "../src/endpoints/audit-center_GET";
import { handle as getSummary } from "../src/endpoints/audit-center-summary_GET";
import { handle as getTrace } from "../src/endpoints/audit-trace_GET";
import type { MembershipRole } from "../src/helpers/schema";
import { createAuthenticatedUser, createTestOrganization, addMembership, buildRequest, parseJson, type AuthenticatedTestUser } from "./helpers";

const get = (p: string, a?: AuthenticatedTestUser) => buildRequest(p, { cookie: a?.cookie });
const post = (p: string, a: AuthenticatedTestUser | undefined, body: unknown) => buildRequest(p, { method: "POST", cookie: a?.cookie, body });
async function member(orgId: number, role: MembershipRole) { const u = await createAuthenticatedUser(); await addMembership(orgId, u.userId, role); return u; }
const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));

type Entry = { id: string; action: string; entityType: string; entityId: string | null; outcome: "concluida" | "recusada" | "falhou" | "pendente" | null; correlationId: string | null; operationId: string | null; recordVersion: number; chained: boolean };
type List = { entries: Entry[]; total: { count: number; capped: boolean } };
type Trace = { subject: { kind: string; id: string }; opportunity: null | { id: number }; journey: { correlationId: string | null }; steps: Array<{ key: string; auditEntryId: string | null; linkKind: "direta" | "correlacao" | null; title: string }>; auditEntries: Array<Entry & { link: "direta" | "correlacao" }>; decisions: Array<{ status: string; recalculated: boolean }> };

describe("M39 — resultado explícito, correlação e compatibilidade do hash", () => {
  let owner: AuthenticatedTestUser; let orgId: number;
  beforeEach(async () => { owner = await createAuthenticatedUser(); orgId = (await createTestOrganization(owner.userId)).id; await ensureAgentPrincipal(db, "risk-engine", orgId); await wait(); });
  afterEach(async () => {
    await sql`DROP TRIGGER IF EXISTS m39_falha_simulada ON domain_events`.execute(db);
    await sql`DROP FUNCTION IF EXISTS m39_falha_simulada()`.execute(db);
    await sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update`.execute(db);
    await sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_delete`.execute(db);
  });
  const entries = async (query = "", who: AuthenticatedTestUser = owner) => parseJson<List>(await getList(get(`audit-center?organizationId=${orgId}&limit=100${query}`, who))).then((l) => l.entries);
  const createOpp = async (extra: Record<string, unknown> = {}) => {
    const res = await postOpportunity(post("opportunities", owner, { organizationId: orgId, title: "Oferta sintética", donorName: "Doador Sintético", quantityOffered: 3, unit: "kg", ...extra }));
    expect(res.status).toBe(200);
    return db.selectFrom("donationOpportunities").selectAll().where("organizationId", "=", orgId).orderBy("id", "desc").executeTakeFirstOrThrow();
  };
  const traceOf = async (q: string) => parseJson<Trace>(await getTrace(get(`audit-trace?organizationId=${orgId}&${q}`, owner)));
  const runOf = (oppId: number) => db.selectFrom("agentEventRuns as r").innerJoin("domainEvents as e", "e.id", "r.eventId").select(["r.id", "r.status", "r.exceptionId", "r.correlationId"]).where("e.entityId", "=", String(oppId)).where("e.entityType", "=", "donation_opportunity").executeTakeFirst();

  describe("contrato e compatibilidade do hash (versões 1 e 2)", () => {
    it("mapeamento estado→resultado é explícito e testado (nunca por texto)", () => {
      expect(["recebido", "validado", "autorizado_simulacao", "simulacao_concluida"].map(outcomeForRunStatus)).toEqual(["concluida", "concluida", "concluida", "concluida"]);
      expect(["aguardando_aprovacao", "dados_insuficientes"].map(outcomeForRunStatus)).toEqual(["pendente", "pendente"]);
      expect(["bloqueado_politica", "rejeitado", "ignorado"].map(outcomeForRunStatus)).toEqual(["recusada", "recusada", "recusada"]);
      expect(outcomeForRunStatus("falha")).toBe("falhou");
      expect(isCorrelationId("5b0c1a9e-0b0e-4f4c-9a4e-6f8f3d3f0a11")).toBe(true); expect(isCorrelationId("organizacao-1")).toBe(false); expect(isCorrelationId(42)).toBe(false);
    });

    it("v1 (sem resultado/correlação) e v2 convivem na MESMA cadeia: todos verificam; nada do histórico foi recalculado", async () => {
      await recordAuditLogEntry({ organizationId: orgId, actorUserId: owner.userId, action: "legado.operacao", entityType: "teste", entityId: "1", metadata: { a: 1 } }); // formato histórico
      await recordAuditLogEntry({ organizationId: orgId, actorUserId: owner.userId, action: "novo.operacao", entityType: "teste", entityId: "2", metadata: { a: 2 }, outcome: "concluida", correlationId: "5b0c1a9e-0b0e-4f4c-9a4e-6f8f3d3f0a11" });
      await recordAuditLogEntry({ organizationId: orgId, actorUserId: owner.userId, action: "legado.operacao", entityType: "teste", entityId: "3", metadata: { a: 3 } });
      const rows = await db.selectFrom("auditLog").select(["recordVersion", "outcome", "correlationId", "eventHash"]).where("entityType", "=", "teste").orderBy("id", "asc").execute();
      expect(rows.map((r) => r.recordVersion)).toEqual([1, 2, 1]); expect(rows[0].outcome).toBeNull(); expect(rows[1]).toMatchObject({ outcome: "concluida", correlationId: "5b0c1a9e-0b0e-4f4c-9a4e-6f8f3d3f0a11" });
      expect((await verifyAuditLogChain()).integra).toBe(true);
      // o hash v1 continua EXATAMENTE o canônico histórico (sem tokens novos)
      const legacy = await db.selectFrom("auditLog").selectAll().where("entityId", "=", "1").where("entityType", "=", "teste").executeTakeFirstOrThrow();
      expect(computeAuditEventHash({ organizationId: legacy.organizationId, actorUserId: legacy.actorUserId, action: legacy.action, entityType: legacy.entityType, entityId: legacy.entityId, metadata: legacy.metadata as never, createdAt: legacy.createdAt, previousEventHash: legacy.previousEventHash })).toBe(legacy.eventHash);
    });

    it("o resultado e a correlação fazem parte do conteúdo protegido: alterar o resultado, a versão ou a correlação de um registro v2 é DETECTADO", async () => {
      await recordAuditLogEntry({ organizationId: orgId, actorUserId: owner.userId, action: "novo.operacao", entityType: "teste_h", entityId: "1", metadata: {}, outcome: "recusada", correlationId: "5b0c1a9e-0b0e-4f4c-9a4e-6f8f3d3f0a11" });
      const row = await db.selectFrom("auditLog").select("id").where("entityType", "=", "teste_h").executeTakeFirstOrThrow();
      expect((await verifyAuditLogChain()).integra).toBe(true);
      await sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update`.execute(db);
      await sql`UPDATE audit_log SET outcome = 'concluida' WHERE id = ${row.id}`.execute(db); // "recusada" → "concluida" (falsificação de resultado)
      let v = await verifyAuditLogChain(); expect(v.integra).toBe(false); expect(v.divergencias.some((d) => d.id === String(row.id) && d.reason === "hash_nao_bate")).toBe(true);
      await sql`UPDATE audit_log SET outcome = 'recusada', correlation_id = '11111111-1111-4111-8111-111111111111' WHERE id = ${row.id}`.execute(db); // correlação trocada
      v = await verifyAuditLogChain(); expect(v.divergencias.some((d) => d.reason === "hash_nao_bate")).toBe(true);
      await sql`UPDATE audit_log SET correlation_id = '5b0c1a9e-0b0e-4f4c-9a4e-6f8f3d3f0a11' WHERE id = ${row.id}`.execute(db);
      expect((await verifyAuditLogChain()).integra).toBe(true); // restaurado = coerente de novo
    });

    it("versões inconsistentes ou não suportadas nunca são silenciadas; as constraints do banco recusam combinações impossíveis", async () => {
      await recordAuditLogEntry({ organizationId: orgId, actorUserId: owner.userId, action: "legado.operacao", entityType: "teste_v", entityId: "1", metadata: {} });
      await recordAuditLogEntry({ organizationId: orgId, actorUserId: owner.userId, action: "novo.operacao", entityType: "teste_v", entityId: "2", metadata: {}, outcome: "concluida" });
      const [v1, v2] = await db.selectFrom("auditLog").select("id").where("entityType", "=", "teste_v").orderBy("id", "asc").execute();
      // o banco recusa: v1 com resultado; v2 sem nada; resultado fora do vocabulário; versão fora de {1,2}; correlação fora do formato
      for (const stmt of [sql`UPDATE audit_log SET outcome = 'concluida' WHERE id = ${v1.id}`, sql`UPDATE audit_log SET record_version = 2 WHERE id = ${v1.id}`, sql`UPDATE audit_log SET outcome = 'sucesso' WHERE id = ${v2.id}`, sql`UPDATE audit_log SET record_version = 3 WHERE id = ${v2.id}`, sql`UPDATE audit_log SET correlation_id = 'nao-e-uuid' WHERE id = ${v2.id}`]) {
        await sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update`.execute(db);
        await expect(stmt.execute(db), "constraint").rejects.toThrow();
      }
      // com as constraints removidas (privilégio de dono, só em banco descartável) o VERIFICADOR ainda acusa
      await sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update`.execute(db);
      await sql`ALTER TABLE audit_log DROP CONSTRAINT audit_log_record_version_chk`.execute(db);
      await sql`UPDATE audit_log SET outcome = 'concluida' WHERE id = ${v1.id}`.execute(db); // v1 com resultado
      await sql`UPDATE audit_log SET record_version = 7 WHERE id = ${v2.id}`.execute(db); // versão desconhecida
      const v = await verifyAuditLogChain();
      expect(v.integra).toBe(false);
      expect(v.divergencias.find((d) => d.id === String(v1.id) && d.reason === "versao_inconsistente")).toBeTruthy();
      expect(v.divergencias.find((d) => d.id === String(v2.id) && d.reason === "versao_nao_suportada")).toBeTruthy();
      // restaura a constraint exatamente como na migration (a tabela de teste é esvaziada antes, para que a validação passe)
      await sql`TRUNCATE audit_log`.execute(db);
      await sql`ALTER TABLE audit_log ADD CONSTRAINT audit_log_record_version_chk CHECK ((record_version = 1 AND outcome IS NULL AND correlation_id IS NULL) OR (record_version = 2 AND (outcome IS NOT NULL OR correlation_id IS NOT NULL)))`.execute(db);
    });
  });

  describe("eventos sem hash", () => {
    it("sem hash ANTES do primeiro evento encadeado = histórico (migração 0003), sem divergência; sem hash DEPOIS do início da cadeia = divergência (inserção fora do caminho ou hash removido)", async () => {
      await sql`TRUNCATE audit_log`.execute(db);
      await sql`INSERT INTO audit_log (organization_id, actor_user_id, action, entity_type, metadata) VALUES (${orgId}, ${owner.userId}, 'historico.antigo', 'teste', '{}'::jsonb), (${orgId}, ${owner.userId}, 'historico.antigo', 'teste', '{}'::jsonb)`.execute(db);
      await recordAuditLogEntry({ organizationId: orgId, actorUserId: owner.userId, action: "novo.operacao", entityType: "teste", entityId: "1", metadata: {}, outcome: "concluida" });
      let v = await verifyAuditLogChain(); expect(v).toMatchObject({ integra: true, eventosPreExistentesSemHash: 2, eventosVerificados: 1 });
      await sql`INSERT INTO audit_log (organization_id, actor_user_id, action, entity_type, metadata) VALUES (${orgId}, ${owner.userId}, 'forjado.sem_hash', 'teste', '{}'::jsonb)`.execute(db);
      v = await verifyAuditLogChain(); expect(v.integra).toBe(false);
      expect(v.divergencias).toEqual([expect.objectContaining({ reason: "hash_ausente_apos_inicio_da_cadeia", storedEventHash: null })]);
    });
  });

  describe("Jornadas A–D — resultado explícito", () => {
    it("A concluída: a operação grava resultado explícito na mesma transação; a Central exibe e filtra por ele", async () => {
      const opp = await createOpp({ category: "Roupa" });
      const row = (await entries()).find((e) => e.action === "oportunidade.registrada")!;
      expect(row).toMatchObject({ outcome: "concluida", recordVersion: 2, entityId: String(opp.id), chained: true }); expect(isCorrelationId(row.correlationId)).toBe(true);
      expect(row.correlationId).toBe(opp.correlationId); // a MESMA correlação da oportunidade
      expect((await entries("&resultado=concluida")).some((e) => e.id === row.id)).toBe(true);
      expect((await entries("&resultado=recusada")).some((e) => e.id === row.id)).toBe(false);
      const s = await parseJson<{ byOutcome: Record<string, { count: number }> }>(await getSummary(get(`audit-center-summary?organizationId=${orgId}`, owner)));
      expect(s.byOutcome.concluida.count).toBeGreaterThanOrEqual(1);
      expect((await verifyAuditLogChain()).integra).toBe(true);
    });

    it("B recusada: pedido de nova análise barrado por regra de domínio (pausa) é auditado como RECUSADO — e não existe registro de solicitação", async () => {
      const opp = await createOpp(); await runAgentEventEngine({ organizationId: orgId });
      const run = (await runOf(opp.id))!; expect(run.status).toBe("dados_insuficientes");
      expect((await postCategory(post("opportunities-category", owner, { organizationId: orgId, opportunityId: opp.id, category: "Roupa", expectedVersion: opp.version }))).status).toBe(200);
      await db.transaction().execute((t) => setAutomationControl(t, { organizationId: orgId, paused: true, emergency: false, userId: owner.userId }));
      const res = await postReevaluate(post("agent-event-reevaluate", owner, { organizationId: orgId, runId: String(run.id) }));
      expect(res.status).toBe(409);
      const es = await entries();
      const refused = es.find((e) => e.action === "agente.reavaliacao_recusada")!;
      expect(refused).toMatchObject({ outcome: "recusada", entityId: String(run.id) });
      expect(refused.correlationId).toBe(run.correlationId); // herdou a correlação da jornada
      expect(es.some((e) => e.action === "agente.reavaliacao_solicitada")).toBe(false); // sem sucesso indevido
      expect((await db.selectFrom("agentEventRuns").select("status").where("id", "=", run.id).executeTakeFirstOrThrow()).status).toBe("dados_insuficientes"); // nada mudou
    });

    it("C falha e rollback: uma operação revertida não deixa registro de conclusão; a FALHA é auditada fora da transação revertida; falha técnica do motor = 'falhou'", async () => {
      // 1) operação real que falha DEPOIS do registro de auditoria: o evento não pode ser gravado → rollback do cadastro INTEIRO, inclusive do registro 'concluida'
      await sql`CREATE FUNCTION m39_falha_simulada() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'falha simulada na publicação do evento'; END; $$ LANGUAGE plpgsql`.execute(db);
      await sql`CREATE TRIGGER m39_falha_simulada BEFORE INSERT ON domain_events FOR EACH ROW EXECUTE FUNCTION m39_falha_simulada()`.execute(db);
      const before = (await db.selectFrom("auditLog").select("id").where("organizationId", "=", orgId).execute()).length;
      const res = await postOpportunity(post("opportunities", owner, { organizationId: orgId, title: "Oferta que vai falhar", donorName: "Doador", quantityOffered: 1, unit: "kg" }));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await db.selectFrom("donationOpportunities").select("id").where("title", "=", "Oferta que vai falhar").execute())).toHaveLength(0);
      expect((await db.selectFrom("auditLog").select("id").where("organizationId", "=", orgId).execute()).length).toBe(before); // NENHUM 'concluida' para operação inexistente
      await sql`DROP TRIGGER m39_falha_simulada ON domain_events`.execute(db);
      // 2) a falha pode ser auditada à parte, com resultado 'falhou' (nunca 'concluida')
      await recordAuditFailure({ organizationId: orgId, actorUserId: owner.userId, action: "oportunidade.registro_falhou", entityType: "donation_opportunity", entityId: null, metadata: { codigo: "publicacao_do_evento" } });
      expect((await entries()).find((e) => e.action === "oportunidade.registro_falhou")).toMatchObject({ outcome: "falhou", recordVersion: 2 });
      // 3) transação que registra e depois falha leva o registro junto
      await expect(db.transaction().execute(async (trx) => { await recordAuditLogEntry({ organizationId: orgId, actorUserId: owner.userId, action: "teste.nao_deve_existir", entityType: "teste", entityId: "x", metadata: {}, outcome: "concluida" }, trx); throw new Error("rollback"); })).rejects.toThrow("rollback");
      expect((await entries()).some((e) => e.action === "teste.nao_deve_existir")).toBe(false);
      // 4) falha técnica do motor: execução vai a 'falha' e o registro de auditoria diz 'falhou'
      const opp = await createOpp({ category: "Roupa" });
      const ev = await db.selectFrom("domainEvents").select("id").where("entityId", "=", String(opp.id)).executeTakeFirstOrThrow();
      const principal = await ensureAgentPrincipal(db, "risk-engine", orgId);
      const run = await db.insertInto("agentEventRuns").values({ eventId: String(ev.id), agentPrincipalId: principal.id, organizationId: orgId, eventType: "opportunity.created", status: "validado", attempts: 3, reasonCode: "erro_inesperado", correlationId: opp.correlationId }).returning("id").executeTakeFirstOrThrow();
      expect((await advanceRun(String(run.id))).status).toBe("falha");
      const failed = (await entries()).find((e) => e.action === "agente.evento_falha")!;
      expect(failed).toMatchObject({ outcome: "falhou", entityId: String(run.id) }); expect(failed.correlationId).toBe(opp.correlationId);
    });

    it("D histórico: registro sem resultado explícito aparece como NÃO REGISTRADO — o nome da ação não vira resultado e nada é presumido", async () => {
      // nomes que SUGEREM resultado, gravados no formato histórico (sem outcome)
      await recordAuditLogEntry({ organizationId: orgId, actorUserId: owner.userId, action: "usuario.login_falhou", entityType: "usuario", entityId: "9", metadata: {} });
      await recordAuditLogEntry({ organizationId: orgId, actorUserId: owner.userId, action: "operacao.concluida_com_sucesso", entityType: "teste", entityId: "9", metadata: {} });
      const es = await entries();
      for (const a of ["usuario.login_falhou", "operacao.concluida_com_sucesso"]) expect(es.find((e) => e.action === a)).toMatchObject({ outcome: null, recordVersion: 1, correlationId: null });
      const none = (await entries("&resultado=nao_registrado")).map((e) => e.action);
      expect(none).toEqual(expect.arrayContaining(["usuario.login_falhou", "operacao.concluida_com_sucesso"]));
      expect((await entries("&resultado=falhou")).some((e) => e.action === "usuario.login_falhou")).toBe(false); // não há inferência pelo nome
      expect((await getList(get(`audit-center?organizationId=${orgId}&outcome=falha`, owner))).status).toBe(200); // o parâmetro antigo é ignorado, não reinterpretado
      expect((await getList(get(`audit-center?organizationId=${orgId}&resultado=sucesso`, owner))).status).toBe(400);
    });
  });

  describe("Jornadas E, F — correlação persistida", () => {
    it("E uma jornada de oportunidade carrega a MESMA correlação: oportunidade → evento → execução → exceção → decisão humana → auditoria; entrada externa é ignorada", async () => {
      const forged = "11111111-1111-4111-8111-111111111111";
      const res = await postOpportunity(post("opportunities", owner, { organizationId: orgId, title: "Oferta de alto risco", donorName: "Doador", quantityOffered: 2, unit: "unidade", category: "medicamento", correlationId: forged }));
      expect(res.status).toBe(200);
      const opp = await db.selectFrom("donationOpportunities").selectAll().where("title", "=", "Oferta de alto risco").executeTakeFirstOrThrow();
      expect(isCorrelationId(opp.correlationId)).toBe(true); expect(opp.correlationId).not.toBe(forged); // nunca vem do cliente
      await runAgentEventEngine({ organizationId: orgId });
      const ev = await db.selectFrom("domainEvents").select(["id", "correlationId"]).where("entityId", "=", String(opp.id)).where("entityType", "=", "donation_opportunity").executeTakeFirstOrThrow();
      const run = (await runOf(opp.id))!;
      const ex = await db.selectFrom("exceptionQueue").select(["id", "correlationId", "status"]).where("id", "=", run.exceptionId!).executeTakeFirstOrThrow();
      expect(run.status).toBe("aguardando_aprovacao");
      expect(new Set([opp.correlationId, ev.correlationId, run.correlationId, ex.correlationId]).size).toBe(1); // um identificador, quatro tabelas
      expect((await postDecideException(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: String(ex.id), decision: "aprovar" }))).status).toBe(200);
      await runAgentEventEngine({ organizationId: orgId });
      const all = await db.selectFrom("auditLog").select(["action", "outcome", "correlationId", "entityType"]).where("correlationId", "=", opp.correlationId).orderBy("id", "asc").execute();
      const acts = all.map((a) => a.action);
      expect(acts).toEqual(expect.arrayContaining(["oportunidade.registrada", "agente.evento_validado", "agente.excecao_criada", "agente.evento_aguardando_aprovacao", "automacao.excecao_decidida"]));
      expect(all.every((a) => a.outcome !== null)).toBe(true);
      expect(all.find((a) => a.action === "agente.excecao_criada")!.outcome).toBe("pendente"); expect(all.find((a) => a.action === "automacao.excecao_decidida")!.outcome).toBe("concluida");
      // a rastreabilidade mostra a jornada pelos identificadores persistidos
      const t = await traceOf(`correlationId=${opp.correlationId}`);
      expect(t.subject.kind).toBe("correlacao"); expect(t.opportunity?.id).toBe(opp.id); expect(t.journey.correlationId).toBe(opp.correlationId);
      expect(t.auditEntries.every((e) => e.correlationId === opp.correlationId || e.link === "direta")).toBe(true);
      expect(t.auditEntries.some((e) => e.link === "direta")).toBe(true);
      const exStep = t.steps.find((s) => s.key === "excecao")!; expect(exStep.auditEntryId).not.toBeNull(); expect(exStep.linkKind).not.toBeNull();
      // passo SEM vínculo verificável aparece sem vínculo (nada inventado)
      expect(t.steps.find((s) => s.key === "oportunidade")!.linkKind).toBeNull();
      const byOpp = await traceOf(`opportunityId=${opp.id}`); expect(byOpp.journey.correlationId).toBe(opp.correlationId);
      // a correlação de OUTRA organização não é resolvida aqui
      const other = await createAuthenticatedUser(); const otherOrg = (await createTestOrganization(other.userId)).id;
      expect((await getTrace(get(`audit-trace?organizationId=${otherOrg}&correlationId=${opp.correlationId}`, other))).status).toBe(404);
    });

    it("F reavaliação: decisão anterior intacta; registros novos (categoria, solicitação, transições) carregam a correlação da jornada", async () => {
      const opp = await createOpp(); await runAgentEventEngine({ organizationId: orgId });
      const run = (await runOf(opp.id))!; expect(run.status).toBe("dados_insuficientes");
      const decisionBefore = (await db.selectFrom("agentEventRuns").select("detail").where("id", "=", run.id).executeTakeFirstOrThrow()).detail as { decision?: string };
      expect((await postCategory(post("opportunities-category", owner, { organizationId: orgId, opportunityId: opp.id, category: "Roupa", expectedVersion: opp.version }))).status).toBe(200);
      expect((await postReevaluate(post("agent-event-reevaluate", owner, { organizationId: orgId, runId: String(run.id) }))).status).toBe(200);
      const rows = await db.selectFrom("auditLog").select(["action", "outcome", "correlationId", "metadata"]).where("correlationId", "=", opp.correlationId).orderBy("id", "asc").execute();
      const byAction = Object.fromEntries(rows.map((r) => [r.action, r]));
      expect(byAction["oportunidade.categoria_alterada"].outcome).toBe("concluida"); expect(byAction["agente.reavaliacao_solicitada"].outcome).toBe("pendente");
      expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["oportunidade.registrada", "agente.evento_dados_insuficientes", "oportunidade.categoria_alterada", "agente.reavaliacao_solicitada", "agente.evento_simulacao_concluida"]));
      // identificador da OPERAÇÃO (metadata.correlacao) continua distinto da correlação da jornada
      expect((byAction["oportunidade.categoria_alterada"].metadata as { correlacao?: string }).correlacao).not.toBe(opp.correlationId);
      // o histórico da execução anterior continua registrado
      const re = await db.selectFrom("agentEventReevaluations").select(["previousStatus", "previousDecision", "newStatus"]).where("runId", "=", run.id).executeTakeFirstOrThrow();
      expect(re).toMatchObject({ previousStatus: "dados_insuficientes", newStatus: "simulacao_concluida" }); expect(re.previousDecision).toBe(decisionBefore.decision ?? null);
      const t = await traceOf(`opportunityId=${opp.id}`);
      expect(t.journey.correlationId).toBe(opp.correlationId); expect(t.decisions[0]).toMatchObject({ status: "simulacao_concluida", recalculated: false });
      expect((await verifyAuditLogChain()).integra).toBe(true);
    });

    it("sem correlação fabricada para o passado: oportunidade/evento anteriores à M39 ficam sem correlação e a rastreabilidade diz isso", async () => {
      const opp = await createOpp(); await runAgentEventEngine({ organizationId: orgId });
      // "anterior à M39": zera as colunas (banco descartável; o gatilho append-only dos eventos é contornado só para montar a fixture)
      await sql`ALTER TABLE domain_events DISABLE TRIGGER domain_events_no_update`.execute(db);
      await sql`UPDATE domain_events SET correlation_id = NULL WHERE entity_id = ${String(opp.id)}`.execute(db);
      await sql`ALTER TABLE domain_events ENABLE TRIGGER domain_events_no_update`.execute(db);
      await sql`UPDATE donation_opportunities SET correlation_id = NULL WHERE id = ${opp.id}`.execute(db);
      await sql`UPDATE agent_event_runs SET correlation_id = NULL WHERE event_id IN (SELECT id FROM domain_events WHERE entity_id = ${String(opp.id)})`.execute(db);
      const t = await traceOf(`opportunityId=${opp.id}`);
      expect(t.journey.correlationId).toBeNull();
      expect(t.auditEntries.every((e) => e.link === "direta")).toBe(true); // só vínculo por entidade; nenhum por correlação inventada
    });
  });
});
