/**
 * M39 — protótipo de PRIVILÉGIOS MÍNIMOS do banco (Jornada K), SOMENTE em PostgreSQL descartável, com papéis sintéticos de senha aleatória criados e removidos pelo próprio teste.
 * Prova: (1) o papel de runtime executa os fluxos reais M37–M39 SEM os privilégios que permitiriam contornar a trilha; (2) papéis restritos são recusados pelo banco nas ações fora de suas
 * atribuições; (3) o que privilégios mínimos NÃO resolvem (superusuário/dono, RBAC da aplicação, INSERT de registros novos). Nenhuma credencial real é lida ou alterada.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { db } from "../src/helpers/db";
import { recordAuditLogEntry } from "../src/helpers/auditLog";
import { ensureAgentPrincipal } from "../src/helpers/agentRegistry";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { applyLeastPrivilege, revokeLeastPrivilege, appendOnlyTables, type LeastPrivilegeRoles } from "../db/prototypes/leastPrivilege";
import { createAuthenticatedUser, createPlatformAdmin, createTestOrganization, buildRequest, parseJson, type AuthenticatedTestUser } from "./helpers";

const roles: LeastPrivilegeRoles = { runtime: "m39_runtime", auditReader: "m39_audit_reader", migrator: "m39_migrator" };
const pw = { runtime: randomBytes(12).toString("hex"), auditReader: randomBytes(12).toString("hex"), migrator: randomBytes(12).toString("hex") };
const adminUrl = process.env.DATABASE_URL!;
const urlFor = (user: string, pass: string) => { const u = new URL(adminUrl); u.username = user; u.password = pass; return u.toString(); };
let admin: postgres.Sql; const clients: postgres.Sql[] = [];
const as = (user: string, pass: string) => { const c = postgres(urlFor(user, pass), { max: 1, prepare: false, onnotice: () => undefined }); clients.push(c); return c; };
const denied = async (p: PromiseLike<unknown>) => { try { await p; } catch (e) { const err = e as { code?: string; message?: string }; return `${err.code}:${err.message}`; } return null; };
const get = (p: string, a?: AuthenticatedTestUser) => buildRequest(p, { cookie: a?.cookie });
const post = (p: string, a: AuthenticatedTestUser | undefined, body: unknown) => buildRequest(p, { method: "POST", cookie: a?.cookie, body });

describe("privilégios mínimos do banco (protótipo, banco descartável)", () => {
  let appendOnly: string[] = [];
  beforeAll(async () => { admin = postgres(adminUrl, { max: 2, prepare: false, onnotice: () => undefined }); await revokeLeastPrivilege(admin, roles).catch(() => undefined); appendOnly = (await applyLeastPrivilege(admin, roles, pw)).appendOnly; });
  afterAll(async () => { for (const c of clients) await c.end({ timeout: 2 }).catch(() => undefined); await revokeLeastPrivilege(admin, roles); await admin.end({ timeout: 2 }); });

  it("a lista de tabelas append-only vem do catálogo e inclui a trilha, as verificações e os comprovantes", async () => {
    expect(appendOnly).toEqual(expect.arrayContaining(["audit_log", "audit_chain_receipts", "audit_chain_receipt_comparisons", "domain_events", "opportunity_changes", "agent_event_run_history"]));
    // agent_event_reevaluations tem guarda PRÓPRIA (permite uma transição), não o gatilho genérico: o runtime mantém DML nela e quem impede o resto é o gatilho — o banco não distingue mais que isso
    expect(appendOnly).not.toContain("agent_event_reevaluations");
    expect((await appendOnlyTables(admin)).length).toBe(appendOnly.length);
  });

  it("K runtime: NÃO consegue alterar hashes, apagar/truncar a trilha, mexer em gatilhos, fazer DDL/migrations, nem alterar/apagar verificações e comprovantes", async () => {
    const owner = await createAuthenticatedUser(); const org = await createTestOrganization(owner.userId);
    await recordAuditLogEntry({ organizationId: org.id, actorUserId: owner.userId, action: "teste.priv", entityType: "teste_priv", entityId: "1", metadata: {}, outcome: "concluida" });
    const row = await db.selectFrom("auditLog").select("id").where("entityType", "=", "teste_priv").executeTakeFirstOrThrow();
    const rt = as(roles.runtime, pw.runtime);
    // o runtime LÊ e INSERE na trilha (precisa disso para a aplicação funcionar)…
    expect((await rt`SELECT count(*)::int AS n FROM audit_log`)[0].n).toBeGreaterThan(0);
    // …mas não altera nem apaga
    const attempts: Array<[string, PromiseLike<unknown>]> = [
      ["UPDATE de hash", rt`UPDATE audit_log SET event_hash = 'x' WHERE id = ${row.id}`],
      ["UPDATE de resultado", rt`UPDATE audit_log SET outcome = 'concluida' WHERE id = ${row.id}`],
      ["DELETE da trilha", rt`DELETE FROM audit_log WHERE id = ${row.id}`],
      ["TRUNCATE da trilha", rt`TRUNCATE audit_log`],
      ["desativar gatilho append-only", rt.unsafe("ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update")],
      ["DROP TRIGGER", rt.unsafe("DROP TRIGGER audit_log_no_delete ON audit_log")],
      ["DDL: ADD COLUMN", rt.unsafe("ALTER TABLE audit_log ADD COLUMN x TEXT")],
      ["DDL: DROP TABLE", rt.unsafe("DROP TABLE audit_log")],
      ["migration: CREATE TABLE", rt.unsafe("CREATE TABLE m39_migration_probe (id int)")],
      ["apagar verificações", rt`DELETE FROM audit_chain_verifications`],
      ["alterar o solicitante de uma verificação", rt`UPDATE audit_chain_verifications SET requested_by_user_id = 1`],
      ["alterar comprovantes", rt`UPDATE audit_chain_receipts SET head_hash = 'x'`],
      ["apagar comprovantes", rt`DELETE FROM audit_chain_receipts`],
      ["alterar comparações", rt`UPDATE audit_chain_receipt_comparisons SET status = 'conferido'`],
      ["apagar comparações", rt`DELETE FROM audit_chain_receipt_comparisons`],
      ["alterar histórico de oportunidade", rt`UPDATE opportunity_changes SET new_value = 'x'`],
      ["apagar eventos de domínio", rt`DELETE FROM domain_events`],
      ["criar papel", rt.unsafe("CREATE ROLE m39_intruso LOGIN")],
    ];
    for (const [name, attempt] of attempts) expect(await denied(attempt), name).toMatch(/42501|permission denied|must be owner|permissão negada|precisa ser o dono/i);
    // a trilha continua intacta e verificável
    expect((await verifyAuditLogChain()).integra).toBe(true);
  });

  it("K auditReader: lê só o que precisa, isolado por organização (RLS), e não altera nada nem lê dados de negócio/sessão", async () => {
    const a = await createAuthenticatedUser(); const orgA = (await createTestOrganization(a.userId)).id;
    const b = await createAuthenticatedUser(); const orgB = (await createTestOrganization(b.userId)).id;
    await recordAuditLogEntry({ organizationId: orgA, actorUserId: a.userId, action: "teste.a", entityType: "teste_rls", entityId: "a", metadata: {}, outcome: "concluida" });
    await recordAuditLogEntry({ organizationId: orgB, actorUserId: b.userId, action: "teste.b", entityType: "teste_rls", entityId: "b", metadata: {}, outcome: "concluida" });
    const rd = as(roles.auditReader, pw.auditReader);
    expect((await rd`SELECT count(*)::int AS n FROM audit_log`)[0].n).toBe(0); // sem organização informada: nenhuma linha
    const scoped = async (org: number) => rd.begin(async (tx) => { await tx.unsafe(`SELECT set_config('levora.org_id', '${org}', true)`); return tx`SELECT entity_id FROM audit_log WHERE entity_type = 'teste_rls'`; });
    expect((await scoped(orgA)).map((r) => r.entity_id)).toEqual(["a"]); expect((await scoped(orgB)).map((r) => r.entity_id)).toEqual(["b"]); // não vê a outra organização
    expect((await rd`SELECT count(*)::int AS n FROM audit_chain_verifications`).length).toBe(1); // consulta resultados de verificação
    for (const [name, attempt] of [
      ["INSERT na trilha", rd`INSERT INTO audit_log (action, entity_type, metadata) VALUES ('x','y','{}')`],
      ["UPDATE na trilha", rd`UPDATE audit_log SET outcome = 'concluida'`],
      ["DELETE na trilha", rd`DELETE FROM audit_log`],
      ["alterar política", rd`UPDATE policy_limits SET key = key`],
      ["ler usuários", rd`SELECT * FROM users LIMIT 1`],
      ["ler sessões", rd`SELECT * FROM sessions LIMIT 1`],
      ["inserir comprovante", rd.unsafe(`INSERT INTO audit_chain_receipts (scope, format_version, algorithm, verification_id, last_event_id, event_count, head_hash, receipt_digest, canonical, created_by_user_id) VALUES ('global_chain',1,'sha256',1,1,1,'${"a".repeat(64)}','${"b".repeat(64)}','{}',1)`)],
      ["DDL", rd.unsafe("CREATE TABLE m39_migration_probe (id int)")],
    ] as Array<[string, PromiseLike<unknown>]>) expect(await denied(attempt), name).toMatch(/42501|permission denied|permissão negada|row-level security|segurança em nível de linha/i);
  });

  it("K migrator: executa DDL de migration mas NÃO tem acesso aos dados de auditoria; o runtime não executa migrations", async () => {
    const mg = as(roles.migrator, pw.migrator);
    await mg.unsafe("CREATE TABLE m39_migration_probe (id int)"); await mg.unsafe("ALTER TABLE m39_migration_probe ADD COLUMN x TEXT"); // DDL próprio: permitido
    for (const [name, attempt] of [["ler a trilha", mg`SELECT * FROM audit_log LIMIT 1`], ["alterar a trilha", mg`UPDATE audit_log SET outcome = 'concluida'`], ["apagar a trilha", mg`DELETE FROM audit_log`], ["ler verificações", mg`SELECT * FROM audit_chain_verifications`]] as Array<[string, PromiseLike<unknown>]>) {
      expect(await denied(attempt), name).toMatch(/42501|permission denied|permissão negada/i);
    }
    expect(await denied(as(roles.runtime, pw.runtime).unsafe("DROP TABLE m39_migration_probe")), "runtime não remove tabela do migrator").toMatch(/42501|must be owner|precisa ser o dono|permission denied/i);
  });

  it("limites que o protótipo NÃO elimina: o superusuário/dono desativa o gatilho e altera a trilha; o banco não aplica o RBAC da aplicação; o runtime ainda INSERE registros novos", async () => {
    const owner = await createAuthenticatedUser(); const org = (await createTestOrganization(owner.userId)).id;
    await recordAuditLogEntry({ organizationId: org, actorUserId: owner.userId, action: "teste.lim", entityType: "teste_lim", entityId: "1", metadata: {}, outcome: "concluida" });
    const row = await db.selectFrom("auditLog").select("id").where("entityType", "=", "teste_lim").executeTakeFirstOrThrow();
    // dono/superusuário (a credencial do teste) consegue — a verificação interna é o que acusa
    await admin.unsafe("ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update");
    try { await admin`UPDATE audit_log SET metadata = '{"x":1}'::jsonb WHERE id = ${row.id}`; expect((await verifyAuditLogChain()).integra).toBe(false); } finally { await admin.unsafe("ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update"); }
    // RBAC da aplicação não é do banco: o runtime altera política (a aplicação é quem autoriza)
    const rt = as(roles.runtime, pw.runtime);
    expect(await denied(rt`UPDATE policy_limits SET key = key`)).toBeNull();
    // e o runtime ainda INSERE na trilha (necessário para funcionar); o banco não distingue um registro legítimo de um falso novo
    expect(await denied(rt`INSERT INTO audit_log (action, entity_type, metadata) VALUES ('forjado.pelo_runtime', 'teste_lim', '{}')`)).toBeNull();
    expect((await verifyAuditLogChain()).integra).toBe(false); // sem hash válido na cadeia, o registro forjado é acusado pela verificação interna (hash/elo)
  });

  it("os fluxos REAIS rodam com o papel restrito (sem DDL, sem UPDATE/DELETE na trilha): cadastro, categoria, motor, reavaliação, exceção, verificação, comprovante, comparação e Central", async () => {
    // a verificação do teste anterior deixou uma linha forjada: a cadeia de teste é limpa (TRUNCATE só no banco descartável) antes do fluxo real
    await admin.unsafe("TRUNCATE audit_log");
    const owner = await createAuthenticatedUser(); const orgId = (await createTestOrganization(owner.userId)).id; const platform = await createPlatformAdmin();
    await ensureAgentPrincipal(db, "risk-engine", orgId); await new Promise((r) => setTimeout(r, 20));
    vi.resetModules(); vi.stubEnv("DATABASE_URL", urlFor(roles.runtime, pw.runtime));
    try {
      const m = {
        opp: (await import("../src/endpoints/opportunities_POST")).handle, cat: (await import("../src/endpoints/opportunities-category_POST")).handle, reeval: (await import("../src/endpoints/agent-event-reevaluate_POST")).handle,
        decide: (await import("../src/endpoints/exception-queue-decide_POST")).handle, verify: (await import("../src/endpoints/audit-chain-verify_POST")).handle, receipt: (await import("../src/endpoints/audit-chain-receipt_POST")).handle,
        compare: (await import("../src/endpoints/audit-chain-receipt-compare_POST")).handle, center: (await import("../src/endpoints/audit-center_GET")).handle, trace: (await import("../src/endpoints/audit-trace_GET")).handle,
        engine: (await import("../src/helpers/agentEventEngine")).runAgentEventEngine, await: (await import("../src/helpers/auditChainVerification")).awaitVerification,
      };
      const created = await m.opp(post("opportunities", owner, { organizationId: orgId, title: "Oferta sob papel restrito", donorName: "Doador", quantityOffered: 3, unit: "kg" })); expect(created.status).toBe(200);
      await m.engine({ organizationId: orgId });
      const opp = await db.selectFrom("donationOpportunities").select(["id", "version", "correlationId"]).where("title", "=", "Oferta sob papel restrito").executeTakeFirstOrThrow();
      const run = await db.selectFrom("agentEventRuns").select(["id", "status"]).where("correlationId", "=", opp.correlationId).executeTakeFirstOrThrow(); expect(run.status).toBe("dados_insuficientes");
      expect((await m.cat(post("opportunities-category", owner, { organizationId: orgId, opportunityId: opp.id, category: "Roupa", expectedVersion: opp.version }))).status).toBe(200);
      expect((await m.reeval(post("agent-event-reevaluate", owner, { organizationId: orgId, runId: String(run.id) }))).status).toBe(200);
      const med = await m.opp(post("opportunities", owner, { organizationId: orgId, title: "Oferta de alto risco restrita", donorName: "Doador", quantityOffered: 1, unit: "kg", category: "medicamento" })); expect(med.status).toBe(200);
      await m.engine({ organizationId: orgId });
      const ex = await db.selectFrom("exceptionQueue").select("id").where("organizationId", "=", orgId).executeTakeFirstOrThrow();
      expect((await m.decide(post("exception-queue-decide", owner, { organizationId: orgId, exceptionId: String(ex.id), decision: "aprovar" }))).status).toBe(200);
      const v = await m.verify(post("audit-chain-verify", platform, {})); expect(v.status).toBe(202); await m.await((await parseJson<{ id: string }>(v)).id);
      expect((await db.selectFrom("auditChainVerifications").select("status").orderBy("id", "desc").executeTakeFirstOrThrow()).status).toBe("integra");
      const r = await m.receipt(post("audit-chain-receipt", platform, {})); expect(r.status).toBe(201); const rc = await parseJson<{ canonical: string }>(r);
      const cmp = await m.compare(post("audit-chain-receipt-compare", platform, { receipt: rc.canonical })); expect((await parseJson<{ status: string }>(cmp)).status).toBe("conferido");
      const list = await m.center(get(`audit-center?organizationId=${orgId}&resultado=concluida`, owner)); expect(list.status).toBe(200); expect((await parseJson<{ entries: unknown[] }>(list)).entries.length).toBeGreaterThan(3);
      expect((await m.trace(get(`audit-trace?organizationId=${orgId}&opportunityId=${opp.id}`, owner))).status).toBe(200);
      expect((await verifyAuditLogChain()).integra).toBe(true); // tudo escrito sob o papel restrito mantém a cadeia coerente
    } finally { vi.unstubAllEnvs(); vi.resetModules(); }
  });
});
