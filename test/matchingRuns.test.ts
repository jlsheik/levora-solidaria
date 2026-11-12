/**
 * M42 — HISTÓRICO DE EXECUÇÕES DO MATCHING com os serviços REAIS e PostgreSQL descartável (nenhum mock): execução sem candidatos, com correspondência, não executada, atribuição manual, falha técnica
 * injetada NO BANCO (gatilho), exclusão mútua e repetição, isolamento entre organizações, auditoria (resultado explícito + correlação própria), a leitura da plataforma e a busca sem acentos.
 * Tudo sintético; nada representa entrega física.
 */
import { describe, it, expect, afterEach } from "vitest";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { runMatchingForOpportunity, safeMatchErrorCode } from "../src/helpers/opportunityMatching";
import { runMatchingSweep } from "../src/helpers/runMatchingSweep";
import { withScheduledTaskLock } from "../src/helpers/scheduledTaskLock";
import { foldText } from "../src/helpers/journeyOffers";
import { handle as postNeed } from "../src/endpoints/needs_POST";
import { handle as postOpportunity } from "../src/endpoints/opportunities_POST";
import { handle as postRegistryMatch } from "../src/endpoints/opportunity-registry-match_POST";
import { handle as postAllocation } from "../src/endpoints/opportunity-allocations_POST";
import { handle as getJourneys } from "../src/endpoints/journeys_GET";
import { handle as getJourney } from "../src/endpoints/journey_GET";
import { handle as getMatchingRuns } from "../src/endpoints/matching-runs_GET";
import { handle as getAuditList } from "../src/endpoints/audit-center_GET";
import { addMembership, buildRequest, createAuthenticatedUser, createPlatformAdmin, createTestInventoryItem, createTestOpportunityRegistry, createTestOrganization, createTestSource, parseJson, type AuthenticatedTestUser } from "./helpers";

const get = (p: string, a?: AuthenticatedTestUser) => buildRequest(p, { cookie: a?.cookie });
const post = (p: string, a: AuthenticatedTestUser | undefined, body: unknown) => buildRequest(p, { method: "POST", cookie: a?.cookie, body });
const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));

type Step = { key: string; state: string; detail: string };
type MRun = { id: string; origin: string; originLabel: string; outcome: string; repeatCount: number; finishedAt: string | null };
type Detail = { steps: Step[]; next: string | null; matching: { state: string; runs: MRun[]; note: string } | null; evaluations: Array<{ decision: string; opportunity: { title: string } | null; criteria: Array<{ detail: string | null }>; allocationId: number | null }> | null; timeline: Array<{ title: string; kind: string }> };
type RunRow = { id: string; status: string; origin: string; candidatesConsidered: number | null; candidatesRelated: number | null; validMatches: number | null; errorCode: string | null; correlationId: string; repeatCount: number; signature: string | null; finishedAt: Date | null };

