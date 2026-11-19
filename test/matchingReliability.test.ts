/**
 * Fase 95 — confiabilidade do ciclo de matching, reservas e expiração. Cada teste usa o PostgreSQL de teste real e os caminhos reais (sweep agendado, tarefas de
 * expiração, endpoints de recebimento); as falhas são injetadas NO BANCO (gatilho que levanta exceção ao gravar a auditoria), não com mocks.
 * Defeitos reproduzidos na auditoria funcional: (1) o sweep avaliava sempre as 20 ofertas mais antigas; (2) cada sweep regravava a auditoria das mesmas ofertas;
 * (3) `expireReservations` cancelava, auditava e reabria em operações separadas; (4) `expireOpportunities` expirava oferta com atribuição aceita.
 */
import { describe, it, expect } from "vitest";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { runMatchingSweep } from "../src/helpers/runMatchingSweep";
import { withScheduledTaskLock } from "../src/helpers/scheduledTaskLock";
import { expireReservations } from "../src/helpers/expireReservations";
import { expireOpportunities } from "../src/helpers/expireOpportunities";
import { runMatchingForOpportunity } from "../src/helpers/opportunityMatching";
import { recoverStuckOpportunities } from "../src/helpers/recoverStuckOpportunities";
import { handle as receiveHandle } from "../src/endpoints/allocations-receive_POST";
import { createAuthenticatedUser, createTestOrganization, createTestSource, createTestOpportunityRegistry, createTestInventoryItem, buildRequest } from "./helpers";

type OppStatus = "aguardando_destinacao" | "reservada" | "atribuida" | "validada";

async function world() {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const admin = await createAuthenticatedUser();
  const source = await createTestSource(admin.userId);
  return { owner, org, admin, source };
}
async function makeNeed(orgId: number, userId: number, title = "Cobertores de inverno") {
  const [n] = await db.insertInto("needs").values({ organizationId: orgId, title, quantityNeeded: "30", unit: "unidade", priority: "critica", status: "aberta", createdByUserId: userId }).returning("id").execute();
  return n.id;
}
async function makeOpp(w: { admin: { userId: number }; source: { id: number } }, title: string, status: OppStatus = "aguardando_destinacao", extra: Record<string, unknown> = {}) {
  const o = await createTestOpportunityRegistry(w.source.id, w.admin.userId, { status: status === "atribuida" || status === "validada" ? "validada" : status });
  await db.updateTable("opportunityRegistry").set({ title, status, locationCity: "Belo Horizonte", locationState: "MG", quantity: "100", ...extra }).where("id", "=", o.id).execute();
  return o.id;
}
const oppStatus = async (id: number) => (await db.selectFrom("opportunityRegistry").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
const allocStatus = async (id: number) => (await db.selectFrom("opportunityAllocations").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
const auditCount = async (action: string, entityId?: number) => {
  let q = db.selectFrom("auditLog").select((eb) => eb.fn.countAll().as("n")).where("action", "=", action);
  if (entityId !== undefined) q = q.where("entityId", "=", String(entityId));
  return Number((await q.executeTakeFirstOrThrow()).n);
};
const evalCount = async () => Number((await db.selectFrom("matchEvaluations").select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow()).n);
const lastRun = async (taskName: string) => db.selectFrom("backgroundTaskRuns").selectAll().where("taskName", "=", taskName).orderBy("id", "desc").limit(1).executeTakeFirstOrThrow();
async function insertAlloc(oppId: number, orgId: number, status: string, extra: Record<string, unknown> = {}) {
  const [a] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: oppId, organizationId: orgId, status: status as never, quantityAllocated: "5", ...extra } as never).returning("id").execute();
  return a.id;
}
async function waitForBlockedQuery() {
  for (let i = 0; i < 200; i++) {
    const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db);
    if (r.rows[0].n > 0) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("nenhuma consulta ficou esperando uma trava");
}
/** Gatilho REAL no banco de teste: levanta exceção ao gravar na auditoria quando a condição (SQL sobre NEW) é verdadeira. Um comando por execução (prepared statement). */
async function installAuditFailure(condition: string) {
  await sql.raw(`CREATE OR REPLACE FUNCTION test_fail_audit() RETURNS trigger AS $f$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'falha injetada na gravação da auditoria'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`).execute(db);
  await sql.raw("CREATE TRIGGER test_fail_audit_trg BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_fail_audit()").execute(db);
}
async function removeAuditFailure() {
  await sql.raw("DROP TRIGGER IF EXISTS test_fail_audit_trg ON audit_log").execute(db);
  await sql.raw("DROP FUNCTION IF EXISTS test_fail_audit()").execute(db);
}

