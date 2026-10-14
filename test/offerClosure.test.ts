/**
 * Fase 98 — oferta encerrada não deixa proposta aceitável. Reproduzido na auditoria funcional: o admin cancelava/expirava uma oportunidade 'reservada' com proposta
 * ativa e a organização ainda aceitava a proposta (200). Agora as propostas pendentes são encerradas NA MESMA transação (cancelada + motivo + auditoria, sem recusa
 * falsa) e o servidor valida a oferta ao aceitar. Concorrência determinística: travas seguradas numa conexão própria, soltas só quando as chamadas estão bloqueadas.
 */
import { describe, it, expect, afterAll } from "vitest";
import postgres from "postgres";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { expireOpportunities } from "../src/helpers/expireOpportunities";
import { recoverStuckOpportunities } from "../src/helpers/recoverStuckOpportunities";
import { getRefusingOrganizationIds } from "../src/helpers/allocationRefusals";
import { handle as statusHandle } from "../src/endpoints/opportunity-registry-status_POST";
import { handle as decideHandle } from "../src/endpoints/allocations-decide_POST";
import { createAuthenticatedUser, createPlatformAdmin, createTestOrganization, createTestSource, createTestOpportunityRegistry, buildRequest, parseJson } from "./helpers";

const side = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
afterAll(async () => { await side.end({ timeout: 5 }); });