async function world() {
  const owner = await createAuthenticatedUser(); const org = await createTestOrganization(owner.userId);
  const admin = await createAuthenticatedUser(); await addMembership(org.id, admin.userId, "administrador");
  const platform = await createPlatformAdmin(); const source = await createTestSource(platform.userId);
  const item = await createTestInventoryItem(org.id, owner.userId, { name: "Cobertores", unit: "unidade" });
  const otherOwner = await createAuthenticatedUser(); const otherOrg = await createTestOrganization(otherOwner.userId);
  await wait();
  return { owner, admin, platform, source, item, org, otherOwner, otherOrg };
}
type W = Awaited<ReturnType<typeof world>>;
const newNeed = async (w: W, over: Record<string, unknown> = {}, who: AuthenticatedTestUser = w.owner, org = w.org.id) => {
  const res = await postNeed(post("needs", who, { organizationId: org, title: "Cobertores de inverno", quantityNeeded: 30, unit: "unidade", priority: "critica", ...over }));
  expect(res.status, await res.clone().text()).toBe(200);
  return db.selectFrom("needs").selectAll().where("organizationId", "=", org).orderBy("id", "desc").executeTakeFirstOrThrow();
};
const newOffer = async (w: W, over: { title?: string; quantity?: string } = {}) => {
  const o = await createTestOpportunityRegistry(w.source.id, w.platform.userId, { status: "aguardando_destinacao", title: over.title ?? "Doação de cobertores de inverno" });
  await db.updateTable("opportunityRegistry").set({ quantity: over.quantity ?? "100", unit: "unidade", category: "cobertores", locationCity: "Belo Horizonte", locationState: "MG" }).where("id", "=", o.id).execute();
  return o.id;
};
const runsOf = async (offerId: number) => (await db.selectFrom("matchingRuns").selectAll().where("opportunityRegistryId", "=", offerId).orderBy("id", "asc").execute()) as unknown as RunRow[];
const detail = async (w: W, needId: number, who: AuthenticatedTestUser = w.owner, org = w.org.id) => parseJson<Detail>(await getJourney(get(`journey?organizationId=${org}&needId=${needId}`, who)));
const stepOf = (d: { steps: Step[] }, k: string) => d.steps.find((s) => s.key === k)!;
const auditFor = async (offerId: number, action?: string) => db.selectFrom("auditLog").select(["id", "action", "outcome", "correlationId", "metadata", "organizationId"]).where("entityType", "=", "opportunity_registry").where("entityId", "=", String(offerId)).$if(!!action, (q) => q.where("action", "=", action!)).orderBy("id", "asc").execute();

afterEach(async () => { await sql`DROP TRIGGER IF EXISTS m42_fail_eval ON match_evaluations`.execute(db); await sql`DROP FUNCTION IF EXISTS m42_fail_eval_fn()`.execute(db); });