describe("sweep de matching: fila justa e auditoria sem crescimento", () => {
  it("25 ofertas sem correspondência + 1 compatível e mais nova: a compatível é avaliada e atribuída em, no máximo, um ciclo (ceil(26/20) = 2 execuções)", async () => {
    const w = await world();
    await makeNeed(w.org.id, w.owner.userId);
    for (let i = 0; i < 25; i++) await makeOpp(w, `Cadeira de rodas modelo ${i}`);
    const good = await makeOpp(w, "Doação de cobertores de inverno");

    await runMatchingSweep();
    expect((await lastRun("runMatchingSweep")).result).toMatchObject({ processadas: 20 });
    await runMatchingSweep();

    expect(await oppStatus(good)).toBe("atribuida");
    expect(await auditCount("matching.executado", good)).toBe(1);
    const allocs = await db.selectFrom("opportunityAllocations").select(["organizationId", "status"]).where("opportunityRegistryId", "=", good).execute();
    expect(allocs).toHaveLength(1);
  });

  it("a oferta nova compatível é avaliada já na execução SEGUINTE mesmo com 25 ofertas antigas já avaliadas (cota de nunca-avaliadas)", async () => {
    const w = await world();
    await makeNeed(w.org.id, w.owner.userId);
    for (let i = 0; i < 25; i++) await makeOpp(w, `Cadeira de rodas modelo ${i}`);
    await runMatchingSweep(); await runMatchingSweep(); // o ciclo completo das 25 antigas
    const good = await makeOpp(w, "Doação de cobertores de inverno");
    await runMatchingSweep();
    expect(await oppStatus(good)).toBe("atribuida");
  });

  it("o rodízio é persistido (cursor em background_task_runs) e percorre TODAS as elegíveis em ceil(N/20) execuções, mesmo com 45 sem correspondência", async () => {
    const w = await world();
    await makeNeed(w.org.id, w.owner.userId);
    const ids: number[] = [];
    for (let i = 0; i < 45; i++) ids.push(await makeOpp(w, `Cadeira de rodas modelo ${i}`));
    for (let i = 0; i < 3; i++) await runMatchingSweep();
    for (const id of ids) expect(await auditCount("matching.executado", id), `oportunidade ${id}`).toBe(1);
    const run = await lastRun("runMatchingSweep");
    expect((run.result as { cursor?: number }).cursor).toBeGreaterThan(0); // estado persistido, lido pela próxima execução
  });

  it("repetir o sweep sem mudança não grava auditoria nem avaliações novas; mudar a situação (nova necessidade) volta a avaliar e registrar", async () => {
    const w = await world();
    await makeNeed(w.org.id, w.owner.userId);
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) ids.push(await makeOpp(w, `Cadeira de rodas modelo ${i}`));
    await runMatchingSweep();
    const auditAfterFirst = await auditCount("matching.executado");
    const evalsAfterFirst = await evalCount();
    expect(auditAfterFirst).toBe(8);
    for (let i = 0; i < 6; i++) await runMatchingSweep();
    expect(await auditCount("matching.executado")).toBe(auditAfterFirst);
    expect(await evalCount()).toBe(evalsAfterFirst);
    expect((await lastRun("runMatchingSweep")).result).toMatchObject({ processadas: 8, semMudancaRelevante: 8 });

    // A situação mudou (uma necessidade que se parece com as ofertas): a próxima avaliação difere e é registrada de novo.
    await makeNeed(w.org.id, w.owner.userId, "Cadeira de rodas");
    for (let i = 0; i < 1; i++) await runMatchingSweep();
    expect(await auditCount("matching.executado")).toBeGreaterThan(auditAfterFirst);
  });

  it("execução de um USUÁRIO (matching manual) sempre registra, mesmo repetindo o resultado", async () => {
    const w = await world();
    await makeNeed(w.org.id, w.owner.userId);
    const id = await makeOpp(w, "Cadeira de rodas modelo X");
    await runMatchingForOpportunity(id, w.admin.userId);
    await runMatchingForOpportunity(id, w.admin.userId);
    expect(await auditCount("matching.executado", id)).toBe(2);
  });

  it("dois sweeps disparados juntos: nunca há atribuição duplicada, quer se sobreponham no tempo, quer rodem em sequência (invariante, não temporização)", async () => {
    const w = await world();
    await makeNeed(w.org.id, w.owner.userId);
    const opps: number[] = [];
    for (let i = 0; i < 4; i++) opps.push(await makeOpp(w, "Doação de cobertores de inverno"));
    await Promise.all([runMatchingSweep(), runMatchingSweep()]);
    // M41: se a segunda chamada só começa DEPOIS de a primeira terminar (carga da máquina), as duas execuções são legítimas e sequenciais; o que nunca pode acontecer é duplicar.
    // A exclusão mútua propriamente dita é provada de forma determinística no teste seguinte.
    const runs = await db.selectFrom("backgroundTaskRuns").select("id").where("taskName", "=", "runMatchingSweep").execute();
    expect(runs.length).toBeGreaterThanOrEqual(1); expect(runs.length).toBeLessThanOrEqual(2);
    for (const id of opps) {
      const a = await db.selectFrom("opportunityAllocations").select("id").where("opportunityRegistryId", "=", id).execute();
      expect(a.length, `oportunidade ${id}`).toBe(1);
    }
  });

  it("exclusão mútua do sweep (determinística): com o lock da tarefa já detido, o sweep NÃO executa e não registra execução; liberado o lock, executa uma única vez sem duplicar", async () => {
    const w = await world();
    await makeNeed(w.org.id, w.owner.userId);
    const opps: number[] = [];
    for (let i = 0; i < 4; i++) opps.push(await makeOpp(w, "Doação de cobertores de inverno"));
    const held = await withScheduledTaskLock("runMatchingSweep", async () => {
      await runMatchingSweep(); // outra execução tenta enquanto o lock está detido nesta conexão
      return (await db.selectFrom("backgroundTaskRuns").select("id").where("taskName", "=", "runMatchingSweep").execute()).length;
    });
    expect(held.ran).toBe(true); expect(held.result).toBe(0); // a segunda chamada encontrou a trava e não executou
    await runMatchingSweep();
    expect(await db.selectFrom("backgroundTaskRuns").select("id").where("taskName", "=", "runMatchingSweep").execute()).toHaveLength(1);
    for (const id of opps) expect((await db.selectFrom("opportunityAllocations").select("id").where("opportunityRegistryId", "=", id).execute()).length, `oportunidade ${id}`).toBe(1);
  });

  it("matching direto concorrente com o sweep para a mesma oferta não duplica a atribuição (trava da oportunidade + filtro de organizações já atribuídas)", async () => {
    const w = await world();
    await makeNeed(w.org.id, w.owner.userId);
    const id = await makeOpp(w, "Doação de cobertores de inverno");
    await Promise.all([runMatchingSweep(), runMatchingForOpportunity(id, w.admin.userId), runMatchingForOpportunity(id, null)]);
    expect((await db.selectFrom("opportunityAllocations").select("id").where("opportunityRegistryId", "=", id).execute()).length).toBe(1);
  });

  it("uma oportunidade que lança erro não trava a fila: as demais são avaliadas, a execução é registrada como falha e a fila segue na próxima", async () => {
    const w = await world();
    await makeNeed(w.org.id, w.owner.userId);
    const bad = await makeOpp(w, "Cadeira de rodas veneno");
    const good = await makeOpp(w, "Doação de cobertores de inverno");
    await installAuditFailure(`NEW.entity_id = '${bad}' AND NEW.action = 'matching.executado'`);
    try {
      await expect(runMatchingSweep()).rejects.toThrow(/runMatchingSweep: 1 oportunidade/);
      expect(await oppStatus(good)).toBe("atribuida"); // não ficou esperando atrás da oferta com erro
      const run = await lastRun("runMatchingSweep");
      expect(run.status).toBe("falhou");
      expect(typeof (run.error as { cursor?: unknown }).cursor).toBe("number"); // o cursor também é persistido na falha
      expect(JSON.stringify(run.error)).toContain(String(bad));
    } finally {
      await removeAuditFailure();
    }
  });
});