async function scenario(oppStatus: "reservada" | "atribuida" = "reservada") {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const a = await createPlatformAdmin(); const source = await createTestSource(a.userId);
  const o = await createTestOpportunityRegistry(source.id, a.userId, { status: "reservada" });
  await db.updateTable("opportunityRegistry").set({ status: oppStatus }).where("id", "=", o.id).execute();
  const [al] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: o.id, organizationId: org.id, status: "proposta", quantityAllocated: "10", autoMatched: true, reservedUntil: sql`now() + interval '30 minutes'` }).returning("id").execute();
  return { owner, org, admin: a, oppId: o.id, allocId: al.id };
}
type S = Awaited<ReturnType<typeof scenario>>;
const setStatus = (s: S, status: string, cookie = s.admin.cookie) => statusHandle(buildRequest("opportunity-registry-status", { method: "POST", cookie, body: { opportunityId: s.oppId, status, reason: "teste" } }));
const decide = (s: S, decision: "aceita" | "recusada", cookie = s.owner.cookie) => decideHandle(buildRequest("allocations-decide", { method: "POST", cookie, body: { organizationId: s.org.id, allocationId: s.allocId, decision } }));
const alloc = async (id: number) => db.selectFrom("opportunityAllocations").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const oppStatus = async (id: number) => (await db.selectFrom("opportunityRegistry").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
const audits = (action: string, entityId: number) => db.selectFrom("auditLog").select(["actorUserId", "metadata", "organizationId"]).where("action", "=", action).where("entityId", "=", String(entityId)).execute();
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

describe("encerrar a oferta encerra as propostas pendentes (atômico, com motivo e ator)", () => {
  it("cancelamento administrativo: a proposta é encerrada com o motivo certo, auditada com o ator, NÃO vira recusa, e não pode mais ser aceita", async () => {
    const s = await scenario();
    const res = await setStatus(s, "cancelada");
    expect(res.status).toBe(200);
    expect((await parseJson<{ closedProposals: number }>(res)).closedProposals).toBe(1);
    expect(await oppStatus(s.oppId)).toBe("cancelada");
    const row = await alloc(s.allocId);
    expect(row.status).toBe("cancelada"); expect(row.closedReason).toBe("oferta_cancelada_admin"); expect(row.closedAt).not.toBeNull();
    const [a] = await audits("atribuicao.encerrada_com_oferta", s.allocId);
    expect(a.actorUserId).toBe(s.admin.userId); expect(a.organizationId).toBe(s.org.id);
    expect(a.metadata).toMatchObject({ motivo: "oferta_cancelada_admin", origem: "administrador", naoERecusaDaOrganizacao: true });
    expect(await getRefusingOrganizationIds(db, s.oppId)).toEqual(new Set()); // não é recusa explícita (Fase 97)
    expect((await decide(s, "aceita")).status).toBe(409); // proposta encerrada: não pode ser aceita
    expect((await alloc(s.allocId)).status).toBe("cancelada");
  });

  it("expiração administrativa: motivo próprio", async () => {
    const s = await scenario();
    expect((await setStatus(s, "expirada")).status).toBe(200);
    expect((await alloc(s.allocId)).closedReason).toBe("oferta_expirada_admin");
    expect((await audits("atribuicao.encerrada_com_oferta", s.allocId))[0].metadata).toMatchObject({ motivo: "oferta_expirada_admin" });
  });

  it("expiração AUTOMÁTICA da oferta (tarefa agendada): propostas encerradas sem ator, motivo distinto do administrativo", async () => {
    const s = await scenario();
    await db.updateTable("opportunityRegistry").set({ expiresAt: sql`now() - interval '1 hour'` }).where("id", "=", s.oppId).execute();
    await expireOpportunities();
    expect(await oppStatus(s.oppId)).toBe("expirada");
    const row = await alloc(s.allocId);
    expect(row.status).toBe("cancelada"); expect(row.closedReason).toBe("oferta_expirada_automatica");
    const [a] = await audits("atribuicao.encerrada_com_oferta", s.allocId);
    expect(a.actorUserId).toBeNull(); expect(a.metadata).toMatchObject({ origem: "sistema", motivo: "oferta_expirada_automatica" });
    expect((await decide(s, "aceita")).status).toBe(409);
    await expireOpportunities(); // idempotente
    expect((await audits("atribuicao.encerrada_com_oferta", s.allocId))).toHaveLength(1);
  });

  it("atribuição EM ANDAMENTO protege a oferta: o admin não consegue cancelá-la (409) e nada muda; a expiração automática continua não expirando (Fase 95)", async () => {
    const s = await scenario("atribuida");
    await db.updateTable("opportunityAllocations").set({ status: "em_coleta" }).where("id", "=", s.allocId).execute();
    const [p] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: s.oppId, organizationId: s.org.id, status: "proposta", quantityAllocated: "5" }).returning("id").execute();
    await db.updateTable("opportunityRegistry").set({ status: "reservada" }).where("id", "=", s.oppId).execute(); // estado artificial: reservada + atribuição em andamento
    expect((await setStatus(s, "cancelada")).status).toBe(409);
    expect(await oppStatus(s.oppId)).toBe("reservada");
    expect((await alloc(p.id)).status).toBe("proposta");
    await db.updateTable("opportunityRegistry").set({ expiresAt: sql`now() - interval '1 hour'` }).where("id", "=", s.oppId).execute();
    await expireOpportunities();
    expect(await oppStatus(s.oppId)).toBe("reservada");
    expect((await alloc(p.id)).status).toBe("proposta");
  });

  it("permissões: dono de organização não encerra a oferta (403) e nada muda", async () => {
    const s = await scenario();
    expect((await setStatus(s, "cancelada", s.owner.cookie)).status).toBe(403);
    expect(await oppStatus(s.oppId)).toBe("reservada");
    expect((await alloc(s.allocId)).status).toBe("proposta");
  });

  it("falha REAL ao auditar o encerramento: a oferta e a proposta voltam ao estado anterior; a nova tentativa funciona uma vez", async () => {
    const s = await scenario();
    await installAuditFailure("atribuicao.encerrada_com_oferta");
    try {
      expect((await setStatus(s, "cancelada")).status).toBe(500);
      expect(await oppStatus(s.oppId)).toBe("reservada");
      expect((await alloc(s.allocId)).status).toBe("proposta");
    } finally { await removeAuditFailure(); }
    expect((await setStatus(s, "cancelada")).status).toBe(200);
    expect((await audits("atribuicao.encerrada_com_oferta", s.allocId))).toHaveLength(1);
  });
});