describe("jornada A — matching SEM candidatos relacionados é registrado (não é falha, não é 'não executado')", () => {
  it("necessidade sem relação com a oferta: a execução fica registrada como concluída SEM correspondência, a necessidade aparece como 'considerada, sem relação' e a oferta NÃO é identificada à organização", async () => {
    const w = await world(); const need = await newNeed(w, { title: "Cadeira de rodas", unit: "unidade" }); const offer = await newOffer(w, { title: "Doação de cobertores de inverno" });
    const before = await detail(w, need.id);
    expect(before.matching!.state).toBe("nao_executado"); expect(stepOf(before, "correspondencia").state).toBe("pendente"); expect(before.matching!.runs).toEqual([]); // jornada C: não executado ≠ concluído
    const r = await runMatchingForOpportunity(offer, w.platform.userId, "manual");
    expect(r.skipped).toBe(false); expect(r.allocationsCreated).toEqual([]);
    const runs = await runsOf(offer); expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "concluida_sem_correspondencia", origin: "manual", validMatches: 0, candidatesRelated: 0, errorCode: null }); expect(runs[0].candidatesConsidered).toBeGreaterThanOrEqual(1); expect(runs[0].finishedAt).not.toBeNull();
    const rn = await db.selectFrom("matchingRunNeeds").selectAll().where("needId", "=", need.id).execute(); expect(rn).toHaveLength(1); expect(rn[0]).toMatchObject({ relation: "sem_relacao", organizationId: w.org.id }); expect(String(rn[0].runId)).toBe(runs[0].id);
    expect(await db.selectFrom("matchEvaluations").select("id").where("opportunityRegistryId", "=", offer).execute()).toHaveLength(0); // sem pontuação inventada
    const d = await detail(w, need.id);
    expect(d.matching!.state).toBe("executado_sem_correspondencia"); expect(d.matching!.runs).toHaveLength(1); expect(d.matching!.runs[0]).toMatchObject({ outcome: "sem_relacao", origin: "manual", originLabel: "execução manual da administração" });
    const c = stepOf(d, "correspondencia"); expect(c.state).toBe("executado_sem_resultado"); expect(c.detail).toMatch(/Matching executado em 1 execução/); expect(c.detail).toMatch(/Isto não é uma falha/); expect(c.detail).toMatch(/sem nenhuma oferta relacionada/);
    expect(d.next).toMatch(/foi executado e não encontrou correspondência válida/);
    expect(JSON.stringify(d)).not.toContain("Doação de cobertores de inverno"); // a oferta pertence ao Registro Central
    expect(d.timeline.some((t) => t.title.startsWith("Matching executado") && /nenhuma oferta relacionada/.test(t.title))).toBe(true);
    const list = (await parseJson<{ items: Array<{ needId?: number; steps: Step[] }> }>(await getJourneys(get(`journeys?organizationId=${w.org.id}&tipo=necessidade`, w.owner)))).items.find((e) => e.needId === need.id)!;
    expect(stepOf(list, "correspondencia").state).toBe("executado_sem_resultado");
  });

  it("sem NENHUMA necessidade candidata: a execução também é registrada (zero considerada é um valor calculado, não ausência)", async () => {
    const w = await world(); const offer = await newOffer(w);
    await runMatchingForOpportunity(offer, w.platform.userId, "manual");
    const runs = await runsOf(offer); expect(runs).toHaveLength(1); expect(runs[0]).toMatchObject({ status: "concluida_sem_correspondencia", candidatesConsidered: 0, candidatesRelated: 0, validMatches: 0 });
    expect(await db.selectFrom("matchingRunNeeds").select("needId").where("runId", "=", runs[0].id).execute()).toHaveLength(0);
  });

  it("tentativa IGNORADA (oferta inelegível, inexistente ou toda atribuída) não avaliou nada e não deixa execução registrada", async () => {
    const w = await world(); const o = await createTestOpportunityRegistry(w.source.id, w.platform.userId, { status: "validada" }); // 'validada' não é elegível ao matching
    expect((await runMatchingForOpportunity(o.id, w.platform.userId, "manual")).skipped).toBe(true); expect((await runMatchingForOpportunity(99999999, w.platform.userId, "manual")).skipped).toBe(true);
    expect(await db.selectFrom("matchingRuns").select("id").execute()).toHaveLength(0);
  });
});

