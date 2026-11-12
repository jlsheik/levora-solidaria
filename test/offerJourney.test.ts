/**
 * M41 — jornada UNIFICADA de ofertas e necessidades, com os serviços REAIS e PostgreSQL descartável (nenhum mock): ofertas sem necessidade vinculada (oferta local e atribuição da rede), origem da
 * atribuição (matching × manual × não verificável), busca/filtros/paginação no servidor, permissões, isolamento entre organizações, concorrência e o fato de a leitura nunca escrever nada.
 * Tudo sintético; nada representa entrega física.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { deriveMatchingState, deriveSteps } from "../src/helpers/journey";
import { deriveLocalOfferSteps, deriveUnlinkedAllocationSteps } from "../src/helpers/journeyOffers";
import { businessDateOf } from "../src/helpers/businessDate";
import { handle as postNeed } from "../src/endpoints/needs_POST";
import { handle as postOpportunity } from "../src/endpoints/opportunities_POST";
import { handle as postOpportunityReceive } from "../src/endpoints/opportunities-receive_POST";
import { handle as postRegistryMatch } from "../src/endpoints/opportunity-registry-match_POST";
import { handle as postAllocation } from "../src/endpoints/opportunity-allocations_POST";
import { handle as postDecide } from "../src/endpoints/allocations-decide_POST";
import { handle as postReceive } from "../src/endpoints/allocations-receive_POST";
import { handle as getJourneys } from "../src/endpoints/journeys_GET";
import { handle as getJourney } from "../src/endpoints/journey_GET";
import { handle as getOfferJourney } from "../src/endpoints/offer-journey_GET";
import { handle as getAuditList } from "../src/endpoints/audit-center_GET";
import { addMembership, buildRequest, createAuthenticatedUser, createPlatformAdmin, createTestInventoryItem, createTestOpportunityRegistry, createTestOrganization, createTestSource, parseJson, type AuthenticatedTestUser } from "./helpers";

const get = (p: string, a?: AuthenticatedTestUser) => buildRequest(p, { cookie: a?.cookie });
const post = (p: string, a: AuthenticatedTestUser | undefined, body: unknown) => buildRequest(p, { method: "POST", cookie: a?.cookie, body });
const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));
void randomBytes; void businessDateOf;

type OStep = { key: string; state: string; detail: string };
type Entry = { kind: string; id?: number; needId?: number; title: string; status: string; statusLabel?: string; originLabel?: string | null; steps: OStep[]; next: string | null; counts?: { allocationOrigins?: { matching: number; manual: number; naoVerificavel: number } | null } };
type Page = { items: Entry[]; nextCursor: string | null; access: { network: boolean; stock: boolean; opportunities: boolean; report: boolean; audit: boolean } };
type OfferDetail = { kind: string; id: number; title: string; status: string; originLabel: string | null; steps: OStep[]; pendings: string[]; evaluation: { id: string; finalScore: number } | null; receipts: Array<{ quantity: number; entryType: string }>; linking: { available: boolean; reason: string; alternatives: Array<{ href: string }> };
  audit: { correlationId: string | null; entries: number | null; path: string | null } | null; timeline: Array<{ kind: string; title: string }>; notes: string[]; donorName: string | null };

async function world() {
  const owner = await createAuthenticatedUser(); const org = await createTestOrganization(owner.userId);
  const admin = await createAuthenticatedUser(); await addMembership(org.id, admin.userId, "administrador");
  const volunteer = await createAuthenticatedUser(); await addMembership(org.id, volunteer.userId, "voluntario");
  const platform = await createPlatformAdmin(); const source = await createTestSource(platform.userId);
  const item = await createTestInventoryItem(org.id, owner.userId, { name: "Cobertores", unit: "unidade" });
  const otherOwner = await createAuthenticatedUser(); const otherOrg = await createTestOrganization(otherOwner.userId);
  await wait();
  return { owner, admin, volunteer, platform, source, item, org, otherOwner, otherOrg };
}
type W = Awaited<ReturnType<typeof world>>;

const newNeed = async (w: W, over: Record<string, unknown> = {}) => {
  const res = await postNeed(post("needs", w.owner, { organizationId: w.org.id, title: "Cobertores de inverno", quantityNeeded: 30, unit: "unidade", priority: "critica", itemId: w.item.id, ...over }));
  expect(res.status, await res.clone().text()).toBe(200);
  return db.selectFrom("needs").selectAll().where("organizationId", "=", w.org.id).orderBy("id", "desc").executeTakeFirstOrThrow();
};
const newLocalOffer = async (w: W, over: Record<string, unknown> = {}) => {
  const res = await postOpportunity(post("opportunities", w.owner, { organizationId: w.org.id, title: "Oferta local de agasalhos", donorName: "Doador Sintético", donorContact: "contato-secreto@example.com", quantityOffered: 12, unit: "unidade", ...over }));
  expect(res.status, await res.clone().text()).toBe(200);
  return (await parseJson<{ opportunity: { id: number } }>(res)).opportunity.id;
};
const newRegistryOffer = async (w: W, over: { title?: string; quantity?: string; status?: "validada" | "aguardando_destinacao" } = {}) => {
  const o = await createTestOpportunityRegistry(w.source.id, w.platform.userId, { status: over.status ?? "validada", title: over.title ?? "Doação de cobertores de inverno" });
  await db.updateTable("opportunityRegistry").set({ quantity: over.quantity ?? "40", unit: "unidade", category: "cobertores", locationCity: "Belo Horizonte", locationState: "MG" }).where("id", "=", o.id).execute();
  return o.id;
};
const allocate = async (w: W, offerId: number, qty = 40, needId?: number) => {
  const res = await postAllocation(post("opportunity-allocations", w.platform, { opportunityId: offerId, organizationId: w.org.id, quantityAllocated: qty, ...(needId ? { needId } : {}) }));
  return { res, id: res.status === 200 ? (await parseJson<{ allocation: { id: number } }>(res.clone())).allocation.id : null };
};
const list = async (w: W, qs = "", who: AuthenticatedTestUser = w.owner, org = w.org.id) => parseJson<Page>(await getJourneys(get(`journeys?organizationId=${org}${qs ? `&${qs}` : ""}`, who)));
const offerDetail = async (w: W, kind: string, id: number, who: AuthenticatedTestUser = w.owner, org = w.org.id) => getOfferJourney(get(`offer-journey?organizationId=${org}&kind=${kind}&id=${id}`, who));
const stepOf = (e: { steps: OStep[] }, k: string) => e.steps.find((s) => s.key === k)!;
const stockOf = async (w: W) => Number((await db.selectFrom("stockTransactions").select(sql<string>`COALESCE(SUM(delta),0)`.as("t")).where("itemId", "=", w.item.id).executeTakeFirstOrThrow()).t);

describe("etapas puras: nada é 'concluído' sem fato persistido", () => {
  const acc = { report: true };
  it("oferta local sem necessidade: só a oferta está concluída; vínculo pendente; matching não se aplica; destinação sem dados", () => {
    const r = deriveLocalOfferSteps({ title: "x", status: "registrada", quantity: 5, unit: "unidade", access: acc });
    expect(r.steps.map((s) => [s.key, s.state])).toEqual([["oferta", "concluida"], ["vinculo", "pendente"], ["correspondencia", "nao_se_aplica"], ["recebimento", "pendente"], ["destinacao", "sem_dados"], ["prestacao", "sem_dados"]]);
    expect(r.steps[0].detail).toMatch(/não é uma doação entregue/); expect(r.steps[1].detail).toMatch(/não permite vincular depois/);
    const c = deriveLocalOfferSteps({ title: "x", status: "cancelada", quantity: null, unit: null, access: acc });
    expect(c.steps.find((s) => s.key === "vinculo")!.state).toBe("nao_se_aplica"); expect(c.steps.find((s) => s.key === "recebimento")!.state).toBe("nao_se_aplica"); expect(c.next).toBeNull();
    expect(c.steps[0].detail).toMatch(/quantidade não informada/);
    expect(deriveLocalOfferSteps({ title: "x", status: "registrada", quantity: 1, unit: null, access: { report: false } }).steps.at(-1)!.state).toBe("restrita");
    const rec = deriveLocalOfferSteps({ title: "x", status: "recebida", quantity: 5, unit: "unidade", access: acc, received: { quantity: 4, unit: "unidade" } });
    expect(rec.steps.find((s) => s.key === "recebimento")).toMatchObject({ state: "concluida" }); expect(rec.steps.find((s) => s.key === "recebimento")!.detail).toMatch(/4 unidade/);
    expect(rec.steps.find((s) => s.key === "destinacao")!.state).toBe("sem_dados"); // receber não é destinar
  });
  it("atribuição da rede sem necessidade: origem manual / matching / não verificável; recebimento só com ledger", () => {
    const base = { title: "x", sourceName: "Fonte", registryStatus: "atribuida", quantityAllocated: 10, unit: "unidade", status: "proposta", score: null, evaluationId: null, receivedQuantity: null, access: acc };
    expect(stepOf(deriveUnlinkedAllocationSteps({ ...base, origin: "manual" }), "correspondencia")).toMatchObject({ state: "nao_se_aplica" });
    expect(stepOf(deriveUnlinkedAllocationSteps({ ...base, origin: "manual" }), "correspondencia").detail).toMatch(/nenhuma avaliação de matching foi executada/);
    expect(stepOf(deriveUnlinkedAllocationSteps({ ...base, origin: "matching", score: 82, evaluationId: "9" }), "correspondencia")).toMatchObject({ state: "concluida" });
    expect(stepOf(deriveUnlinkedAllocationSteps({ ...base, origin: "nao_verificavel" }), "correspondencia")).toMatchObject({ state: "sem_dados" });
    const accepted = deriveUnlinkedAllocationSteps({ ...base, origin: "manual", status: "aceita" });
    expect(stepOf(accepted, "atribuicao").state).toBe("em_andamento"); expect(stepOf(accepted, "recebimento").state).toBe("em_andamento"); expect(stepOf(accepted, "destinacao").state).toBe("sem_dados");
    const done = deriveUnlinkedAllocationSteps({ ...base, origin: "manual", status: "recebida", receivedQuantity: 10 });
    expect(stepOf(done, "atribuicao").state).toBe("concluida"); expect(stepOf(done, "recebimento")).toMatchObject({ state: "concluida" }); expect(stepOf(done, "destinacao").state).toBe("sem_dados"); expect(stepOf(done, "prestacao").state).toBe("sem_dados");
    const refused = deriveUnlinkedAllocationSteps({ ...base, origin: "manual", status: "recusada" });
    expect(stepOf(refused, "vinculo").state).toBe("nao_se_aplica"); expect(refused.next).toBeNull();
  });
  it("etapa de correspondência da necessidade: atribuição manual NÃO é matching concluído", () => {
    const counts = (over: Record<string, unknown>) => ({ evaluations: 0, allocations: { aceita: 1 }, receipts: 0, destinations: 0, localOffers: 0, allocationOrigins: { matching: 0, manual: 1, naoVerificavel: 0 }, ...over }) as never;
    const mk = (c: never) => deriveSteps({ status: "aberta", quantityNeeded: 30, unit: "unidade", supply: { fulfilled: 0, requiredRemaining: 30, surplus: 0 }, attendance: { requested: 30, attended: 0, remaining: 30, percent: 0, physicalDestined: 0, surplus: 0, unitIncompatibleDestined: 0, state: "sem_atendimento" } as never, counts: c, access: { network: true, report: true } });
    const manual = mk(counts({})).steps.find((s) => s.key === "correspondencia")!; expect(manual.state).toBe("nao_se_aplica"); expect(manual.detail).toMatch(/Atribuição manual autorizada/); expect(manual.detail).toMatch(/nenhuma avaliação de matching foi executada/);
    const unverifiable = mk(counts({ allocationOrigins: { matching: 0, manual: 0, naoVerificavel: 1 } })).steps.find((s) => s.key === "correspondencia")!; expect(unverifiable.state).toBe("sem_dados");
    const M = (over: Record<string, unknown>) => ({ runs: 0, runsNoRelation: 0, evalValid: 0, evalNoQuantity: 0, evalDiscarded: 0, lastAt: null, lastOrigin: null, ...over });
    const real = mk(counts({ evaluations: 2, matching: M({ runs: 2, evalValid: 2 }), allocationOrigins: { matching: 1, manual: 1, naoVerificavel: 0 } })).steps.find((s) => s.key === "correspondencia")!; expect(real.state).toBe("concluida"); expect(real.detail).toMatch(/2 avaliação/);
    const evalOnly = mk(counts({ evaluations: 1, allocations: {}, matching: M({ runs: 1, evalNoQuantity: 1 }), allocationOrigins: { matching: 0, manual: 0, naoVerificavel: 0 } })).steps.find((s) => s.key === "correspondencia")!; expect(evalOnly.state).toBe("concluida"); expect(evalOnly.detail).toMatch(/nenhuma resultou em atribuição/); expect(evalOnly.detail).toMatch(/elegível\(is\) sem quantidade livre/);
    // M42: executado SEM correspondência não é "concluído", não é falha e não é "não executado"
    const noMatch = mk(counts({ evaluations: 0, allocations: {}, matching: M({ runs: 3, runsNoRelation: 3, lastAt: "2026-11-11T12:00:00.000Z", lastOrigin: "varredura" }), allocationOrigins: { matching: 0, manual: 0, naoVerificavel: 0 } }));
    const nm = noMatch.steps.find((s) => s.key === "correspondencia")!; expect(nm.state).toBe("executado_sem_resultado"); expect(nm.detail).toMatch(/Matching executado em 3 execução\(ões\): nenhuma correspondência válida/); expect(nm.detail).toMatch(/3 execução\(ões\) sem nenhuma oferta relacionada/); expect(nm.detail).toMatch(/Isto não é uma falha/); expect(nm.detail).toMatch(/varredura automática/);
    expect(noMatch.next).toMatch(/foi executado e não encontrou correspondência válida/); expect(noMatch.next).toMatch(/atribuição manual feita pela administração da plataforma/);
    const discarded = mk(counts({ evaluations: 2, allocations: {}, matching: M({ runs: 2, evalDiscarded: 2 }), allocationOrigins: { matching: 0, manual: 0, naoVerificavel: 0 } })).steps.find((s) => s.key === "correspondencia")!; expect(discarded.state).toBe("executado_sem_resultado"); expect(discarded.detail).toMatch(/2 avaliação\(ões\) abaixo do limiar de proposta/);
    const manualAndRan = mk(counts({ evaluations: 0, matching: M({ runs: 1, runsNoRelation: 1 }) })).steps.find((s) => s.key === "correspondencia")!; expect(manualAndRan.state).toBe("executado_sem_resultado"); expect(manualAndRan.detail).toMatch(/Há também 1 atribuição\(ões\) manual\(is\)/);
    expect(deriveMatchingState(counts({}) as never, true)).toBe("atribuicao_manual"); expect(deriveMatchingState(counts({ allocations: {}, allocationOrigins: { matching: 0, manual: 0, naoVerificavel: 0 } }) as never, true)).toBe("nao_executado"); expect(deriveMatchingState(counts({}) as never, false)).toBe("restrita");
    const none = mk(counts({ allocations: {}, allocationOrigins: { matching: 0, manual: 0, naoVerificavel: 0 } })).steps.find((s) => s.key === "correspondencia")!; expect(none.state).toBe("pendente");
  });
});

describe("jornada A — oferta sem necessidade na experiência de jornada (PostgreSQL real)", () => {
  it("oferta local sem necessidade aparece na lista e no detalhe; etapas verdadeiras; vínculo posterior explicado; auditoria e correlação próprias", async () => {
    const w = await world();
    const id = await newLocalOffer(w);
    const page = await list(w);
    const entry = page.items.find((e) => e.kind === "oferta_local" && e.id === id)!;
    expect(entry).toBeTruthy(); expect(entry.status).toBe("registrada"); expect(entry.statusLabel).toBe("Registrada");
    expect(entry.steps.filter((s) => s.state === "concluida").map((s) => s.key)).toEqual(["oferta"]); // nenhuma etapa falsamente concluída
    expect(stepOf(entry, "vinculo").state).toBe("pendente"); expect(stepOf(entry, "correspondencia").state).toBe("nao_se_aplica"); expect(stepOf(entry, "destinacao").state).toBe("sem_dados");
    const res = await offerDetail(w, "oferta_local", id); expect(res.status).toBe(200);
    const d = await parseJson<OfferDetail>(res);
    expect(d.linking.available).toBe(false); expect(d.linking.reason).toMatch(/pendente de decisão/); expect(d.linking.alternatives.length).toBeGreaterThan(0);
    expect(d.pendings.join(" ")).toMatch(/Nenhuma necessidade está vinculada/); expect(d.notes.join(" ")).toMatch(/Nenhuma tela comprova entrega física/);
    expect(d.donorName).toBe("Doador Sintético"); expect(JSON.stringify(d)).not.toContain("contato-secreto"); // o contato do doador não sai
    const row = await db.selectFrom("donationOpportunities").select("correlationId").where("id", "=", id).executeTakeFirstOrThrow();
    expect(d.audit!.correlationId).toBe(row.correlationId); expect(d.audit!.entries).toBeGreaterThanOrEqual(1); expect(d.audit!.path).toBe(`/organizacoes/${w.org.id}/auditoria?correlacao=${row.correlationId}`);
    const rows = (await parseJson<{ entries: Array<{ action: string; outcome: string | null; correlationId: string | null }> }>(await getAuditList(get(`audit-center?organizationId=${w.org.id}&limit=50&correlationId=${row.correlationId}`, w.owner)))).entries;
    expect(rows.length).toBeGreaterThanOrEqual(1); expect(rows.every((r) => r.outcome === "concluida" && r.correlationId === row.correlationId)).toBe(true); expect(rows.map((r) => r.action)).toContain("oportunidade.registrada");
  });

  it("oferta local VINCULADA a uma necessidade não vira item solto: aparece dentro da jornada da necessidade e a busca pelo título dela leva à necessidade", async () => {
    const w = await world(); const need = await newNeed(w, { title: "Necessidade de cobertores" });
    const linked = await newLocalOffer(w, { title: "Cobertores do doador Maria", linkedNeedId: need.id }); const loose = await newLocalOffer(w, { title: "Agasalhos sem vínculo" });
    const all = await list(w);
    expect(all.items.some((e) => e.kind === "oferta_local" && e.id === linked)).toBe(false); expect(all.items.some((e) => e.kind === "oferta_local" && e.id === loose)).toBe(true);
    expect((await offerDetail(w, "oferta_local", linked)).status).toBe(404); // já tem necessidade: a jornada dela é a da necessidade
    const found = await list(w, `q=${encodeURIComponent("Cobertores do doador")}`);
    expect(found.items.map((e) => e.needId)).toEqual([need.id]);
  });

  it("recebimento da oferta local não é destinação: a jornada mostra 'recebida' e a quantidade lançada, e a destinação segue 'sem dados'", async () => {
    const w = await world(); const id = await newLocalOffer(w, { title: "Oferta a receber", quantityOffered: 12 });
    const before = await stockOf(w);
    const r = await postOpportunityReceive(post("opportunities-receive", w.owner, { organizationId: w.org.id, opportunityId: id, itemId: w.item.id, quantityReceived: 12 })); expect(r.status, await r.clone().text()).toBe(200);
    expect(await stockOf(w)).toBe(before + 12);
    const d = await parseJson<OfferDetail>(await offerDetail(w, "oferta_local", id));
    expect(d.status).toBe("recebida"); expect(stepOf(d, "recebimento")).toMatchObject({ state: "concluida" }); expect(stepOf(d, "recebimento").detail).toMatch(/12 unidade/); expect(stepOf(d, "destinacao").state).toBe("sem_dados");
    expect(d.pendings.join(" ")).not.toMatch(/recebimento ainda não/);
    expect((await db.selectFrom("stockDestinations").select("id").where("organizationId", "=", w.org.id).execute())).toHaveLength(0); // nada foi destinado
  });
});

describe("jornadas C/D — matching executado × atribuição manual: origem verdadeira", () => {
  it("atribuição MANUAL sem necessidade: origem manual, nenhuma avaliação inventada; aceite e recebimento atualizam a jornada; destinação continua sem dados", async () => {
    const w = await world(); const offer = await newRegistryOffer(w, { title: "Cobertores da rede" });
    const a = await allocate(w, offer, 40); expect(a.res.status, await a.res.clone().text()).toBe(200);
    const entry = (await list(w, "tipo=atribuicao_rede")).items.find((e) => e.id === a.id)!;
    expect(entry.kind).toBe("atribuicao_rede"); expect(entry.originLabel).toBe("Atribuição manual"); expect(entry.status).toBe("proposta");
    expect(stepOf(entry, "correspondencia")).toMatchObject({ state: "nao_se_aplica" }); expect(stepOf(entry, "vinculo").state).toBe("pendente"); expect(stepOf(entry, "atribuicao").state).toBe("em_andamento");
    expect(await db.selectFrom("matchEvaluations").select("id").where("allocationId", "=", a.id!).execute()).toHaveLength(0); // nada de avaliação criada pela leitura nem pela atribuição manual
    expect((await db.selectFrom("auditLog").select("metadata").where("action", "=", "atribuicao.proposta").where("entityId", "=", String(a.id)).executeTakeFirstOrThrow()).metadata).toMatchObject({ origem: "manual" }); // a auditoria registra a origem real
    let d = await parseJson<OfferDetail>(await offerDetail(w, "atribuicao_rede", a.id!));
    expect(d.evaluation).toBeNull(); expect(d.originLabel).toBe("Atribuição manual"); expect(d.pendings.join(" ")).toMatch(/aguarda a decisão/);
    expect(d.audit!.correlationId).toBeNull(); expect(d.audit!.path).toBe(`/organizacoes/${w.org.id}/auditoria?recurso=opportunity_allocation&recursoId=${a.id}`); expect(d.audit!.entries).toBeGreaterThanOrEqual(1);
    expect((await postDecide(post("allocations-decide", w.owner, { organizationId: w.org.id, allocationId: a.id, decision: "aceita" }))).status).toBe(200);
    const before = await stockOf(w);
    const rc = await postReceive(post("allocations-receive", w.owner, { organizationId: w.org.id, allocationId: a.id, itemId: w.item.id, quantityReceived: 25 })); expect(rc.status, await rc.clone().text()).toBe(200);
    expect(await stockOf(w)).toBe(before + 25);
    d = await parseJson<OfferDetail>(await offerDetail(w, "atribuicao_rede", a.id!));
    expect(stepOf(d, "recebimento")).toMatchObject({ state: "concluida" }); expect(stepOf(d, "recebimento").detail).toMatch(/25 unidade/); expect(d.receipts).toHaveLength(1);
    expect(stepOf(d, "destinacao").state).toBe("sem_dados"); expect(stepOf(d, "atribuicao").state).toBe("concluida");
    expect(d.timeline.map((t) => t.kind)).toEqual(expect.arrayContaining(["atribuicao", "recebimento"]));
  });

  it("atribuição manual COM necessidade: a jornada da necessidade diz 'manual' e NÃO marca o matching como concluído", async () => {
    const w = await world(); const need = await newNeed(w); const offer = await newRegistryOffer(w);
    const a = await allocate(w, offer, 30, need.id); expect(a.res.status, await a.res.clone().text()).toBe(200);
    const d = await parseJson<{ evaluations: unknown[]; allocations: Array<{ origin: string; evaluationId: string | null; autoMatched: boolean }>; steps: OStep[]; counts: Entry["counts"] }>(await getJourney(get(`journey?organizationId=${w.org.id}&needId=${need.id}`, w.owner)));
    expect(d.evaluations).toHaveLength(0); expect(d.allocations).toHaveLength(1); expect(d.allocations[0]).toMatchObject({ origin: "manual", evaluationId: null, autoMatched: false });
    const c = d.steps.find((s) => s.key === "correspondencia")!; expect(c.state).toBe("nao_se_aplica"); expect(c.detail).toMatch(/Atribuição manual autorizada/);
    expect(d.counts!.allocationOrigins).toEqual({ matching: 0, manual: 1, naoVerificavel: 0 });
    const entry = (await list(w)).items.find((e) => e.needId === need.id)!; expect(stepOf(entry, "correspondencia").state).toBe("nao_se_aplica");
    expect((await list(w, "tipo=atribuicao_rede")).items.some((e) => e.id === a.id)).toBe(false); // tem necessidade: não é uma atribuição "solta"
  });

  it("matching EXECUTADO: a avaliação persistida liga a atribuição, a origem é 'matching' e a etapa fica concluída", async () => {
    const w = await world(); const need = await newNeed(w, { title: "Cobertores de inverno", quantityNeeded: 30 }); const offer = await newRegistryOffer(w, { title: "Doação de cobertores de inverno", quantity: "100" });
    await db.updateTable("opportunityRegistry").set({ status: "aguardando_destinacao" }).where("id", "=", offer).execute();
    const res = await postRegistryMatch(post("opportunity-registry-match", w.platform, { opportunityId: offer })); expect(res.status).toBe(200);
    const d = await parseJson<{ evaluations: Array<{ id: string }>; allocations: Array<{ origin: string; evaluationId: string | null; id: number }>; steps: OStep[] }>(await getJourney(get(`journey?organizationId=${w.org.id}&needId=${need.id}`, w.owner)));
    expect(d.evaluations).toHaveLength(1); expect(d.allocations[0].origin).toBe("matching"); expect(d.allocations[0].evaluationId).toBe(d.evaluations[0].id);
    expect(d.steps.find((s) => s.key === "correspondencia")!.state).toBe("concluida");
    const ev = await db.selectFrom("auditLog").select("metadata").where("entityId", "=", String(d.allocations[0].id)).where("action", "in", ["atribuicao.automatica_alta_confianca", "atribuicao.proposta_automatica"]).executeTakeFirstOrThrow();
    expect(ev.metadata).toMatchObject({ origem: "matching" });
  });

  it("atribuição marcada como automática SEM avaliação no histórico: 'não verificável' (nunca se afirma que o algoritmo rodou) — registros antigos não são reescritos", async () => {
    const w = await world(); const need = await newNeed(w); const offer = await newRegistryOffer(w);
    const [row] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: offer, organizationId: w.org.id, quantityAllocated: "10", status: "proposta", autoMatched: true, needId: need.id }).returning("id").execute();
    const entryBefore = JSON.stringify(await db.selectFrom("opportunityAllocations").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow());
    const d = await parseJson<{ allocations: Array<{ origin: string }>; steps: OStep[] }>(await getJourney(get(`journey?organizationId=${w.org.id}&needId=${need.id}`, w.owner)));
    expect(d.allocations[0].origin).toBe("nao_verificavel"); expect(d.steps.find((s) => s.key === "correspondencia")).toMatchObject({ state: "sem_dados" });
    expect(JSON.stringify(await db.selectFrom("opportunityAllocations").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow())).toBe(entryBefore); // leitura não altera nada
    expect(await db.selectFrom("matchEvaluations").select("id").where("allocationId", "=", row.id).execute()).toHaveLength(0);
  });
});

describe("jornada E — busca, filtros e paginação no servidor", () => {
  it("busca por texto, #identificador e correlação; filtros de tipo, vínculo e situação; limpar filtros devolve tudo", async () => {
    const w = await world();
    const n1 = await newNeed(w, { title: "Cobertores de inverno" }); const n2 = await newNeed(w, { title: "Cestas básicas", description: "famílias do bairro Alvorada", unit: "kg", itemId: undefined });
    const o1 = await newLocalOffer(w, { title: "Agasalhos de lã", donorName: "Padaria Estrela" }); const o2 = await newLocalOffer(w, { title: "Brinquedos usados", category: "brinquedos" });
    const reg = await newRegistryOffer(w, { title: "Colchões da rede" }); const al = await allocate(w, reg, 10);
    const ids = (p: Page) => p.items.map((e) => `${e.kind}:${e.needId ?? e.id}`).sort();
    expect(ids(await list(w))).toEqual([`atribuicao_rede:${al.id}`, `necessidade:${n1.id}`, `necessidade:${n2.id}`, `oferta_local:${o1}`, `oferta_local:${o2}`].sort());
    expect(ids(await list(w, "q=cobertores"))).toEqual([`atribuicao_rede:${al.id}`, `necessidade:${n1.id}`].sort()); // sem diferença de caixa; a oferta da rede tem a categoria "cobertores"
    expect(ids(await list(w, "q=cobertores&tipo=necessidade"))).toEqual([`necessidade:${n1.id}`]);
    expect(ids(await list(w, "q=ALVORADA"))).toEqual([`necessidade:${n2.id}`]); // descrição
    expect(ids(await list(w, "q=Padaria"))).toEqual([`oferta_local:${o1}`]); // doador (oferta local)
    expect(ids(await list(w, "q=brinquedos"))).toEqual([`oferta_local:${o2}`]); // categoria
    expect(ids(await list(w, "q=Colch%C3%B5es"))).toEqual([`atribuicao_rede:${al.id}`]); // título da oferta da rede
    expect(ids(await list(w, `q=%23${n2.id}`)).includes(`necessidade:${n2.id}`)).toBe(true); // #número
    expect(ids(await list(w, `q=${n1.correlationId}`))).toEqual([`necessidade:${n1.id}`]); // correlação (exata)
    expect(ids(await list(w, "q=nada-disto-existe"))).toEqual([]);
    expect(ids(await list(w, "q=%25"))).toEqual([]); // '%' é literal, não curinga
    expect(ids(await list(w, "tipo=necessidade"))).toEqual([`necessidade:${n1.id}`, `necessidade:${n2.id}`]);
    expect(ids(await list(w, "tipo=oferta_local"))).toEqual([`oferta_local:${o1}`, `oferta_local:${o2}`]);
    expect(ids(await list(w, "tipo=atribuicao_rede"))).toEqual([`atribuicao_rede:${al.id}`]);
    expect(ids(await list(w, "vinculo=com_necessidade"))).toEqual([`necessidade:${n1.id}`, `necessidade:${n2.id}`]);
    expect(ids(await list(w, "vinculo=sem_necessidade"))).toEqual([`atribuicao_rede:${al.id}`, `oferta_local:${o1}`, `oferta_local:${o2}`].sort());
    expect(ids(await list(w, "vinculo=com_necessidade&tipo=oferta_local"))).toEqual([]); // combinação contraditória: nada, não tudo
    expect(ids(await list(w, "status=registrada"))).toEqual([`oferta_local:${o1}`, `oferta_local:${o2}`]); // a situação vale só para o tipo a que pertence
    expect(ids(await list(w, "status=proposta"))).toEqual([`atribuicao_rede:${al.id}`]);
    expect(ids(await list(w, "status=aberta"))).toEqual([`necessidade:${n1.id}`, `necessidade:${n2.id}`]);
    expect(ids(await list(w, "status=aberta&tipo=oferta_local"))).toEqual([]);
    expect(ids(await list(w, "q=cobertores&tipo=oferta_local"))).toEqual([]);
  });

  it("paginação estável sobre os três tipos: sem duplicar nem omitir; mesma ordem entre chamadas; item novo durante a leitura não desloca a página; cursor inválido = 400", async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) await newNeed(w, { title: `Necessidade ${i + 1}` });
    for (let i = 0; i < 3; i++) await newLocalOffer(w, { title: `Oferta local ${i + 1}` });
    for (let i = 0; i < 2; i++) { const o = await newRegistryOffer(w, { title: `Oferta da rede ${i + 1}` }); await allocate(w, o, 5); }
    const seen: string[] = []; let cursor: string | null = null; let pages = 0;
    do {
      const qs: string = `limit=3${cursor ? `&cursor=${cursor}` : ""}`; const p = await list(w, qs); pages += 1;
      expect(p.items.length).toBeLessThanOrEqual(3); for (const e of p.items) seen.push(`${e.kind}:${e.needId ?? e.id}`);
      if (pages === 1) await newLocalOffer(w, { title: "Chegou durante a leitura" }); // não desloca as páginas seguintes
      cursor = p.nextCursor;
    } while (cursor && pages < 10);
    expect(pages).toBe(3); expect(new Set(seen).size).toBe(seen.length); expect(seen).toHaveLength(8); expect(seen.some((s) => s.startsWith("oferta_local") && s.endsWith(String(0)))).toBe(false);
    const full1 = (await list(w, "limit=50")).items.map((e) => `${e.kind}:${e.needId ?? e.id}`); const full2 = (await list(w, "limit=50")).items.map((e) => `${e.kind}:${e.needId ?? e.id}`);
    expect(full1).toEqual(full2); expect(full1).toHaveLength(9);
    for (const bad of ["cursor=abc", "cursor=2026-01-01T00:00:00.000000Z_9_1", "tipo=inventado", "vinculo=x", "status=xyz", `q=${"a".repeat(81)}`]) expect((await getJourneys(get(`journeys?organizationId=${w.org.id}&${bad}`, w.owner))).status, bad).toBe(400);
  });
});

describe("permissões, isolamento e leitura sem efeito colateral", () => {
  it("voluntário: o servidor aplica as permissões do papel (rede sim; estoque, auditoria e correlação não); a tela só reflete", async () => {
    const w = await world(); const lo = await newLocalOffer(w, { title: "Oferta para o voluntário ver" }); const reg = await newRegistryOffer(w); const al = await allocate(w, reg, 10);
    const p = await list(w, "", w.volunteer);
    expect(p.access.stock).toBe(false); expect(p.access.audit).toBe(false); // estoque e auditoria nunca vêm para o voluntário
    // o que entra na lista é exatamente o que o papel pode ler: cada tipo só aparece se a permissão de origem existe
    expect(p.items.some((e) => e.kind === "atribuicao_rede" && e.id === al.id)).toBe(p.access.network);
    expect(p.items.some((e) => e.kind === "oferta_local" && e.id === lo)).toBe(p.access.opportunities);
    const vd = await offerDetail(w, "oferta_local", lo, w.volunteer); expect(vd.status).toBe(p.access.opportunities ? 200 : 404);
    if (vd.status === 200) { const v = await parseJson<OfferDetail>(vd); expect(v.audit).toBeNull(); expect(stepOf(v, "prestacao").state).toBe(p.access.report ? "sem_dados" : "restrita"); expect(JSON.stringify(v)).not.toContain("correlationId\":\""); }
    const ad = await offerDetail(w, "atribuicao_rede", al.id!, w.volunteer); expect(ad.status).toBe(p.access.network ? 200 : 404);
    if (ad.status === 200) expect((await parseJson<OfferDetail>(ad)).audit).toBeNull(); // sem auditoria.leia: nem contagem nem link
    // papel sem rede (simulado por uma organização onde ele não é membro) não enxerga nada
    expect((await getJourneys(get(`journeys?organizationId=${w.otherOrg.id}`, w.volunteer))).status).toBe(403);
    const wr = [await postDecide(post("allocations-decide", w.volunteer, { organizationId: w.org.id, allocationId: al.id, decision: "aceita" })), await postNeed(post("needs", w.volunteer, { organizationId: w.org.id, title: "Tentativa", quantityNeeded: 1, unit: "unidade", priority: "baixa" }))];
    expect(wr.every((r) => r.status === 403)).toBe(true);
  });

  it("isolamento: outra organização não lista nem abre; id alheio responde igual a inexistente (404); parâmetros inválidos = 400", async () => {
    const w = await world(); const lo = await newLocalOffer(w, { title: "Oferta privada da organização A" }); const reg = await newRegistryOffer(w); const al = await allocate(w, reg, 10);
    expect((await getJourneys(get(`journeys?organizationId=${w.org.id}`, w.otherOwner))).status).toBe(403);
    expect((await getOfferJourney(get(`offer-journey?organizationId=${w.org.id}&kind=oferta_local&id=${lo}`, w.otherOwner))).status).toBe(403);
    const alien = await offerDetail(w, "oferta_local", lo, w.otherOwner, w.otherOrg.id); const missing = await offerDetail(w, "oferta_local", 99999999, w.otherOwner, w.otherOrg.id);
    expect(alien.status).toBe(404); expect(missing.status).toBe(404); expect(await alien.text()).toBe(await missing.text()); // a existência não vaza
    expect((await offerDetail(w, "atribuicao_rede", al.id!, w.otherOwner, w.otherOrg.id)).status).toBe(404);
    expect((await list(w, "q=privada", w.otherOwner, w.otherOrg.id)).items).toEqual([]);
    for (const bad of ["kind=outra&id=1", "kind=oferta_local&id=abc", "kind=oferta_local&id=0", "kind=oferta_local&id=-3", "kind=oferta_local"]) expect((await getOfferJourney(get(`offer-journey?organizationId=${w.org.id}&${bad}`, w.owner))).status, bad).toBe(400);
    expect((await getOfferJourney(get(`offer-journey?organizationId=${w.org.id}&kind=oferta_local&id=${lo}`))).status).toBe(401);
  });

  it("ler a jornada nunca escreve: lista e detalhes não criam auditoria, avaliação, estoque nem vínculo", async () => {
    const w = await world(); const lo = await newLocalOffer(w); const reg = await newRegistryOffer(w); const al = await allocate(w, reg, 10);
    const snap = async () => JSON.stringify([await db.selectFrom("auditLog").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow(), await db.selectFrom("matchEvaluations").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow(), await stockOf(w), await db.selectFrom("opportunityAllocations").select(["id", "needId", "status", "updatedAt"]).orderBy("id").execute(), await db.selectFrom("donationOpportunities").select(["id", "linkedNeedId", "status", "version"]).orderBy("id").execute()]);
    const before = await snap();
    await list(w); await list(w, "q=a&tipo=oferta_local"); await offerDetail(w, "oferta_local", lo); await offerDetail(w, "atribuicao_rede", al.id!);
    expect(await snap()).toBe(before);
  });
});

describe("jornada H — concorrência: duas operações disputam a mesma quantidade (invariantes, sem temporização)", () => {
  it("duas atribuições simultâneas da mesma oferta à mesma organização: a soma ativa nunca passa da quantidade da oferta e a jornada reflete só o que foi persistido", async () => {
    const w = await world(); const offer = await newRegistryOffer(w, { quantity: "40" });
    const results = await Promise.all([allocate(w, offer, 30), allocate(w, offer, 30)]);
    const ok = results.filter((r) => r.res.status === 200).length; expect(ok).toBeLessThanOrEqual(1); expect(ok).toBeGreaterThanOrEqual(1);
    const rows = await db.selectFrom("opportunityAllocations").select(["id", "quantityAllocated", "status"]).where("opportunityRegistryId", "=", offer).execute();
    expect(rows.filter((r) => !["recusada", "cancelada"].includes(r.status)).reduce((s, r) => s + Number(r.quantityAllocated), 0)).toBeLessThanOrEqual(40);
    const p = await list(w, "tipo=atribuicao_rede"); expect(p.items.length).toBe(rows.length); expect(new Set(p.items.map((e) => e.id)).size).toBe(p.items.length);
  });

  it("dois recebimentos simultâneos da mesma atribuição sem necessidade: um só entra no ledger e no estoque; a jornada mostra um recebimento", async () => {
    const w = await world(); const offer = await newRegistryOffer(w, { quantity: "40" }); const a = await allocate(w, offer, 40); expect(a.id).not.toBeNull();
    await postDecide(post("allocations-decide", w.owner, { organizationId: w.org.id, allocationId: a.id, decision: "aceita" }));
    const before = await stockOf(w);
    const rs = await Promise.all([postReceive(post("allocations-receive", w.owner, { organizationId: w.org.id, allocationId: a.id, itemId: w.item.id, quantityReceived: 20 })), postReceive(post("allocations-receive", w.admin, { organizationId: w.org.id, allocationId: a.id, itemId: w.item.id, quantityReceived: 20 }))]);
    expect(rs.map((r) => r.status).filter((s) => s === 200)).toHaveLength(1);
    expect(await stockOf(w)).toBe(before + 20);
    const d = await parseJson<OfferDetail>(await offerDetail(w, "atribuicao_rede", a.id!)); expect(d.receipts).toHaveLength(1); expect(d.receipts[0].quantity).toBe(20);
  });
});