describe("expireReservations: atomicidade e recuperação", () => {
  async function expiredProposal() {
    const w = await world(); // a organização NÃO tem necessidade: o rematch depois da reabertura não propõe de novo
    const opp = await makeOpp(w, "Doação de agasalhos", "reservada");
    const allocId = await insertAlloc(opp, w.org.id, "proposta", { autoMatched: true, reservedUntil: new Date(Date.now() - 60_000) });
    return { ...w, opp, allocId };
  }

  it("reserva vencida: cancela, audita uma vez e reabre a oportunidade", async () => {
    const t = await expiredProposal();
    await expireReservations();
    expect(await allocStatus(t.allocId)).toBe("cancelada");
    expect(await oppStatus(t.opp)).toBe("aguardando_destinacao");
    expect(await auditCount("atribuicao.reserva_expirada", t.allocId)).toBe(1);
  });

  it("falha REAL na gravação da auditoria: nada é confirmado pela metade; sem o gatilho, a nova tentativa conclui sem duplicar", async () => {
    const t = await expiredProposal();
    await installAuditFailure("NEW.action = 'atribuicao.reserva_expirada'");
    try {
      await expect(expireReservations()).rejects.toThrow(/expireReservations: 1 oportunidade/);
      expect(await allocStatus(t.allocId)).toBe("proposta"); // o cancelamento foi revertido junto com a auditoria
      expect(await oppStatus(t.opp)).toBe("reservada");
      expect(await auditCount("atribuicao.reserva_expirada")).toBe(0);
      const failed = await lastRun("expireReservations");
      expect(failed.status).toBe("falhou");
      expect(JSON.stringify(failed.error)).toContain(String(t.opp));
    } finally {
      await removeAuditFailure();
    }
    await expireReservations(); // nova tentativa
    expect(await allocStatus(t.allocId)).toBe("cancelada");
    expect(await oppStatus(t.opp)).toBe("aguardando_destinacao");
    expect(await auditCount("atribuicao.reserva_expirada", t.allocId)).toBe(1);
    await expireReservations(); // e uma terceira não repete nada
    expect(await auditCount("atribuicao.reserva_expirada", t.allocId)).toBe(1);
  });

  it("a falha de uma oportunidade não impede as outras (cada uma é uma transação)", async () => {
    const a = await expiredProposal(); const b = await expiredProposal();
    await installAuditFailure(`NEW.action = 'atribuicao.reserva_expirada' AND NEW.entity_id = '${a.allocId}'`);
    try {
      await expect(expireReservations()).rejects.toThrow();
    } finally { await removeAuditFailure(); }
    expect(await allocStatus(a.allocId)).toBe("proposta");
    expect(await oppStatus(a.opp)).toBe("reservada");
    expect(await allocStatus(b.allocId)).toBe("cancelada");
    expect(await oppStatus(b.opp)).toBe("aguardando_destinacao");
  });

  it("decisão humana concorrente: a aceitação que já tinha a atribuição travada vence e a reserva NÃO é cancelada", async () => {
    const t = await expiredProposal();
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    let started!: () => void; const locked = new Promise<void>((r) => { started = r; });
    const human = db.transaction().execute(async (trx) => {
      await trx.selectFrom("opportunityAllocations").select("id").where("id", "=", t.allocId).forUpdate().execute();
      await trx.updateTable("opportunityAllocations").set({ status: "aceita", reservedUntil: null }).where("id", "=", t.allocId).execute();
      started(); await held;
    });
    await locked;
    const expiring = expireReservations();
    await waitForBlockedQuery(); // a expiração está esperando a trava da atribuição
    release(); await human; await expiring;
    expect(await allocStatus(t.allocId)).toBe("aceita");
    expect(await auditCount("atribuicao.reserva_expirada")).toBe(0);
    expect(await oppStatus(t.opp)).toBe("reservada"); // não reabriu: há atribuição ativa
  });

  it("duas execuções simultâneas de expireReservations: uma só cancela e audita", async () => {
    const t = await expiredProposal();
    await Promise.all([expireReservations(), expireReservations()]);
    expect(await auditCount("atribuicao.reserva_expirada", t.allocId)).toBe(1);
    expect(await allocStatus(t.allocId)).toBe("cancelada");
  });
});