describe("jornada B — matching COM correspondência: origem, avaliação ligada à execução e rastreabilidade", () => {
  it("execução com correspondência: contagens calculadas, avaliação ligada ao run, auditoria com a MESMA correlação e resultado explícito; a jornada mostra a correspondência", async () => {
    const w = await world(); const need = await newNeed(w); const offer = await newOffer(w);
    const res = await postRegistryMatch(post("opportunity-registry-match", w.platform, { opportunityId: offer })); expect(res.status).toBe(200);
    const runs = await runsOf(offer); expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "concluida_com_correspondencia", origin: "manual" }); expect(runs[0].validMatches).toBeGreaterThanOrEqual(1); expect(runs[0].candidatesRelated).toBeGreaterThanOrEqual(1);
    const ev = await db.selectFrom("matchEvaluations").select(["id", "matchingRunId", "needId", "allocationId", "decision"]).where("opportunityRegistryId", "=", offer).execute();
    expect(ev).toHaveLength(1); expect(String(ev[0].matchingRunId)).toBe(runs[0].id); expect(ev[0].allocationId).not.toBeNull();
    expect((await db.selectFrom("matchingRunNeeds").select("relation").where("runId", "=", runs[0].id).where("needId", "=", need.id).executeTakeFirstOrThrow()).relation).toBe("avaliada");
    const exec = (await auditFor(offer, "matching.executado")); expect(exec).toHaveLength(1);
    expect(exec[0]).toMatchObject({ outcome: "concluida", correlationId: runs[0].correlationId, organizationId: null }); expect(exec[0].metadata).toMatchObject({ execucaoId: runs[0].id, origem: "manual", resultado: "com_correspondencia", algoritmo: "1.4" });
    const d = await detail(w, need.id);
    expect(d.matching!.state).toBe("executado_com_correspondencia"); expect(d.matching!.runs[0].outcome).toBe("com_correspondencia"); expect(stepOf(d, "correspondencia").state).toBe("concluida");
    expect(d.evaluations![0].opportunity!.title).toBe("Doação de cobertores de inverno"); expect(d.evaluations![0].allocationId).not.toBeNull(); // oferta atribuída a ESTA organização: identificada
  });

  it("avaliação DESCARTADA (abaixo do limiar) e oferta NÃO atribuída: a organização vê que houve avaliação e a decisão, mas não o título, a categoria, a quantidade nem o texto dos critérios", async () => {
    const w = await world(); const need = await newNeed(w, { title: "Cobertores de inverno", quantityNeeded: 5000, priority: "baixa" }); const offer = await newOffer(w, { title: "Cobertores raros do doador reservado", quantity: "1" });
    await db.updateTable("opportunityRegistry").set({ locationCity: "Manaus", locationState: "AM" }).where("id", "=", offer).execute();
    await runMatchingForOpportunity(offer, w.platform.userId, "manual");
    const evs = await db.selectFrom("matchEvaluations").select(["decision", "matchingRunId", "allocationId"]).where("needId", "=", need.id).execute();
    expect(evs).toHaveLength(1); expect(evs[0].decision).toBe("descartado"); expect(evs[0].allocationId).toBeNull(); // cenário construído para ficar abaixo do limiar de proposta (70)
    const run = (await runsOf(offer))[0]; expect(String(evs[0].matchingRunId)).toBe(run.id); expect(run).toMatchObject({ status: "concluida_sem_correspondencia", candidatesRelated: 1, validMatches: 0 });
    expect((await db.selectFrom("matchingRunNeeds").select("relation").where("needId", "=", need.id).executeTakeFirstOrThrow()).relation).toBe("avaliada");
    const d = await detail(w, need.id);
    expect(d.evaluations!).toHaveLength(1); const e = d.evaluations![0]; expect(e.allocationId).toBeNull(); expect(e.opportunity).toBeNull(); expect(e.criteria.length).toBeGreaterThan(0); expect(e.criteria.every((c) => c.detail === null)).toBe(true);
    const body = JSON.stringify(d); expect(body).not.toContain("Cobertores raros"); expect(body).not.toContain("Manaus"); expect(body).not.toContain("oferecido 1");
    expect(d.matching!.state).toBe("executado_sem_correspondencia"); expect(d.matching!.runs[0].outcome).toBe("avaliada_descartada");
    const c = stepOf(d, "correspondencia"); expect(c.state).toBe("executado_sem_resultado"); expect(c.detail).toMatch(/1 avaliação\(ões\) abaixo do limiar de proposta/);
    expect(d.timeline.some((t) => t.kind === "correspondencia" && /uma oferta da rede não atribuída a esta organização: descartada/.test(t.title))).toBe(true);
  });
});

describe("jornada D — atribuição manual não é matching", () => {
  it("atribuição manual com necessidade: nenhuma execução registrada, estado 'atribuição manual (matching não executado)'", async () => {
    const w = await world(); const need = await newNeed(w, { itemId: w.item.id }); const offer = await newOffer(w);
    await db.updateTable("opportunityRegistry").set({ status: "validada" }).where("id", "=", offer).execute();
    const res = await postAllocation(post("opportunity-allocations", w.platform, { opportunityId: offer, organizationId: w.org.id, quantityAllocated: 30, needId: need.id })); expect(res.status, await res.clone().text()).toBe(200);
    const d = await detail(w, need.id);
    expect(d.matching!.state).toBe("atribuicao_manual"); expect(d.matching!.runs).toEqual([]); expect(stepOf(d, "correspondencia").state).toBe("nao_se_aplica");
    expect(await db.selectFrom("matchingRuns").select("id").execute()).toHaveLength(0); expect(d.evaluations).toEqual([]);
  });
});

