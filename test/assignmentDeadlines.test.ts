/**
 * Fase 98 — prazo de resposta das atribuições AUTOMÁTICAS (72 h por padrão, global e configurável), expiração segura, pausa de 7 dias e pendências da organização.
 * Tudo com PostgreSQL real; o tempo passa por manipulação do vencimento gravado (o relógio que decide é o do BANCO: `response_due_at <= now()`); a concorrência é
 * determinística: o teste segura travas numa conexão própria e só solta quando a tarefa está bloqueada no banco (pg_stat_activity).
 */
import { describe, it, expect, afterAll } from "vitest";
import postgres from "postgres";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { runMatchingForOpportunity } from "../src/helpers/opportunityMatching";
import { runMatchingSweep } from "../src/helpers/runMatchingSweep";
import { expireAssignmentDeadlines } from "../src/helpers/expireAssignmentDeadlines";
import { getRefusingOrganizationIds } from "../src/helpers/allocationRefusals";
import { TASK_HANDLERS } from "../src/helpers/taskHandlers";
import { handle as getSettings } from "../src/endpoints/assignment-settings_GET";
import { handle as postSettings } from "../src/endpoints/assignment-settings_POST";
import { handle as orgAllocations } from "../src/endpoints/organization-allocations_GET";
import { handle as logisticsHandle } from "../src/endpoints/allocations-logistics_POST";
import { handle as receiveHandle } from "../src/endpoints/allocations-receive_POST";
import { handle as manualAllocate } from "../src/endpoints/opportunity-allocations_POST";
import { createAuthenticatedUser, createPlatformAdmin, createTestOrganization, createTestSource, createTestOpportunityRegistry, createTestInventoryItem, buildRequest, parseJson } from "./helpers";
import { readFileSync } from "node:fs";

const side = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
afterAll(async () => { await side.end({ timeout: 5 }); });