describe("recuperação de oportunidades presas", () => {
  it("reservada/atribuida sem atribuição em andamento é reaberta (ou concluída se houve recebimento); com atribuição em andamento NÃO é tocada", async () => {
    const w = await world();
    const stuck = await makeOpp(w, "Presa", "reservada");
    await insertAlloc(stuck, w.org.id, "cancelada", { autoMatched: true });
    const stuckEmpty = await makeOpp(w, "Presa sem atribuições", "reservada");
    const received = await makeOpp(w, "Recebida e presa", "atribuida");
    await insertAlloc(received, w.org.id, "recebida");
    const alive = await makeOpp(w, "Com proposta ativa", "reservada");
    const aliveAlloc = await insertAlloc(alive, w.org.id, "proposta", { autoMatched: true, reservedUntil: new Date(Date.now() + 600_000) });
    const accepted = await makeOpp(w, "Com atribuição aceita", "atribuida");
    await insertAlloc(accepted, w.org.id, "aceita");

    const r = await recoverStuckOpportunities();
    expect(r.failed).toEqual([]);
    expect(await oppStatus(stuck)).toBe("aguardando_destinacao");
    expect(await oppStatus(stuckEmpty)).toBe("aguardando_destinacao");
    expect(await oppStatus(received)).toBe("concluida");
    expect(await oppStatus(alive)).toBe("reservada");
    expect(await allocStatus(aliveAlloc)).toBe("proposta");
    expect(await oppStatus(accepted)).toBe("atribuida");
    expect(await auditCount("descoberta_central.reaberta_automaticamente", stuck)).toBe(1);
    expect((await recoverStuckOpportunities()).reopened).toEqual([]); // repetir não faz nada nem duplica auditoria
    expect(await auditCount("descoberta_central.reaberta_automaticamente", stuck)).toBe(1);
  });

  it("o sweep recupera uma oportunidade que ficou presa e a reavalia (caso real do `expireReservations` antigo)", async () => {
    const w = await world();
    await makeNeed(w.org.id, w.owner.userId);
    const stuck = await makeOpp(w, "Doação de cobertores de inverno", "reservada");
    const other = await createAuthenticatedUser(); const otherOrg = await createTestOrganization(other.userId);
    await insertAlloc(stuck, otherOrg.id, "cancelada", { autoMatched: true }); // reservas já canceladas, oportunidade esquecida em `reservada`
    await runMatchingSweep();
    expect(["atribuida", "reservada"]).toContain(await oppStatus(stuck)); // reaberta e já reavaliada: ganhou atribuição nova
    const allocs = await db.selectFrom("opportunityAllocations").select(["organizationId", "status"]).where("opportunityRegistryId", "=", stuck).where("status", "in", ["aceita", "proposta"]).execute();
    expect(allocs).toHaveLength(1);
    expect(allocs[0].organizationId).toBe(w.org.id);
  });
});