describe("jornada E — falha técnica: estado de erro, nada confirmado, nenhum sucesso falso", () => {
  const installFailure = async () => { await sql`CREATE FUNCTION m42_fail_eval_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha injetada no matching (teste)'; END $$`.execute(db); await sql`CREATE TRIGGER m42_fail_eval BEFORE INSERT ON match_evaluations FOR EACH ROW EXECUTE FUNCTION m42_fail_eval_fn()`.execute(db); };
  it("falha ao gravar a avaliação: a transação é revertida, a execução fica 'falhou' com código seguro, a auditoria diz 'falhou', e a necessidade NÃO aparece como avaliada; a repetição depois da falha conclui sem duplicar", async () => {
    const w = await world(); const need = await newNeed(w); const offer = await newOffer(w);
    await installFailure();
    await expect(runMatchingForOpportunity(offer, w.platform.userId, "manual")).rejects.toThrow(/falha injetada/);
    expect(await db.selectFrom("opportunityAllocations").select("id").where("opportunityRegistryId", "=", offer).execute()).toHaveLength(0); // nada parcialmente confirmado
    expect(await db.selectFrom("matchEvaluations").select("id").execute()).toHaveLength(0); expect(await db.selectFrom("matchingRunNeeds").select("runId").execute()).toHaveLength(0);
    const runs = await runsOf(offer); expect(runs).toHaveLength(1); expect(runs[0]).toMatchObject({ status: "falhou", errorCode: "pg_p0001", validMatches: null, candidatesConsidered: null, origin: "manual" }); expect(runs[0].finishedAt).not.toBeNull();
    expect(JSON.stringify(runs[0])).not.toMatch(/injetada/); // a mensagem do erro não é gravada
    expect(await auditFor(offer, "matching.executado")).toHaveLength(0); // nenhum sucesso falso
    const fail = await auditFor(offer, "matching.falhou"); expect(fail).toHaveLength(1); expect(fail[0]).toMatchObject({ outcome: "falhou", correlationId: runs[0].correlationId }); expect(fail[0].metadata).toMatchObject({ codigoDeErro: "pg_p0001", origem: "manual" });
    const d = await detail(w, need.id); expect(d.matching!.state).toBe("nao_executado"); expect(d.matching!.runs).toEqual([]); expect(stepOf(d, "correspondencia").state).toBe("pendente"); // a falha não é atribuída à necessidade
    const unauth = await getMatchingRuns(get(`matching-runs?opportunityId=${offer}`, w.owner)); expect(unauth.status).toBe(403);
    const seen = await parseJson<{ runs: Array<{ status: string; errorCode: string | null; candidatesConsidered: number | null; validMatches: number | null }> }>(await getMatchingRuns(get(`matching-runs?opportunityId=${offer}`, w.platform)));
    expect(seen.runs[0]).toMatchObject({ status: "falhou", errorCode: "pg_p0001", candidatesConsidered: null, validMatches: null }); // não calculado ≠ zero
    // a falha não conta como "avaliada": a varredura volta a pegar a oferta; removida a falha, a repetição conclui
    await sql`DROP TRIGGER m42_fail_eval ON match_evaluations`.execute(db);
    await runMatchingSweep();
    const after = await runsOf(offer); expect(after.map((x) => x.status)).toEqual(["falhou", "concluida_com_correspondencia"]);
    expect(await db.selectFrom("opportunityAllocations").select("id").where("opportunityRegistryId", "=", offer).execute()).toHaveLength(1);
    expect((await detail(w, need.id)).matching!.state).toBe("executado_com_correspondencia");
  });
  it("código de erro seguro: só SQLSTATE ou genérico", () => {
    expect(safeMatchErrorCode({ code: "40P01" })).toBe("pg_40p01"); expect(safeMatchErrorCode(new Error("senha=secreta"))).toBe("erro_interno"); expect(safeMatchErrorCode({ code: "texto livre" })).toBe("erro_interno"); expect(safeMatchErrorCode(null)).toBe("erro_interno");
  });
});