describe("aceitação × encerramento da oferta (a ordem efetiva das transações decide, sem estado contraditório)", () => {
  it("o encerramento obtém as travas primeiro: a aceitação espera, lê a proposta encerrada e recebe 409; oferta e proposta ficam canceladas", async () => {
    const s = await scenario();
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    let started!: () => void; const locked = new Promise<void>((r) => { started = r; });
    const holder = side.begin(async (tx) => { await tx`SELECT id FROM opportunity_registry WHERE id = ${s.oppId} FOR UPDATE`; started(); await held; });
    await locked;
    const closing = setStatus(s, "cancelada"); // trava a atribuição e espera a oportunidade
    expect(await waitBlocked(1)).toBeGreaterThanOrEqual(1);
    const accepting = decide(s, "aceita"); // espera a trava da atribuição
    expect(await waitBlocked(2)).toBeGreaterThanOrEqual(2);
    release(); await holder;
    const [c, d] = await Promise.all([closing, accepting]);
    expect(c.status).toBe(200); expect(d.status).toBe(409);
    expect(await oppStatus(s.oppId)).toBe("cancelada");
    expect((await alloc(s.allocId)).status).toBe("cancelada");
  });

  it("a aceitação obtém as travas primeiro: a proposta é aceita, a oferta vira 'atribuida' e o encerramento seguinte é recusado (409); estado final coerente", async () => {
    const s = await scenario();
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    let started!: () => void; const locked = new Promise<void>((r) => { started = r; });
    const holder = side.begin(async (tx) => { await tx`SELECT id FROM opportunity_registry WHERE id = ${s.oppId} FOR UPDATE`; started(); await held; });
    await locked;
    const accepting = decide(s, "aceita"); // trava a atribuição e espera a oportunidade
    expect(await waitBlocked(1)).toBeGreaterThanOrEqual(1);
    const closing = setStatus(s, "cancelada"); // espera a trava da atribuição
    expect(await waitBlocked(2)).toBeGreaterThanOrEqual(2);
    release(); await holder;
    const [d, c] = await Promise.all([accepting, closing]);
    expect(d.status).toBe(200); expect(c.status).toBe(409);
    expect(await oppStatus(s.oppId)).toBe("atribuida");
    expect((await alloc(s.allocId)).status).toBe("aceita");
  });

  it("recusar continua permitido numa proposta antiga de oferta já encerrada (não prende a organização)", async () => {
    const s = await scenario();
    await db.updateTable("opportunityRegistry").set({ status: "cancelada" }).where("id", "=", s.oppId).execute(); // resíduo antigo: oferta encerrada, proposta ainda pendente
    expect((await decide(s, "aceita")).status).toBe(409);
    expect((await decide(s, "recusada")).status).toBe(200);
  });
});

describe("resíduos antigos: propostas pendentes de ofertas já encerradas", () => {
  it("a recuperação encerra o resíduo com motivo neutro ('oferta_encerrada'), sem afirmar a origem, uma vez só, sem tocar oferta com atribuição em andamento", async () => {
    const s = await scenario();
    await db.updateTable("opportunityRegistry").set({ status: "expirada" }).where("id", "=", s.oppId).execute();
    const live = await scenario("atribuida"); // oferta viva com proposta: não é resíduo
    const r = await recoverStuckOpportunities();
    expect(r.failed).toEqual([]);
    expect(r.closedOrphanProposals).toEqual([s.allocId]);
    expect((await alloc(s.allocId)).closedReason).toBe("oferta_encerrada");
    expect((await alloc(live.allocId)).status).toBe("proposta");
    expect((await recoverStuckOpportunities()).closedOrphanProposals).toEqual([]);
    expect((await audits("atribuicao.encerrada_com_oferta", s.allocId))).toHaveLength(1);
  });
});