async function party(withNeed: boolean | string = true) {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  if (withNeed) await addNeed(org.id, owner.userId, typeof withNeed === "string" ? withNeed : undefined);
  return { owner, org };
}
async function addNeed(orgId: number, userId: number, title = "Cobertores de inverno") {
  const [n] = await db.insertInto("needs").values({ organizationId: orgId, title, quantityNeeded: "30", unit: "unidade", priority: "critica", status: "aberta", createdByUserId: userId }).returning("id").execute();
  return n.id;
}
async function admin() { const a = await createPlatformAdmin(); const s = await createTestSource(a.userId); return { ...a, sourceId: s.id }; }
async function makeOpp(a: { userId: number; sourceId: number }, title = "Doação de cobertores de inverno") {
  const o = await createTestOpportunityRegistry(a.sourceId, a.userId, { status: "aguardando_destinacao" });
  await db.updateTable("opportunityRegistry").set({ title, status: "aguardando_destinacao", locationCity: "Belo Horizonte", locationState: "MG", quantity: "30" }).where("id", "=", o.id).execute();
  return o.id;
}
const allocs = (oppId: number, orgId?: number) => {
  let q = db.selectFrom("opportunityAllocations").selectAll().where("opportunityRegistryId", "=", oppId).orderBy("id");
  if (orgId !== undefined) q = q.where("organizationId", "=", orgId);
  return q.execute();
};
const oppStatus = async (id: number) => (await db.selectFrom("opportunityRegistry").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
const auditCount = async (action: string, entityId?: number) => {
  let q = db.selectFrom("auditLog").select((eb) => eb.fn.countAll().as("n")).where("action", "=", action);
  if (entityId !== undefined) q = q.where("entityId", "=", String(entityId));
  return Number((await q.executeTakeFirstOrThrow()).n);
};
const setDue = (allocId: number, sqlExpr: string) => sql.raw(`UPDATE opportunity_allocations SET response_due_at = ${sqlExpr} WHERE id = ${allocId}`).execute(db);
/** Cria a atribuição automática de nota alta (aceita, com prazo) da organização `p` para uma oportunidade nova. */
async function autoAssignment(p: { org: { id: number } }, a: Awaited<ReturnType<typeof admin>>, title?: string) {
  const oppId = await makeOpp(a, title);
  const r = await runMatchingForOpportunity(oppId, a.userId);
  expect(r.allocationsCreated).toHaveLength(1);
  const alloc = (await allocs(oppId, p.org.id))[0];
  return { oppId, alloc };
}
async function waitBlocked(n: number) {
  let c = 0;
  for (let i = 0; i < 400 && c < n; i++) {
    c = (await side`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0].n;
    if (c < n) await new Promise((r) => setTimeout(r, 25));
  }
  return c;
}
async function installAuditFailure(action: string) {
  await sql.raw(`CREATE OR REPLACE FUNCTION test_fail_audit() RETURNS trigger AS $f$ BEGIN IF NEW.action = '${action}' THEN RAISE EXCEPTION 'falha injetada na auditoria'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`).execute(db);
  await sql.raw("CREATE TRIGGER test_fail_audit_trg BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_fail_audit()").execute(db);
}
async function removeAuditFailure() {
  await sql.raw("DROP TRIGGER IF EXISTS test_fail_audit_trg ON audit_log").execute(db);
  await sql.raw("DROP FUNCTION IF EXISTS test_fail_audit()").execute(db);
}
const hoursBetween = async (allocId: number) =>
  Number((await sql<{ h: string }>`SELECT (EXTRACT(EPOCH FROM (response_due_at - created_at)) / 3600)::numeric(10,3) AS h FROM opportunity_allocations WHERE id = ${allocId}`.execute(db)).rows[0].h);

describe("prazo de resposta: criação e configuração global", () => {
  it("a atribuição automática de nota alta nasce 'aceita' com prazo de 72 h gravado pelo banco; manual e sem prazo não expiram por esta regra", async () => {
    const a = await admin(); const p = await party();
    const { alloc } = await autoAssignment(p, a);
    expect(alloc.status).toBe("aceita"); expect(alloc.autoMatched).toBe(true); expect(alloc.decidedByUserId).toBeNull();
    expect(alloc.responseDueAt).not.toBeNull();
    expect(Math.abs((await hoursBetween(alloc.id)) - 72)).toBeLessThan(0.01);

    const manualOpp = await makeOpp(a, "Doação manual");
    const q = await party(false);
    const res = await manualAllocate(buildRequest("opportunity-allocations", { method: "POST", cookie: a.cookie, body: { opportunityId: manualOpp, organizationId: q.org.id, quantityAllocated: 5 } }));
    expect(res.status).toBe(200);
    expect((await allocs(manualOpp, q.org.id))[0].responseDueAt).toBeNull(); // manual: sem prazo
  });

  it("configuração: padrão 72, alteração auditada (quem, valor anterior e novo), só vale para atribuições NOVAS, e valida faixa e permissão", async () => {
    const a = await admin(); const p = await party();
    const get = (cookie: string) => getSettings(buildRequest("assignment-settings", { cookie }));
    const set = (hours: unknown, cookie = a.cookie) => postSettings(buildRequest("assignment-settings", { method: "POST", cookie, body: { responseDeadlineHours: hours } }));
    const initial = await parseJson<{ responseDeadlineHours: number; isDefault: boolean; reassignmentPauseDays: number }>(await get(a.cookie));
    expect(initial).toMatchObject({ responseDeadlineHours: 72, isDefault: true, reassignmentPauseDays: 7 });

    const { alloc: before } = await autoAssignment(p, a); // criada com 72 h
    expect((await set(24)).status).toBe(200);
    expect(await parseJson(await get(a.cookie))).toMatchObject({ responseDeadlineHours: 24, isDefault: false });
    const audit = await db.selectFrom("auditLog").select(["metadata", "actorUserId"]).where("action", "=", "configuracao.prazo_atribuicao_alterado").executeTakeFirstOrThrow();
    expect(audit.actorUserId).toBe(a.userId);
    expect(audit.metadata).toMatchObject({ valorAnteriorHoras: 72, valorNovoHoras: 24 });

    expect(Math.abs((await hoursBetween(before.id)) - 72)).toBeLessThan(0.01); // a já criada NÃO foi alterada
    const { alloc: after } = await autoAssignment(p, a);
    expect(Math.abs((await hoursBetween(after.id)) - 24)).toBeLessThan(0.01); // a nova usa o valor novo

    expect((await set(24)).status).toBe(200); // mesmo valor: sem nova auditoria
    expect(await auditCount("configuracao.prazo_atribuicao_alterado")).toBe(1);
    for (const bad of [0, -1, 721, 1.5, "abc", null]) expect((await set(bad)).status, String(bad)).toBe(400);
    expect((await set(720)).status).toBe(200); expect((await set(1)).status).toBe(200);
    expect((await set(48, p.owner.cookie)).status).toBe(403); // dono de organização não é admin da plataforma
    expect((await get(p.owner.cookie)).status).toBe(403);
    expect((await set(48, "")).status).toBe(401);
  });

  it("alteração concorrente do prazo e criação de atribuição: cada atribuição recebe EXATAMENTE um dos dois valores (nunca um intermediário)", async () => {
    const a = await admin(); const p = await party();
    const oppId = await makeOpp(a);
    await Promise.all([
      postSettings(buildRequest("assignment-settings", { method: "POST", cookie: a.cookie, body: { responseDeadlineHours: 12 } })),
      runMatchingForOpportunity(oppId, a.userId),
    ]);
    const h = await hoursBetween((await allocs(oppId, p.org.id))[0].id);
    expect([72, 12].some((v) => Math.abs(h - v) < 0.01), `horas = ${h}`).toBe(true);
  });
});

describe("expiração do prazo", () => {
  it("antes do prazo não expira; no instante do vencimento e depois expira (<= now()); cancela com motivo, audita como expiração AUTOMÁTICA e reabre a oportunidade", async () => {
    const a = await admin(); const p = await party();
    const { oppId, alloc } = await autoAssignment(p, a);
    await setDue(alloc.id, "now() + interval '1 minute'");
    await expireAssignmentDeadlines();
    expect((await allocs(oppId))[0].status).toBe("aceita");
    expect(await auditCount("atribuicao.prazo_expirado")).toBe(0);

    await setDue(alloc.id, "now()"); // exatamente atingido
    await expireAssignmentDeadlines();
    const after = (await allocs(oppId))[0];
    expect(after.status).toBe("cancelada"); expect(after.closedReason).toBe("prazo_expirado"); expect(after.closedAt).not.toBeNull();
    expect(await oppStatus(oppId)).toBe("aguardando_destinacao"); // reaberta (a mesma organização está em pausa, então o rematch não a escolheu)
    const audit = await db.selectFrom("auditLog").select(["actorUserId", "metadata", "organizationId"]).where("action", "=", "atribuicao.prazo_expirado").executeTakeFirstOrThrow();
    expect(audit.actorUserId).toBeNull(); expect(audit.organizationId).toBe(p.org.id);
    expect(audit.metadata).toMatchObject({ origem: "sistema", motivo: "prazo_de_resposta_sem_movimentacao", naoERecusaExplicita: true, pausaReatribuicaoDias: 7 });
    expect((await allocs(oppId, p.org.id)).filter((x) => x.status !== "cancelada")).toEqual([]);
  });

  it("NÃO expira: manual, proposta, aceita por uma pessoa, sem prazo gravado (histórico), em coleta, em transporte, recebida", async () => {
    const a = await admin(); const p = await party(false);
    const mk = async (status: string, extra: Record<string, unknown>) => {
      const oppId = await makeOpp(a, `Oferta ${status}`);
      const [al] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: oppId, organizationId: p.org.id, status: status as never, quantityAllocated: "5", ...extra } as never).returning("id").execute();
      return { oppId, id: al.id };
    };
    const past = sql`now() - interval '1 hour'`;
    const cases = {
      manual: await mk("aceita", { autoMatched: false, responseDueAt: past }),
      aceitaPorPessoa: await mk("aceita", { autoMatched: true, decidedByUserId: a.userId, responseDueAt: past }),
      semPrazoHistorico: await mk("aceita", { autoMatched: true }),
      emColeta: await mk("em_coleta", { autoMatched: true, responseDueAt: past }),
      emTransporte: await mk("em_transporte", { autoMatched: true, responseDueAt: past }),
      recebida: await mk("recebida", { autoMatched: true, responseDueAt: past }),
      proposta: await mk("proposta", { autoMatched: true, responseDueAt: past }),
    };
    await expireAssignmentDeadlines();
    for (const [name, c] of Object.entries(cases)) {
      const row = (await allocs(c.oppId))[0];
      expect(row.closedReason, name).toBeNull();
      expect(row.status, name).not.toBe("cancelada");
    }
    expect(await auditCount("atribuicao.prazo_expirado")).toBe(0);
  });

  it("não reabre a oportunidade quando há OUTRA atribuição ativa válida", async () => {
    const a = await admin(); const p = await party(false); const q = await party(false);
    const oppId = await makeOpp(a);
    await db.updateTable("opportunityRegistry").set({ status: "atribuida" }).where("id", "=", oppId).execute();
    const [x] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: oppId, organizationId: p.org.id, status: "aceita", quantityAllocated: "10", autoMatched: true, responseDueAt: sql`now() - interval '1 minute'` }).returning("id").execute();
    await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: oppId, organizationId: q.org.id, status: "em_coleta", quantityAllocated: "10", autoMatched: true }).execute();
    await expireAssignmentDeadlines();
    expect((await allocs(oppId, p.org.id)).find((r) => r.id === x.id)!.status).toBe("cancelada");
    expect(await oppStatus(oppId)).toBe("atribuida");
  });

  it("idempotência: duas execuções em sequência e duas simultâneas expiram e auditam uma só vez", async () => {
    const a = await admin(); const p = await party();
    const { oppId, alloc } = await autoAssignment(p, a);
    await setDue(alloc.id, "now() - interval '1 minute'");
    await Promise.all([expireAssignmentDeadlines(), expireAssignmentDeadlines()]);
    await expireAssignmentDeadlines();
    expect(await auditCount("atribuicao.prazo_expirado", alloc.id)).toBe(1);
    expect((await allocs(oppId, p.org.id)).filter((x) => x.closedReason === "prazo_expirado")).toHaveLength(1);
  });

  it("falha REAL ao auditar: a expiração inteira é revertida (continua aceita, oportunidade intacta); depois a nova tentativa funciona sem duplicar", async () => {
    const a = await admin(); const p = await party();
    const { oppId, alloc } = await autoAssignment(p, a);
    await setDue(alloc.id, "now() - interval '1 minute'");
    await installAuditFailure("atribuicao.prazo_expirado");
    try {
      await expect(expireAssignmentDeadlines()).rejects.toThrow(/expireAssignmentDeadlines: 1 falha/);
      const row = (await allocs(oppId))[0];
      expect(row.status).toBe("aceita"); expect(row.closedReason).toBeNull(); expect(row.closedAt).toBeNull();
      expect(await oppStatus(oppId)).toBe("atribuida");
    } finally { await removeAuditFailure(); }
    await expireAssignmentDeadlines();
    expect((await allocs(oppId))[0].closedReason).toBe("prazo_expirado");
    expect(await auditCount("atribuicao.prazo_expirado", alloc.id)).toBe(1);
  });
});

describe("expiração × movimentação concorrente (travas seguradas no banco)", () => {
  for (const next of ["em_coleta", "em_transporte", "recebida"] as const) {
    it(`a organização muda a atribuição para '${next}' enquanto a expiração espera a trava: a expiração relê o estado confirmado e NÃO expira`, async () => {
      const a = await admin(); const p = await party();
      const { oppId, alloc } = await autoAssignment(p, a);
      await setDue(alloc.id, "now() - interval '1 minute'");
      let release!: () => void; const held = new Promise<void>((r) => { release = r; });
      let started!: () => void; const locked = new Promise<void>((r) => { started = r; });
      const moving = side.begin(async (tx) => {
        await tx`SELECT id FROM opportunity_allocations WHERE id = ${alloc.id} FOR UPDATE`;
        await tx.unsafe(`UPDATE opportunity_allocations SET status = '${next}' WHERE id = ${alloc.id}`);
        started(); await held;
      });
      await locked;
      const expiring = expireAssignmentDeadlines();
      expect(await waitBlocked(1)).toBeGreaterThanOrEqual(1);
      release(); await moving; await expiring;
      const row = (await allocs(oppId))[0];
      expect(row.status).toBe(next); expect(row.closedReason).toBeNull();
      expect(await auditCount("atribuicao.prazo_expirado")).toBe(0);
    });
  }

  it("logística REAL (agendar coleta) e recebimento REAL antes da expiração: a atribuição segue o fluxo e nunca expira depois", async () => {
    const a = await admin(); const p = await party();
    const { oppId, alloc } = await autoAssignment(p, a);
    const res = await logisticsHandle(buildRequest("allocations-logistics", { method: "POST", cookie: p.owner.cookie, body: { organizationId: p.org.id, allocationId: alloc.id, eventType: "coleta_agendada" } }));
    expect(res.status).toBe(200);
    await setDue(alloc.id, "now() - interval '1 hour'");
    await expireAssignmentDeadlines();
    expect((await allocs(oppId))[0].status).toBe("em_coleta");
    const item = await createTestInventoryItem(p.org.id, p.owner.userId, { name: "Cobertor", unit: "unidade" });
    const rcv = await receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: p.owner.cookie, body: { organizationId: p.org.id, allocationId: alloc.id, itemId: item.id, quantityReceived: 30 } }));
    expect(rcv.status).toBe(200);
    await expireAssignmentDeadlines();
    expect(await oppStatus(oppId)).toBe("concluida");
  });

  it("expiração simultânea com um novo matching da mesma oportunidade: nenhuma atribuição contraditória ou duplicada", async () => {
    const a = await admin(); const p = await party(); const q = await party();
    const { oppId, alloc } = await autoAssignment(p, a);
    await setDue(alloc.id, "now() - interval '1 minute'");
    await Promise.all([expireAssignmentDeadlines(), runMatchingForOpportunity(oppId, a.userId), runMatchingForOpportunity(oppId, null)]);
    await runMatchingForOpportunity(oppId, a.userId);
    const all = await allocs(oppId);
    const active = all.filter((x) => x.status !== "cancelada" && x.status !== "recusada");
    expect(active.length).toBeLessThanOrEqual(1);
    expect(new Set(active.map((x) => x.organizationId)).size).toBe(active.length);
    expect(active.every((x) => x.organizationId === q.org.id)).toBe(true); // só a outra organização pode ter ficado com ela
    expect(all.filter((x) => x.organizationId === p.org.id && x.closedReason !== "prazo_expirado")).toEqual([]); // a expirada não ganhou outra
  });
});

describe("pausa de 7 dias depois da expiração (não é recusa)", () => {
  it("a mesma organização não é escolhida de novo por 7 dias; outra organização compatível recebe; outra oportunidade segue elegível", async () => {
    const a = await admin(); const p = await party();
    const { oppId, alloc } = await autoAssignment(p, a);
    await setDue(alloc.id, "now() - interval '1 minute'");
    await expireAssignmentDeadlines();
    expect(await getRefusingOrganizationIds(db, oppId)).toEqual(new Set()); // não é recusa explícita (Fase 97)

    for (let i = 0; i < 3; i++) { await db.deleteFrom("backgroundTaskRuns").execute(); await runMatchingSweep(); } // varreduras seguidas: continua sem a organização em pausa
    expect((await allocs(oppId, p.org.id)).filter((x) => x.status === "aceita" || x.status === "proposta")).toEqual([]);
    expect(await oppStatus(oppId)).toBe("aguardando_destinacao"); // sem candidato elegível: espera coerente, sem loop de atribuição

    const exec = await db.selectFrom("auditLog").select("metadata").where("action", "=", "matching.executado").where("entityId", "=", String(oppId)).orderBy("id", "desc").limit(1).executeTakeFirstOrThrow();
    expect((exec.metadata as { organizacoesEmPausaPorExpiracao?: number[] }).organizacoesEmPausaPorExpiracao).toEqual([p.org.id]); // a situação fica registrada

    const q = await party(); // outra compatível aparece
    await runMatchingSweep();
    expect((await allocs(oppId, q.org.id)).filter((x) => x.status === "aceita")).toHaveLength(1);
    expect((await allocs(oppId, p.org.id)).filter((x) => x.status === "aceita")).toEqual([]);

    const other = await makeOpp(a, "Outra doação de cobertores de inverno");
    expect((await runMatchingForOpportunity(other, a.userId)).allocationsCreated.map((x) => x.organizationId)).toContain(p.org.id); // pausa é só deste par
  });

  it("depois dos 7 dias a organização volta a ser considerada; a recusa explícita da Fase 97 continua permanente", async () => {
    const a = await admin(); const p = await party();
    const { oppId, alloc } = await autoAssignment(p, a);
    await setDue(alloc.id, "now() - interval '1 minute'");
    await expireAssignmentDeadlines();
    expect((await runMatchingForOpportunity(oppId, a.userId)).allocationsCreated).toEqual([]); // dentro da pausa

    await sql`UPDATE opportunity_allocations SET closed_at = now() - interval '8 days' WHERE id = ${alloc.id}`.execute(db);
    const r = await runMatchingForOpportunity(oppId, a.userId);
    expect(r.allocationsCreated.map((x) => x.organizationId)).toEqual([p.org.id]); // pausa terminou: elegível de novo

    // recusa explícita (cancelamento pela organização via logística) continua barrando, qualquer que seja o tempo
    const mine = (await allocs(oppId, p.org.id)).find((x) => x.status === "aceita")!;
    const c = await logisticsHandle(buildRequest("allocations-logistics", { method: "POST", cookie: p.owner.cookie, body: { organizationId: p.org.id, allocationId: mine.id, eventType: "cancelado" } }));
    expect(c.status).toBe(200);
    await sql`UPDATE opportunity_allocations SET updated_at = now() - interval '400 days'`.execute(db);
    expect((await runMatchingForOpportunity(oppId, a.userId)).allocationsCreated).toEqual([]);
  });

  it("a atribuição MANUAL do admin continua possível durante a pausa (exceção administrativa consciente)", async () => {
    const a = await admin(); const p = await party();
    const { oppId, alloc } = await autoAssignment(p, a);
    await setDue(alloc.id, "now() - interval '1 minute'");
    await expireAssignmentDeadlines();
    const res = await manualAllocate(buildRequest("opportunity-allocations", { method: "POST", cookie: a.cookie, body: { opportunityId: oppId, organizationId: p.org.id, quantityAllocated: 10 } }));
    expect(res.status).toBe(200); // não exige confirmação: expiração não é recusa explícita
  });
});

describe("pendências da organização (fonte única: organization-allocations_GET)", () => {
  const list = (cookie: string, orgId: number) => orgAllocations(buildRequest(`organization-allocations?organizationId=${orgId}`, { cookie }));

  it("lista só as próprias pendências, com prazo e relógio do servidor; contador = registros reais; expirada sai das pendentes mas continua no histórico", async () => {
    const a = await admin(); const p = await party(); const q = await party("Arroz integral");
    const { oppId, alloc } = await autoAssignment(p, a);
    await autoAssignment(q, a, "Doação de arroz integral");
    const manualOpp = await makeOpp(a, "Manual");
    await manualAllocate(buildRequest("opportunity-allocations", { method: "POST", cookie: a.cookie, body: { opportunityId: manualOpp, organizationId: p.org.id, quantityAllocated: 5 } }));

    const mine = await parseJson<{ allocations: Array<{ id: number; pendingAction: boolean; responseDueAt: string | null; closedReason: string | null; status: string }>; pendingCount: number; serverNow: string }>(await list(p.owner.cookie, p.org.id));
    expect(mine.pendingCount).toBe(1); // a automática; a manual não é pendência
    expect(mine.allocations.filter((x) => x.pendingAction).map((x) => x.id)).toEqual([alloc.id]);
    expect(mine.allocations.every((x) => x.id !== undefined)).toBe(true);
    const due = new Date(mine.allocations.find((x) => x.id === alloc.id)!.responseDueAt!).getTime();
    expect(Math.abs(due - new Date(mine.serverNow).getTime() - 72 * 3_600_000)).toBeLessThan(60_000); // ~72 h depois do relógio do servidor
    expect(mine.allocations.some((x) => x.id !== alloc.id && x.pendingAction)).toBe(false);

    expect((await list(q.owner.cookie, p.org.id)).status).toBe(403); // sem acesso às pendências de outra organização
    const theirs = await parseJson<{ allocations: Array<{ id: number }>; pendingCount: number }>(await list(q.owner.cookie, q.org.id));
    expect(theirs.allocations.map((x) => x.id)).not.toContain(alloc.id);
    expect((await list("", p.org.id)).status).toBe(401);

    await setDue(alloc.id, "now() - interval '1 minute'");
    await expireAssignmentDeadlines();
    const after = await parseJson<{ allocations: Array<{ id: number; pendingAction: boolean; closedReason: string | null; status: string }>; pendingCount: number }>(await list(p.owner.cookie, p.org.id));
    expect(after.pendingCount).toBe(0);
    const row = after.allocations.find((x) => x.id === alloc.id)!;
    expect(row).toMatchObject({ pendingAction: false, status: "cancelada", closedReason: "prazo_expirado" }); // histórico preservado
    void oppId;
  });

  it("estado vazio: organização sem atribuições tem contador 0", async () => {
    const p = await party(false);
    const r = await parseJson<{ allocations: unknown[]; pendingCount: number; serverNow: string }>(await list(p.owner.cookie, p.org.id));
    expect(r.allocations).toEqual([]); expect(r.pendingCount).toBe(0); expect(typeof r.serverNow).toBe("string");
  });
});

describe("agendador", () => {
  it("a tarefa está registrada no agendador (scheduled-jobs.json), nos handlers e com trava própria", async () => {
    const jobs = JSON.parse(readFileSync("src/static/__dev/scheduled-jobs.json", "utf8")) as Record<string, { enabled: boolean; schedule: string }>;
    expect(jobs.expireAssignmentDeadlines).toMatchObject({ enabled: true });
    expect(Object.keys(jobs).sort()).toEqual(Object.keys(TASK_HANDLERS).sort());
    const src = readFileSync("src/helpers/scheduledTaskLock.tsx", "utf8");
    const ids = [...src.matchAll(/^\s+(\w+): (\d+),/gm)].map((m) => Number(m[2]));
    expect(new Set(ids).size).toBe(ids.length); // ids de trava únicos
  });
});