describe("jornadas F/G — exclusão mútua, repetição e idempotência (invariantes; sem temporização)", () => {
  it("o matching direto SEGURA a trava da oferta: com a linha da oferta travada por outra transação a execução espera e só depois conclui, uma única vez, sem atribuição duplicada", async () => {
    const w = await world(); await newNeed(w); const offer = await newOffer(w);
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let lockedResolve!: () => void; const locked = new Promise<void>((r) => { lockedResolve = r; });
    const holder = db.transaction().execute(async (trx) => { await trx.selectFrom("opportunityRegistry").select("id").where("id", "=", offer).forUpdate().execute(); lockedResolve(); await gate; });
    await locked;
    let done = false; const run = runMatchingForOpportunity(offer, w.platform.userId, "manual").then((x) => { done = true; return x; });
    // determinístico: espera a execução aparecer BLOQUEADA no banco e confere QUAL comando está esperando. Com a trava de leitura (SELECT … FOR UPDATE) é o primeiro comando da execução; sem ela a execução
    // avançaria e só pararia mais adiante num UPDATE — o que o teste anterior (só "ainda não terminou") não distinguia (achado do teste de mutação).
    let blocked = ""; for (let i = 0; i < 200 && !blocked; i++) { const r = await sql<{ query: string }>`SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active' AND pid <> pg_backend_pid()`.execute(db); blocked = r.rows[0]?.query ?? ""; if (!blocked) await wait(25); }
    expect(blocked).toMatch(/opportunity_registry/i); expect(blocked).toMatch(/for update/i); expect(blocked).toMatch(/^\s*select/i); expect(done).toBe(false);
    expect(await db.selectFrom("matchingRuns").select("id").execute()).toHaveLength(0);
    release(); await holder; const result = await run;
    expect(result.skipped).toBe(false); expect(await runsOf(offer)).toHaveLength(1); expect(await db.selectFrom("opportunityAllocations").select("id").where("opportunityRegistryId", "=", offer).execute()).toHaveLength(1);
  });

  it("duas execuções manuais simultâneas da mesma oferta: nunca há atribuição duplicada para a mesma organização e toda execução registrada está em estado válido", async () => {
    const w = await world(); await newNeed(w); const offer = await newOffer(w);
    const [a, b] = await Promise.all([runMatchingForOpportunity(offer, w.platform.userId, "manual"), runMatchingForOpportunity(offer, w.platform.userId, "manual")]);
    expect(a.skipped && b.skipped).toBe(false); // uma delas pode encontrar a oferta já atribuída (inelegível) e ser ignorada: isso é correto
    expect(await db.selectFrom("opportunityAllocations").select("id").where("opportunityRegistryId", "=", offer).where("organizationId", "=", w.org.id).execute()).toHaveLength(1);
    const runs = await runsOf(offer); expect(runs.length).toBeGreaterThanOrEqual(1); expect(runs.length).toBeLessThanOrEqual(2); expect(runs.every((r) => ["concluida_com_correspondencia", "concluida_sem_correspondencia"].includes(r.status))).toBe(true);
    expect(runs.filter((r) => r.status === "concluida_com_correspondencia")).toHaveLength(1); // a segunda execução já encontrou a organização atribuída: não repete a correspondência
  });

  it("repetição AUTOMÁTICA idêntica (varredura) NÃO cria outra execução nem auditoria: reconfirma a anterior; execução de USUÁRIO é sempre registrada (não se impõe idempotência entre execuções legítimas)", async () => {
    const w = await world(); const need = await newNeed(w, { title: "Cadeira de rodas" }); const offer = await newOffer(w);
    await runMatchingSweep(); await runMatchingSweep(); await runMatchingSweep();
    let runs = await runsOf(offer); expect(runs).toHaveLength(1); expect(runs[0]).toMatchObject({ status: "concluida_sem_correspondencia", origin: "varredura", repeatCount: 2 });
    expect(await auditFor(offer, "matching.executado")).toHaveLength(1); // a cadeia de auditoria não cresce sem informação
    const d = await detail(w, need.id); expect(d.matching!.runs).toHaveLength(1); expect(d.matching!.runs[0].repeatCount).toBe(2); expect(d.timeline.some((t) => /reconfirmado 2 vez/.test(JSON.stringify(t)))).toBe(true);
    await runMatchingForOpportunity(offer, w.platform.userId, "manual"); await runMatchingForOpportunity(offer, w.platform.userId, "manual");
    runs = await runsOf(offer); expect(runs).toHaveLength(3); expect(runs.filter((r) => r.origin === "manual")).toHaveLength(2); expect(await auditFor(offer, "matching.executado")).toHaveLength(3);
    // mudar o cenário (surge necessidade relacionada) invalida a assinatura: a varredura volta a registrar
    await newNeed(w, { title: "Cobertores de inverno para o abrigo" }, w.owner);
    await runMatchingSweep(); runs = await runsOf(offer); expect(runs.length).toBeGreaterThanOrEqual(4);
  });

  it("exclusão mútua do SWEEP preservada: com o lock da tarefa detido o sweep não executa (nenhuma execução registrada); liberado, registra uma única vez", async () => {
    const w = await world(); await newNeed(w, { title: "Cadeira de rodas" }); const offer = await newOffer(w);
    const held = await withScheduledTaskLock("runMatchingSweep", async () => { await runMatchingSweep(); return (await runsOf(offer)).length; });
    expect(held.ran).toBe(true); expect(held.result).toBe(0);
    await runMatchingSweep(); expect(await runsOf(offer)).toHaveLength(1);
  });
});