describe("expireOpportunities: oferta com atribuição em andamento não expira", () => {
  const past = () => new Date(Date.now() - 3_600_000);

  it.each(["aceita", "em_coleta", "em_transporte"] as const)("atribuição %s protege a oferta; o recebimento depois conclui a oportunidade", async (status) => {
    const w = await world();
    const item = await createTestInventoryItem(w.org.id, w.owner.userId, { name: "Agasalho", unit: "unidade" });
    const opp = await makeOpp(w, "Doação de agasalhos", "atribuida", { expiresAt: past() });
    const allocId = await insertAlloc(opp, w.org.id, status, { autoMatched: true, quantityAllocated: "10" });

    await expireOpportunities();
    expect(await oppStatus(opp)).toBe("atribuida");
    expect(await auditCount("descoberta_central.expirada_automaticamente", opp)).toBe(0);
    expect((await lastRun("expireOpportunities")).result).toMatchObject({ expiradas: 0, protegidasPorAtribuicaoEmAndamento: 1 });

    const res = await receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: w.owner.cookie, body: { organizationId: w.org.id, allocationId: allocId, itemId: item.id, quantityReceived: 10 } }));
    expect(res.status).toBe(200);
    expect(await oppStatus(opp)).toBe("concluida");
  });

  it("sem atribuição em andamento a oferta vencida expira normalmente (e audita uma vez); comportamento de `reservada` com PROPOSTA ativa permanece como estava (decisão de produto pendente)", async () => {
    const w = await world();
    const plain = await makeOpp(w, "Sem atribuição", "aguardando_destinacao", { expiresAt: past() });
    const withProposal = await makeOpp(w, "Reservada com proposta", "reservada", { expiresAt: past() });
    await insertAlloc(withProposal, w.org.id, "proposta", { autoMatched: true, reservedUntil: new Date(Date.now() + 600_000) });
    const cancelledOnly = await makeOpp(w, "Só cancelada", "aguardando_destinacao", { expiresAt: past() });
    await insertAlloc(cancelledOnly, w.org.id, "cancelada");
    await expireOpportunities(); await expireOpportunities();
    expect(await oppStatus(plain)).toBe("expirada");
    expect(await oppStatus(cancelledOnly)).toBe("expirada");
    expect(await oppStatus(withProposal)).toBe("expirada"); // inalterado nesta etapa
    expect(await auditCount("descoberta_central.expirada_automaticamente", plain)).toBe(1);
  });

  it("aceitação concorrente: a atribuição travada por uma decisão em andamento é vista como aceita depois da trava e a oferta NÃO expira", async () => {
    const w = await world();
    const opp = await makeOpp(w, "Doação de agasalhos", "reservada", { expiresAt: past() });
    const allocId = await insertAlloc(opp, w.org.id, "proposta", { autoMatched: true, reservedUntil: new Date(Date.now() + 600_000) });
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    let started!: () => void; const locked = new Promise<void>((r) => { started = r; });
    const human = db.transaction().execute(async (trx) => {
      await trx.selectFrom("opportunityAllocations").select("id").where("id", "=", allocId).forUpdate().execute();
      await trx.updateTable("opportunityAllocations").set({ status: "aceita" }).where("id", "=", allocId).execute();
      await trx.updateTable("opportunityRegistry").set({ status: "atribuida" }).where("id", "=", opp).execute();
      started(); await held;
    });
    await locked;
    const expiring = expireOpportunities();
    await waitForBlockedQuery();
    release(); await human; await expiring;
    expect(await oppStatus(opp)).toBe("atribuida");
    expect(await allocStatus(allocId)).toBe("aceita");
  });

  it("falha real ao auditar: a expiração é revertida e a nova tentativa funciona sem duplicar", async () => {
    const w = await world();
    const opp = await makeOpp(w, "Sem atribuição", "aguardando_destinacao", { expiresAt: past() });
    await installAuditFailure("NEW.action = 'descoberta_central.expirada_automaticamente'");
    try {
      await expect(expireOpportunities()).rejects.toThrow(/expireOpportunities: 1 oportunidade/);
      expect(await oppStatus(opp)).toBe("aguardando_destinacao");
    } finally { await removeAuditFailure(); }
    await expireOpportunities();
    expect(await oppStatus(opp)).toBe("expirada");
    expect(await auditCount("descoberta_central.expirada_automaticamente", opp)).toBe(1);
  });

  it("duas execuções simultâneas não geram transições nem auditorias contraditórias", async () => {
    const w = await world();
    const opp = await makeOpp(w, "Sem atribuição", "aguardando_destinacao", { expiresAt: past() });
    await Promise.all([expireOpportunities(), expireOpportunities()]);
    expect(await oppStatus(opp)).toBe("expirada");
    expect(await auditCount("descoberta_central.expirada_automaticamente", opp)).toBe(1);
  });
});