describe("jornada H/J — isolamento entre organizações e auditoria", () => {
  it("cada organização vê SÓ as execuções que consideraram as suas necessidades; necessidade alheia = 403/404; execuções e contagens da plataforma não vazam", async () => {
    const w = await world(); const mine = await newNeed(w, { title: "Cadeira de rodas" }); const theirs = await newNeed(w, { title: "Muletas e bengalas" }, w.otherOwner, w.otherOrg.id); const offer = await newOffer(w);
    await runMatchingForOpportunity(offer, w.platform.userId, "manual");
    expect((await detail(w, mine.id)).matching!.runs).toHaveLength(1); expect((await detail(w, theirs.id, w.otherOwner, w.otherOrg.id)).matching!.runs).toHaveLength(1);
    expect((await getJourney(get(`journey?organizationId=${w.org.id}&needId=${mine.id}`, w.otherOwner))).status).toBe(403);
    const cross = await getJourney(get(`journey?organizationId=${w.otherOrg.id}&needId=${mine.id}`, w.otherOwner)); expect(cross.status).toBe(404); expect(await cross.text()).not.toContain("Cadeira");
    const runs = await runsOf(offer);
    const body = JSON.stringify(await detail(w, mine.id)); expect(body).not.toContain("Muletas"); expect(body).not.toMatch(/candidatesConsidered|candidatesRelated|validMatches/); expect(body).not.toContain(runs[0].correlationId);
    // a auditoria da execução é da plataforma (organização nula): a organização NÃO a lê pela Central
    const central = await parseJson<{ entries: unknown[] }>(await getAuditList(get(`audit-center?organizationId=${w.org.id}&limit=50&correlationId=${runs[0].correlationId}`, w.owner))); expect(central.entries).toEqual([]);
    const platformView = await parseJson<{ runs: Array<{ correlationId: string; status: string; candidatesConsidered: number }> }>(await getMatchingRuns(get(`matching-runs?opportunityId=${offer}`, w.platform)));
    expect(platformView.runs[0]).toMatchObject({ correlationId: runs[0].correlationId, status: "concluida_sem_correspondencia" }); expect(platformView.runs[0].candidatesConsidered).toBe(2);
    expect((await getMatchingRuns(get(`matching-runs?opportunityId=${offer}`, w.admin))).status).toBe(403); expect((await getMatchingRuns(get(`matching-runs?opportunityId=abc`, w.platform))).status).toBe(400);
  });

  it("oferta LOCAL sem necessidade não passa pelo matching: nenhuma execução registrada e a jornada dela não marca etapa inexistente como concluída", async () => {
    const w = await world();
    const res = await postOpportunity(post("opportunities", w.owner, { organizationId: w.org.id, title: "Agasalhos locais", donorName: "Doador", quantityOffered: 5, unit: "unidade" })); expect(res.status).toBe(200);
    expect(await db.selectFrom("matchingRuns").select("id").execute()).toHaveLength(0);
    const page = await parseJson<{ items: Array<{ kind: string; steps: Step[] }> }>(await getJourneys(get(`journeys?organizationId=${w.org.id}&tipo=oferta_local`, w.owner)));
    expect(page.items).toHaveLength(1); expect(page.items[0].steps.filter((s) => s.state === "concluida").map((s) => s.key)).toEqual(["oferta"]);
  });
});

describe("busca sem acentos (servidor, sem extensão)", () => {
  it("ignora acentos e caixa em título/descrição/doador/categoria, mantém #id e correlação literais e continua escapando % e _", async () => {
    const w = await world();
    const n = await newNeed(w, { title: "Coberta de inverno", description: "Famílias do bairro São José" });
    const o1 = await postOpportunity(post("opportunities", w.owner, { organizationId: w.org.id, title: "Agasalhos de lã", donorName: "Padaria Estrêla", category: "Vestuário", quantityOffered: 3, unit: "unidade" })); expect(o1.status).toBe(200);
    const ids = async (qs: string) => (await parseJson<{ items: Array<{ kind: string; needId?: number; id?: number }> }>(await getJourneys(get(`journeys?organizationId=${w.org.id}&${qs}`, w.owner)))).items.map((e) => `${e.kind}:${e.needId ?? e.id}`);
    expect(await ids("q=sao%20jose")).toEqual([`necessidade:${n.id}`]); // sem acento encontra "São José"
    expect(await ids(`q=${encodeURIComponent("SÃO JOSÉ")}`)).toEqual([`necessidade:${n.id}`]); // com acento e caixa alta encontra o mesmo
    expect(await ids("q=la%20de")).toEqual([]); // "lã" ≠ "la de" como palavra: sem coincidência
    expect((await ids("q=agasalhos%20de%20la"))).toHaveLength(1); expect(await ids("q=estrela")).toHaveLength(1); expect(await ids("q=vestuario")).toHaveLength(1);
    expect(await ids(`q=${encodeURIComponent("Vestuário")}&tipo=oferta_local`)).toHaveLength(1);
    expect(await ids(`q=${n.correlationId}`)).toEqual([`necessidade:${n.id}`]); // correlação literal
    expect(await ids("q=%25")).toEqual([]); expect(await ids("q=_")).toEqual([]); // curingas são literais
    expect(await ids("q=%27%3B%20DROP%20TABLE%20needs%3B--")).toEqual([]); // injeção: tratada como texto
    expect(await db.selectFrom("needs").select("id").execute()).toHaveLength(1);
    expect(foldText("Ação Ç É ñ ÀÉÎÕÜ")).toBe("acao c e n aeiou"); expect(foldText("#12 abc")).toBe("#12 abc");
  });
});
