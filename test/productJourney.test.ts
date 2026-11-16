/**
 * M40 — JORNADA principal do produto, de ponta a ponta, com os serviços REAIS e PostgreSQL descartável (nenhum mock):
 * necessidade → oferta no registro central → correspondência (matching) → atribuição → decisão → logística → recebimento (estoque + ledger) → destinação → atendimento final → estorno,
 * lida por `journeys_GET`/`journey_GET` e conferida na Central de Auditoria (resultado explícito + correlação herdada da necessidade). Tudo sintético; nada representa entrega física.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { runAgentEventEngine } from "../src/helpers/agentEventEngine";
import { isCorrelationId } from "../src/helpers/correlation";
import { deriveSteps } from "../src/helpers/journey";
import { businessDateOf } from "../src/helpers/businessDate";
import { handle as postNeed } from "../src/endpoints/needs_POST";
import { handle as postNeedClosure } from "../src/endpoints/need-closure_POST";
import { handle as postRegistryMatch } from "../src/endpoints/opportunity-registry-match_POST";
import { handle as postAllocation } from "../src/endpoints/opportunity-allocations_POST";
import { handle as postDecide } from "../src/endpoints/allocations-decide_POST";
import { handle as postLogistics } from "../src/endpoints/allocations-logistics_POST";
import { handle as postReceive } from "../src/endpoints/allocations-receive_POST";
import { handle as postDestination } from "../src/endpoints/stock-destinations_POST";
import { handle as postReversal } from "../src/endpoints/stock-destination-reversal_POST";
import { handle as postApprovalDecide } from "../src/endpoints/approval-requests-decide_POST";
import { handle as postAgentEnable } from "../src/endpoints/agents-enable_POST";
import { handle as getJourneys } from "../src/endpoints/journeys_GET";
import { handle as getJourney } from "../src/endpoints/journey_GET";
import { handle as getAuditList } from "../src/endpoints/audit-center_GET";
import { handle as getAllocations } from "../src/endpoints/organization-allocations_GET";
import { addMembership, buildRequest, createAuthenticatedUser, createPlatformAdmin, createTestInventoryItem, createTestOpportunityRegistry, createTestOrganization, createTestSource, parseJson, type AuthenticatedTestUser } from "./helpers";

const get = (p: string, a?: AuthenticatedTestUser) => buildRequest(p, { cookie: a?.cookie });
const post = (p: string, a: AuthenticatedTestUser | undefined, body: unknown) => buildRequest(p, { method: "POST", cookie: a?.cookie, body });
const key = () => `k-${randomBytes(8).toString("hex")}`;
const today = () => businessDateOf(new Date());
const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));

type Step = { key: string; state: string; detail: string };
type JourneyItem = { needId: number; status: string; supply: { fulfilled: number; requiredRemaining: number; surplus: number }; attendance: { attended: number; remaining: number; percent: number; physicalDestined: number; state: string }; counts: { evaluations: number | null; allocations: Record<string, number> | null; receipts: number; destinations: number; localOffers: number | null }; steps: Step[]; next: string | null; hasCorrelation: boolean };
type Detail = JourneyItem & { pendingApprovals: Array<{ id: number; quantity: number }> | null; evaluations: Array<{ decision: string; finalScore: number; criteria: Array<{ key: string; score: number | null }>; notApplicable: string[]; allocationId: number | null }> | null; allocations: Array<{ id: number; status: string; autoMatched: boolean; logistics: Array<{ eventType: string }> }> | null; receipts: Array<{ entryType: string; quantity: number; allocationId: number }>; destinations: Array<{ id: string; state: string; quantity: number; proof: unknown }> | null; timeline: Array<{ kind: string; title: string; at: string }>; pendings: string[]; audit: { correlationId: string | null; entries: number | null; path: string | null } | null; access: { network: boolean; stock: boolean; opportunities: boolean; report: boolean; audit: boolean }; notes: string[] };
type AuditRow = { id: string; action: string; outcome: string | null; correlationId: string | null; entityType: string; recordVersion: number };

async function world() {
  const owner = await createAuthenticatedUser(); const org = await createTestOrganization(owner.userId);
  const admin = await createAuthenticatedUser(); await addMembership(org.id, admin.userId, "administrador");
  const operator = await createAuthenticatedUser(); await addMembership(org.id, operator.userId, "operador");
  const volunteer = await createAuthenticatedUser(); await addMembership(org.id, volunteer.userId, "voluntario");
  const platform = await createPlatformAdmin(); const source = await createTestSource(platform.userId);
  const item = await createTestInventoryItem(org.id, owner.userId, { name: "Cobertores", unit: "unidade" });
  const otherOwner = await createAuthenticatedUser(); const otherOrg = await createTestOrganization(otherOwner.userId);
  await wait();
  return { owner, admin, operator, volunteer, platform, source, item, org, otherOwner, otherOrg };
}
type W = Awaited<ReturnType<typeof world>>;

const newNeed = async (w: W, over: Record<string, unknown> = {}) => {
  const res = await postNeed(post("needs", w.owner, { organizationId: w.org.id, title: "Cobertores de inverno", quantityNeeded: 30, unit: "unidade", priority: "critica", itemId: w.item.id, ...over }));
  expect(res.status, await res.clone().text()).toBe(200);
  const n = await db.selectFrom("needs").selectAll().where("organizationId", "=", w.org.id).orderBy("id", "desc").executeTakeFirstOrThrow();
  return n;
};
const newOffer = async (w: W, over: { quantity?: string; title?: string } = {}) => {
  const o = await createTestOpportunityRegistry(w.source.id, w.platform.userId, { status: "validada", title: over.title ?? "Doação de cobertores de inverno" });
  await db.updateTable("opportunityRegistry").set({ quantity: over.quantity ?? "40", unit: "unidade", category: "cobertores", locationCity: "Belo Horizonte", locationState: "MG" }).where("id", "=", o.id).execute();
  return o.id;
};
const allocate = async (w: W, offerId: number, needId: number, qty = 40) => {
  const res = await postAllocation(post("opportunity-allocations", w.platform, { opportunityId: offerId, organizationId: w.org.id, quantityAllocated: qty, needId }));
  expect(res.status, await res.clone().text()).toBe(200);
  return (await parseJson<{ allocation: { id: number } }>(res)).allocation.id;
};
const decide = (w: W, allocationId: number, decision: "aceita" | "recusada", who = w.owner) => postDecide(post("allocations-decide", who, { organizationId: w.org.id, allocationId, decision }));
const receive = (w: W, allocationId: number, quantityReceived: number, who = w.owner) => postReceive(post("allocations-receive", who, { organizationId: w.org.id, allocationId, itemId: w.item.id, quantityReceived }));
const destine = (w: W, needId: number | null, quantity: number, over: Record<string, unknown> = {}, who = w.operator) => postDestination(post("stock-destinations", who, { organizationId: w.org.id, itemId: w.item.id, quantity, destinationType: "distribuicao_familias", needId, deliveredOn: today(), idempotencyKey: key(), ...over }));
const journeys = async (w: W, who: AuthenticatedTestUser = w.owner, org = w.org.id) => parseJson<{ items: JourneyItem[]; nextCursor: string | null; access: Detail["access"] }>(await getJourneys(get(`journeys?organizationId=${org}`, who)));
const detail = async (w: W, needId: number, who: AuthenticatedTestUser = w.owner, org = w.org.id) => parseJson<Detail>(await getJourney(get(`journey?organizationId=${org}&needId=${needId}`, who)));
const stockOf = async (w: W) => Number((await db.selectFrom("stockTransactions").select(sql<string>`COALESCE(SUM(delta),0)`.as("t")).where("itemId", "=", w.item.id).executeTakeFirstOrThrow()).t);
const auditOf = async (w: W, corr: string, who = w.owner) => (await parseJson<{ entries: AuditRow[] }>(await getAuditList(get(`audit-center?organizationId=${w.org.id}&limit=100&correlationId=${corr}`, who)))).entries;
const stepOf = (j: { steps: Step[] }, k: string) => j.steps.find((s) => s.key === k)!;

describe("deriveSteps (função pura): o estado vem dos FATOS, nunca de zero presumido", () => {
  const att = (over: Record<string, unknown> = {}) => ({ requested: 30, attended: 0, remaining: 30, percent: 0, physicalDestined: 0, surplus: 0, unitIncompatibleDestined: 0, state: "sem_atendimento", ...over }) as never;
  const base = { status: "aberta" as const, quantityNeeded: 30, unit: "unidade", supply: { fulfilled: 0, requiredRemaining: 30, surplus: 0 }, attendance: att(), counts: { evaluations: 0, allocations: {}, receipts: 0, destinations: 0, localOffers: 0 }, access: { network: true, report: true } };
  it("necessidade nova: só a primeira etapa concluída; as demais pendentes", () => {
    const { steps, next } = deriveSteps(base);
    expect(steps.map((s) => s.state)).toEqual(["concluida", "pendente", "pendente", "pendente", "pendente", "pendente", "sem_dados"]);
    expect(next).toMatch(/Aguardando correspondência/);
  });
  it("papel sem acesso à rede/relatórios: 'restrita', nunca 'sem dados' nem zero", () => {
    const { steps } = deriveSteps({ ...base, counts: { ...base.counts, evaluations: null, allocations: null }, access: { network: false, report: false } });
    expect(steps.find((s) => s.key === "correspondencia")!.state).toBe("restrita"); expect(steps.find((s) => s.key === "atribuicao")!.state).toBe("restrita"); expect(steps.find((s) => s.key === "prestacao")!.state).toBe("restrita");
  });
  it("recebido sem destinação: a próxima ação é registrar a destinação; encerrada: etapas 'não se aplica'", () => {
    expect(deriveSteps({ ...base, counts: { ...base.counts, receipts: 1, allocations: { recebida: 1 } }, supply: { fulfilled: 20, requiredRemaining: 10, surplus: 0 } }).next).toMatch(/registre a destinação/);
    const closed = deriveSteps({ ...base, status: "cancelada", attendance: att({ state: "cancelada" }) });
    expect(closed.steps.filter((s) => ["correspondencia", "atribuicao", "recebimento", "destinacao", "atendimento"].includes(s.key)).every((s) => s.state === "nao_se_aplica")).toBe(true); expect(closed.next).toBeNull();
  });
});

describe("Jornada principal — do cadastro ao atendimento final, com auditoria e correlação", () => {
  it("A–G: necessidade → oferta → atribuição → decisão → logística → recebimento → destinação → atendimento; cada etapa persistida, legível na jornada e auditada com resultado explícito e a MESMA correlação", async () => {
    const w = await world();
    // A/B — necessidade (origem da jornada): correlação gerada no servidor; o corpo da requisição não a define
    const forged = "11111111-1111-4111-8111-111111111111";
    const need = await newNeed(w, { correlationId: forged } as never);
    expect(isCorrelationId(need.correlationId)).toBe(true); expect(need.correlationId).not.toBe(forged);
    const corr = need.correlationId!;
    let j = (await journeys(w)).items.find((x) => x.needId === need.id)!;
    expect(j).toMatchObject({ status: "aberta", hasCorrelation: true, supply: { fulfilled: 0, requiredRemaining: 30 }, attendance: { attended: 0, remaining: 30 } });
    expect(stepOf(j, "correspondencia").state).toBe("pendente"); expect(j.next).toMatch(/Aguardando correspondência/);

    // C/D — oferta no registro central + atribuição manual a ESTA necessidade (fluxo real da plataforma)
    const offer = await newOffer(w); const allocationId = await allocate(w, offer, need.id, 40);
    j = (await journeys(w)).items.find((x) => x.needId === need.id)!;
    expect(j.counts.allocations).toEqual({ proposta: 1 }); expect(stepOf(j, "atribuicao")).toMatchObject({ state: "em_andamento" }); expect(j.next).toMatch(/aguardando decisão/);
    expect((await detail(w, need.id)).pendings.join(" ")).toMatch(/proposta e aguarda decisão/);
    // a lista de atribuições da organização aponta para a jornada da MESMA necessidade
    const al = await parseJson<{ allocations: Array<{ id: number; needId: number | null }> }>(await getAllocations(get(`organization-allocations?organizationId=${w.org.id}`, w.owner)));
    expect(al.allocations.find((a) => a.id === allocationId)!.needId).toBe(need.id);

    // E — decisão humana e logística
    expect((await decide(w, allocationId, "aceita")).status).toBe(200);
    expect((await postLogistics(post("allocations-logistics", w.owner, { organizationId: w.org.id, allocationId, eventType: "coleta_agendada", scheduledFor: new Date(Date.now() + 86400000) }))).status).toBe(200);
    // F — recebimento físico SINTÉTICO: entrada de estoque + ledger; recebimento parcial
    const stockBefore = await stockOf(w);
    expect((await receive(w, allocationId, 20)).status).toBe(200);
    expect(await stockOf(w)).toBe(stockBefore + 20);
    j = (await journeys(w)).items.find((x) => x.needId === need.id)!;
    expect(j.supply).toMatchObject({ fulfilled: 20, requiredRemaining: 10, surplus: 0 }); expect(j.counts.receipts).toBe(1);
    expect(stepOf(j, "recebimento").state).toBe("concluida"); expect(stepOf(j, "destinacao").state).toBe("pendente"); expect(j.next).toMatch(/registre a destinação/);
    expect(j.attendance).toMatchObject({ attended: 0 }); // suprimento ≠ atendimento: receber NÃO atende a necessidade

    // G — destinação do estoque à necessidade (atendimento final): parcial, depois completa; repetição idempotente
    const k1 = key();
    const d1 = await destine(w, need.id, 5, { idempotencyKey: k1 }); expect(d1.status).toBe(200); // 5 de 20 = 25% do saldo: abaixo de 30%, sem segunda aprovação
    const d1b = await destine(w, need.id, 5, { idempotencyKey: k1 }); expect(d1b.status).toBe(200);
    expect((await parseJson<{ replayed: boolean }>(d1b)).replayed).toBe(true);
    expect(await db.selectFrom("stockDestinations").select("id").where("organizationId", "=", w.org.id).where("entryType", "=", "original").execute()).toHaveLength(1); // a repetição NÃO duplicou
    expect(await stockOf(w)).toBe(stockBefore + 20 - 5);
    let d = await detail(w, need.id);
    expect(d.attendance).toMatchObject({ attended: 5, remaining: 25, percent: 16.6, state: "parcial" }); expect(stepOf(d, "destinacao").state).toBe("em_andamento"); expect(stepOf(d, "atendimento").state).toBe("em_andamento");
    expect(d.pendings.join(" ")).toMatch(/sem comprovante anexado/); expect(d.pendings.join(" ")).toMatch(/Faltam 25/);
    expect(stepOf(d, "prestacao").detail).toMatch(/sem comprovante/); expect(stepOf(d, "prestacao").detail).toMatch(/não é homologação/);
    expect((await destine(w, need.id, 3)).status).toBe(200); // 3 de 15 = 20%
    d = await detail(w, need.id);
    expect(d.attendance).toMatchObject({ attended: 8, remaining: 22 }); expect(d.supply.fulfilled).toBe(20); // suprimento (20) e atendimento (8) são contabilidades diferentes

    // saída de ALTO RISCO (8 de 12 = 66% do saldo): exige a SEGUNDA aprovação; nada baixa do estoque e a jornada mostra a pendência
    const big = await destine(w, need.id, 8); expect(big.status).toBe(202);
    const requestId = (await parseJson<{ approvalRequestId: number }>(big)).approvalRequestId;
    expect(await stockOf(w)).toBe(stockBefore + 20 - 8);
    d = await detail(w, need.id);
    expect(d.pendingApprovals).toHaveLength(1); expect(d.pendings.join(" ")).toMatch(/aguarda a segunda aprovação/); expect(d.next).toMatch(/segunda aprovação/); expect(d.attendance.attended).toBe(8); // ainda não atendeu
    expect(stepOf(d, "destinacao").detail).toMatch(/aguardando segunda aprovação/);
    expect((await postApprovalDecide(post("approval-requests-decide", w.operator, { organizationId: w.org.id, requestId, decision: "aprovada" }))).status).toBeGreaterThanOrEqual(400); // quem pediu não aprova a própria saída
    expect((await postApprovalDecide(post("approval-requests-decide", w.admin, { organizationId: w.org.id, requestId, decision: "aprovada" }))).status).toBe(200);
    expect(await stockOf(w)).toBe(stockBefore + 20 - 16);
    d = await detail(w, need.id);
    expect(d.pendingApprovals).toEqual([]); expect(d.attendance).toMatchObject({ attended: 16, remaining: 14 });
    expect(d.steps.map((x) => x.key)).toEqual(["necessidade", "correspondencia", "atribuicao", "recebimento", "destinacao", "atendimento", "prestacao"]);

    // detalhe: correspondência (manual: sem avaliação), atribuição com logística, recebimento, destinações e linha do tempo só com fatos persistidos
    expect(d.evaluations).toEqual([]); expect(d.allocations![0]).toMatchObject({ id: allocationId, status: "recebida", autoMatched: false }); expect(d.allocations![0].logistics.map((l) => l.eventType)).toEqual(["coleta_agendada", "entrega_confirmada"]); // o recebimento registra a entrega confirmada da atribuição (comportamento do domínio)
    expect(d.receipts).toHaveLength(1); expect(d.receipts[0]).toMatchObject({ entryType: "original", quantity: 20, allocationId });
    expect(d.destinations).toHaveLength(3);
    const kinds = d.timeline.map((t) => t.kind);
    expect(kinds).toEqual(expect.arrayContaining(["necessidade", "atribuicao", "logistica", "recebimento", "destinacao"])); expect(kinds.filter((k) => k === "correspondencia")).toHaveLength(0); // etapa ausente NÃO é inventada
    expect(d.timeline.map((t) => t.at)).toEqual([...d.timeline.map((t) => t.at)].sort());
    expect(d.notes.join(" ")).toMatch(/Nenhuma tela comprova entrega física/);

    // H — auditoria: todos os registros da jornada nascem com RESULTADO EXPLÍCITO e a correlação da necessidade
    const rows = await auditOf(w, corr);
    const acts = rows.map((r) => r.action);
    expect(acts).toEqual(expect.arrayContaining(["necessidade.criada", "atribuicao.proposta", "atribuicao.aceita", "logistica.coleta_agendada", "atribuicao.recebida", "inventario.saida_registrada", "destinacao.registrada"]));
    expect(rows.every((r) => r.outcome !== null && r.recordVersion === 2 && r.correlationId === corr)).toBe(true);
    expect(rows.find((r) => r.action === "atribuicao.proposta")!.outcome).toBe("pendente"); expect(rows.find((r) => r.action === "destinacao.registrada")!.outcome).toBe("concluida");
    expect(d.audit).toMatchObject({ correlationId: corr, entries: rows.length }); expect(d.audit!.path).toContain(`correlacao=${corr}`);
    expect(acts.filter((a) => a === "destinacao.registrada")).toHaveLength(3); // 5 + 3 + 8 (aprovada); a repetição idempotente NÃO gerou um registro a mais
    expect(rows.find((r) => r.action === "destinacao.pendente_aprovacao")).toMatchObject({ outcome: "pendente", correlationId: corr });
    expect((await verifyAuditLogChain()).integra).toBe(true);
  });

  it("estorno PERMITIDO (devolução física por quem pode) restaura estoque e reabre o atendimento, e é auditado na MESMA jornada; estornos indevidos são recusados", async () => {
    const w = await world(); const need = await newNeed(w); const allocationId = await allocate(w, await newOffer(w), need.id, 40);
    await decide(w, allocationId, "aceita"); await receive(w, allocationId, 30);
    const dest = await destine(w, need.id, 8); expect(dest.status).toBe(200); // 8 de 30 = 26,7%
    const destId = (await parseJson<{ destination: { id: string } }>(dest)).destination.id;
    expect((await detail(w, need.id)).attendance).toMatchObject({ attended: 8, remaining: 22 });
    const rev = (who: AuthenticatedTestUser, over: Record<string, unknown> = {}, org = w.org.id) => postReversal(post("stock-destination-reversal", who, { organizationId: org, destinationId: destId, kind: "devolucao_fisica", quantity: 3, reason: "Material voltou ao estoque", idempotencyKey: key(), ...over }));
    expect((await rev(w.operator)).status).toBe(403); // sem organizacao.gerencie
    expect((await rev(w.admin, { quantity: 9 })).status).toBeGreaterThanOrEqual(400); // além do que pode ser revertido
    expect((await rev(w.otherOwner, {}, w.otherOrg.id)).status).toBe(404); // destinação de outra organização
    const before = await stockOf(w);
    const ok = await rev(w.admin); expect(ok.status).toBe(200);
    expect(await stockOf(w)).toBe(before + 3);
    const after = await detail(w, need.id);
    expect(after.attendance).toMatchObject({ attended: 5, remaining: 25 }); expect(after.destinations![0].state).toBe("parcialmente_revertida");
    const rows = await auditOf(w, need.correlationId!); const rv = rows.find((r) => r.action === "destinacao.revertida")!;
    expect(rv).toMatchObject({ outcome: "concluida", correlationId: need.correlationId });
    expect((await verifyAuditLogChain()).integra).toBe(true);
  });

  it("correspondência AUTOMÁTICA: a avaliação é gravada com os critérios exatos do motor, aparece explicada na jornada e a atribuição/auditoria herdam a correlação da necessidade", async () => {
    const w = await world(); const need = await newNeed(w, { title: "Cobertores de inverno", quantityNeeded: 30 });
    const offer = await newOffer(w, { title: "Doação de cobertores de inverno", quantity: "100" });
    await db.updateTable("opportunityRegistry").set({ status: "aguardando_destinacao" }).where("id", "=", offer).execute();
    const res = await postRegistryMatch(post("opportunity-registry-match", w.platform, { opportunityId: offer }));
    expect(res.status).toBe(200);
    const out = await parseJson<{ skipped: boolean; allocationsCreated: Array<{ organizationId: number; status: string }> }>(res);
    expect(out.skipped).toBe(false); const mine = out.allocationsCreated.filter((a) => a.organizationId === w.org.id); expect(mine).toHaveLength(1);
    const d = await detail(w, need.id);
    expect(d.counts.evaluations).toBe(1); expect(d.evaluations).toHaveLength(1);
    const ev = d.evaluations![0]; expect(["atribuido_automatico", "proposto"]).toContain(ev.decision); expect(ev.finalScore).toBeGreaterThanOrEqual(70);
    expect(ev.criteria.map((c) => c.key)).toEqual(expect.arrayContaining(["categoria", "quantidade", "necessidade_urgencia", "horarios_restricoes"]));
    expect(ev.notApplicable).toContain("horarios_restricoes"); expect(ev.criteria.find((c) => c.key === "horarios_restricoes")!.score).toBeNull(); // critério não aplicável aparece SEM número inventado
    expect(ev.allocationId).not.toBeNull(); expect(d.allocations).toHaveLength(1); expect(d.allocations![0].autoMatched).toBe(true);
    expect(stepOf(d, "correspondencia").state).toBe("concluida");
    const rows = await auditOf(w, need.correlationId!);
    const auto = rows.find((r) => r.action === "atribuicao.automatica_alta_confianca" || r.action === "atribuicao.proposta_automatica")!;
    expect(auto).toBeTruthy(); expect(auto.correlationId).toBe(need.correlationId); expect(auto.outcome).toBe(ev.decision === "atribuido_automatico" ? "concluida" : "pendente");
    expect(await db.selectFrom("auditLog").select(["outcome"]).where("action", "=", "matching.executado").executeTakeFirstOrThrow()).toMatchObject({ outcome: "concluida" });
    // repetir a MESMA execução não duplica a atribuição da organização (sem correspondência indevida em duplicidade)
    await postRegistryMatch(post("opportunity-registry-match", w.platform, { opportunityId: offer }));
    expect((await db.selectFrom("opportunityAllocations").select("id").where("organizationId", "=", w.org.id).where("opportunityRegistryId", "=", offer).execute()).length).toBe(1);
  });

  it("recusa da atribuição: decisão registrada (concluída), jornada volta a 'pendente' sem atribuição ativa e nada é re-atribuído sozinho", async () => {
    const w = await world(); const need = await newNeed(w); const allocationId = await allocate(w, await newOffer(w), need.id, 10);
    expect((await decide(w, allocationId, "recusada")).status).toBe(200);
    expect((await decide(w, allocationId, "aceita")).status).toBeGreaterThanOrEqual(400); // transição proibida: já decidida
    const j = (await journeys(w)).items.find((x) => x.needId === need.id)!;
    expect(j.counts.allocations).toEqual({ recusada: 1 }); expect(stepOf(j, "atribuicao").state).toBe("pendente"); expect(stepOf(j, "atribuicao").detail).toMatch(/sem atribuição ativa/); expect(stepOf(j, "recebimento").state).toBe("pendente");
    const rows = await auditOf(w, need.correlationId!); expect(rows.find((r) => r.action === "atribuicao.recusada")).toMatchObject({ outcome: "concluida", correlationId: need.correlationId });
    expect((await db.selectFrom("opportunityAllocations").select("id").where("organizationId", "=", w.org.id).execute()).length).toBe(1);
  });

  it("necessidade encerrada: a jornada mostra 'encerrada', as etapas não se aplicam e uma nova atribuição para ela é recusada", async () => {
    const w = await world(); const need = await newNeed(w);
    const res = await postNeedClosure(post("need-closure", w.admin, { action: "encerrar", organizationId: w.org.id, needId: need.id, reasonCode: "recursos_insuficientes", reasonText: "teste" }));
    expect(res.status, await res.clone().text()).toBe(200);
    const d = await detail(w, need.id);
    expect(d.status).toBe("cancelada"); expect(d.closure).not.toBeNull(); expect(d.next).toBeNull(); expect(stepOf(d, "atribuicao").state).toBe("nao_se_aplica"); expect(d.timeline.some((t) => t.kind === "encerramento")).toBe(true);
    const offer = await newOffer(w);
    expect((await postAllocation(post("opportunity-allocations", w.platform, { opportunityId: offer, organizationId: w.org.id, quantityAllocated: 5, needId: need.id }))).status).toBeGreaterThanOrEqual(400);
    expect((await auditOf(w, need.correlationId!)).find((r) => r.action === "necessidade.encerrada")).toMatchObject({ outcome: "concluida", correlationId: need.correlationId });
  });

  it("necessidade ANTERIOR à M40 (sem correlação): a jornada funciona, diz que não há correlação e nenhuma é fabricada", async () => {
    const w = await world(); const need = await newNeed(w);
    await db.updateTable("needs").set({ correlationId: null }).where("id", "=", need.id).execute(); // fixture de "linha antiga"
    const allocationId = await allocate(w, await newOffer(w), need.id, 5); await decide(w, allocationId, "aceita");
    const d = await detail(w, need.id);
    expect(d.audit).toMatchObject({ correlationId: null, entries: null, path: null }); expect((await journeys(w)).items.find((x) => x.needId === need.id)!.hasCorrelation).toBe(false);
    const al = await db.selectFrom("auditLog").select(["outcome", "correlationId"]).where("action", "=", "atribuicao.aceita").executeTakeFirstOrThrow();
    expect(al).toMatchObject({ outcome: "concluida", correlationId: null }); // resultado sim; correlação não inventada
  });

  it("regressão dos agentes: eventos válidos da jornada ganham correlação e o motor os processa sem falha (simulação); evento anterior à ativação não é processado retroativamente", async () => {
    const w = await world();
    for (const agent of ["sentinela-integridade", "risk-engine"]) expect((await postAgentEnable(post("agents-enable", w.owner, { organizationId: w.org.id, agent, enabled: true }))).status).toBe(200);
    await wait(30); // os eventos da jornada nascem DEPOIS da ativação (regra da M36: nada é retroativo)
    const need = await newNeed(w); const allocationId = await allocate(w, await newOffer(w), need.id, 30);
    await decide(w, allocationId, "aceita"); await receive(w, allocationId, 10);
    const evs = await db.selectFrom("domainEvents").select(["eventType", "correlationId"]).where("organizationId", "=", w.org.id).execute();
    expect(evs.map((e) => e.eventType)).toEqual(expect.arrayContaining(["allocation.received"])); // o recebimento de atribuição publica o evento próprio (não o de lançamento manual)
    expect(evs.every((e) => isCorrelationId(e.correlationId))).toBe(true);
    await runAgentEventEngine({ organizationId: w.org.id });
    const runs = await db.selectFrom("agentEventRuns").select(["status", "correlationId", "eventType"]).where("organizationId", "=", w.org.id).execute();
    expect(runs.length).toBeGreaterThan(0); expect(runs.some((r) => r.status === "falha")).toBe(false); expect(runs.every((r) => r.correlationId !== null)).toBe(true);
    expect((await verifyAuditLogChain()).integra).toBe(true);
  });
});

describe("Permissões, isolamento entre organizações e leitura", () => {
  it("o servidor decide o que cada papel vê: voluntário (sem estoque/relatório/auditoria), operador (estoque, sem relatório/auditoria), administrador (tudo)", async () => {
    const w = await world(); const need = await newNeed(w); const allocationId = await allocate(w, await newOffer(w), need.id, 20); await decide(w, allocationId, "aceita"); await receive(w, allocationId, 20); await destine(w, need.id, 5);
    const vol = await detail(w, need.id, w.volunteer);
    expect(vol.access).toEqual({ network: true, stock: false, opportunities: true, report: false, audit: false });
    expect(vol.destinations).toBeNull(); expect(vol.audit).toBeNull(); expect(stepOf(vol, "prestacao").state).toBe("restrita"); expect(vol.attendance.attended).toBe(5); // atendimento derivado é público para membros (mesma regra de needs_GET)
    expect(vol.timeline.some((t) => t.kind === "destinacao")).toBe(false); // a seção restrita não vaza pela linha do tempo
    const op = await detail(w, need.id, w.operator); expect(op.access).toMatchObject({ stock: true, report: false, audit: false }); expect(op.destinations).toHaveLength(1); expect(op.audit).toBeNull();
    const ad = await detail(w, need.id, w.admin); expect(ad.access).toEqual({ network: true, stock: true, opportunities: true, report: true, audit: true }); expect(ad.audit!.entries).toBeGreaterThan(0);
    const list = await journeys(w, w.volunteer); expect(list.access.stock).toBe(false); expect(list.items[0].counts.destinations).toBe(1);
  });

  it("sem sessão 401; sem vínculo/outra organização 403; necessidade de OUTRA organização e inexistente 404; parâmetros inválidos 400; nada vaza", async () => {
    const w = await world(); const need = await newNeed(w);
    expect((await getJourneys(get(`journeys?organizationId=${w.org.id}`))).status).toBe(401); expect((await getJourney(get(`journey?organizationId=${w.org.id}&needId=${need.id}`))).status).toBe(401);
    expect((await getJourneys(get(`journeys?organizationId=${w.org.id}`, w.otherOwner))).status).toBe(403);
    expect((await getJourney(get(`journey?organizationId=${w.org.id}&needId=${need.id}`, w.otherOwner))).status).toBe(403);
    const foreign = await getJourney(get(`journey?organizationId=${w.otherOrg.id}&needId=${need.id}`, w.otherOwner)); expect(foreign.status).toBe(404); expect(await foreign.text()).not.toContain("Cobertores"); // mesma resposta de inexistente
    expect((await getJourney(get(`journey?organizationId=${w.org.id}&needId=999999`, w.owner))).status).toBe(404);
    for (const bad of ["needId=abc", "needId=0", "needId=-1"]) expect((await getJourney(get(`journey?organizationId=${w.org.id}&${bad}`, w.owner))).status, bad).toBe(400);
    for (const bad of ["status=inventada", "limit=0", "limit=999", "cursor=abc"]) expect((await getJourneys(get(`journeys?organizationId=${w.org.id}&${bad}`, w.owner))).status, bad).toBe(400);
    expect((await journeys(w, w.otherOwner, w.otherOrg.id)).items).toEqual([]); // a outra organização não vê a necessidade
  });

  it("paginação por cursor e filtro de situação: sem duplicar nem omitir; necessidade nova durante a leitura não desloca a página", async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) await newNeed(w, { title: `Necessidade ${i + 1}` });
    const p1 = await parseJson<{ items: JourneyItem[]; nextCursor: string | null }>(await getJourneys(get(`journeys?organizationId=${w.org.id}&limit=2`, w.owner)));
    expect(p1.items).toHaveLength(2); expect(p1.nextCursor).toMatch(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z_1_\d+$/); // cursor opaco: criado em + tipo + id
    await newNeed(w, { title: "Chegou durante a leitura" });
    const p2 = await parseJson<{ items: JourneyItem[]; nextCursor: string | null }>(await getJourneys(get(`journeys?organizationId=${w.org.id}&limit=2&cursor=${p1.nextCursor}`, w.owner)));
    const p3 = await parseJson<{ items: JourneyItem[]; nextCursor: string | null }>(await getJourneys(get(`journeys?organizationId=${w.org.id}&limit=2&cursor=${p2.nextCursor}`, w.owner)));
    const ids = [...p1.items, ...p2.items, ...p3.items].map((i) => i.needId); expect(new Set(ids).size).toBe(ids.length); expect(ids).toHaveLength(5); expect(p3.nextCursor).toBeNull();
    expect((await parseJson<{ items: JourneyItem[] }>(await getJourneys(get(`journeys?organizationId=${w.org.id}&status=cancelada`, w.owner)))).items).toEqual([]);
  });
});

describe("Quantidades, concorrência, rollback e falha de auditoria", () => {
  afterEach(async () => { await sql`DROP TRIGGER IF EXISTS m40_fail_audit_trg ON audit_log`.execute(db); await sql`DROP FUNCTION IF EXISTS m40_fail_audit()`.execute(db); });
  const installAuditFailure = async (action: string) => {
    await sql.raw(`CREATE OR REPLACE FUNCTION m40_fail_audit() RETURNS trigger AS $f$ BEGIN IF NEW.action = '${action}' THEN RAISE EXCEPTION 'falha injetada na auditoria'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`).execute(db);
    await sql.raw("CREATE TRIGGER m40_fail_audit_trg BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION m40_fail_audit()").execute(db);
  };

  it("quantidades inválidas e insuficientes são recusadas sem alterar nada; o estoque nunca fica negativo", async () => {
    const w = await world(); const need = await newNeed(w); const allocationId = await allocate(w, await newOffer(w), need.id, 20); await decide(w, allocationId, "aceita"); await receive(w, allocationId, 20);
    const snap = async () => JSON.stringify([await stockOf(w), (await db.selectFrom("stockDestinations").select("id").execute()).length, (await db.selectFrom("needFulfillments").select("id").execute()).length, (await db.selectFrom("auditLog").select("id").execute()).length]);
    const before = await snap();
    for (const q of [0, -3, "abc", 1e13, 0.0004]) expect((await destine(w, need.id, q as never)).status, `destinar ${q}`).toBe(400);
    for (const q of [0, -1, "x", 1e13]) expect((await receive(w, allocationId, q as never)).status, `receber ${q}`).toBe(400);
    expect((await destine(w, need.id, 21)).status).toBeGreaterThanOrEqual(400); // saldo é 20: insuficiente
    expect((await destine(w, 999999)).status).toBeGreaterThanOrEqual(400); // necessidade inexistente
    expect((await destine(w, need.id, 1, {}, w.volunteer)).status).toBe(403); // voluntário não lança
    expect((await destine(w, need.id, 1, {}, w.otherOwner)).status).toBe(403); // outra organização
    expect(await snap()).toBe(before); expect(await stockOf(w)).toBe(20);
  });

  it("duas saídas de alto risco pedidas e APROVADAS ao mesmo tempo sobre o mesmo saldo: só uma baixa o estoque, a outra é recusada; saldo, ledger e auditoria fecham (invariante, não temporização)", async () => {
    const w = await world(); const need = await newNeed(w, { quantityNeeded: 100 }); const allocationId = await allocate(w, await newOffer(w, { quantity: "100" }), need.id, 40); await decide(w, allocationId, "aceita"); await receive(w, allocationId, 40);
    const [r1, r2] = await Promise.all([destine(w, need.id, 30), destine(w, need.id, 30, {}, w.admin)]);
    expect([r1.status, r2.status]).toEqual([202, 202]); // 75% do saldo cada: ambas aguardam a segunda aprovação, nada baixou
    expect(await stockOf(w)).toBe(40);
    const ids = [(await parseJson<{ approvalRequestId: number }>(r1)).approvalRequestId, (await parseJson<{ approvalRequestId: number }>(r2)).approvalRequestId];
    expect((await detail(w, need.id)).pendingApprovals).toHaveLength(2);
    // as duas aprovações disputam o MESMO saldo: o pedido de r1 é aprovado pelo administrador e o de r2 pelo proprietário, simultaneamente
    const decided = await Promise.all([postApprovalDecide(post("approval-requests-decide", w.admin, { organizationId: w.org.id, requestId: ids[0], decision: "aprovada" })), postApprovalDecide(post("approval-requests-decide", w.owner, { organizationId: w.org.id, requestId: ids[1], decision: "aprovada" }))]);
    const statuses = decided.map((r) => r.status);
    expect(statuses.filter((x) => x === 200)).toHaveLength(1); expect(statuses.filter((x) => x >= 400)).toHaveLength(1); // saldo 40: só uma de 30 cabe
    expect(await stockOf(w)).toBe(10);
    expect((await db.selectFrom("stockDestinations").select("quantity").where("organizationId", "=", w.org.id).where("entryType", "=", "original").execute()).map((d) => Number(d.quantity))).toEqual([30]);
    expect((await detail(w, need.id)).attendance.attended).toBe(30);
    expect((await auditOf(w, need.correlationId!)).filter((r) => r.action === "destinacao.registrada")).toHaveLength(1);
    // a MESMA solicitação (mesma chave), dentro do limite de risco, em paralelo: uma única saída
    const k = key(); const same = await Promise.all([destine(w, need.id, 2, { idempotencyKey: k }), destine(w, need.id, 2, { idempotencyKey: k })]);
    expect(same.every((r) => r.status === 200)).toBe(true); expect(await stockOf(w)).toBe(8);
    expect((await verifyAuditLogChain()).integra).toBe(true);
  });

  it("falha de auditoria durante a destinação: ROLLBACK total (sem saída, sem destinação, sem registro de conclusão); sem a falha, a repetição com a mesma chave conclui uma única vez", async () => {
    const w = await world(); const need = await newNeed(w); const allocationId = await allocate(w, await newOffer(w), need.id, 10); await decide(w, allocationId, "aceita"); await receive(w, allocationId, 20);
    const k = key(); await installAuditFailure("destinacao.registrada");
    const bad = await destine(w, need.id, 4, { idempotencyKey: k }); expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(await stockOf(w)).toBe(20); expect(await db.selectFrom("stockDestinations").select("id").execute()).toHaveLength(0);
    expect((await auditOf(w, need.correlationId!)).filter((r) => r.action === "destinacao.registrada" || r.action === "inventario.saida_registrada")).toHaveLength(0); // nenhuma 'conclusão' de operação inexistente
    await sql`DROP TRIGGER m40_fail_audit_trg ON audit_log`.execute(db);
    expect((await destine(w, need.id, 4, { idempotencyKey: k })).status).toBe(200); expect(await stockOf(w)).toBe(16);
    expect((await destine(w, need.id, 4, { idempotencyKey: k })).status).toBe(200); expect(await stockOf(w)).toBe(16); expect(await db.selectFrom("stockDestinations").select("id").execute()).toHaveLength(1);
  });

  it("falha de auditoria no cadastro da necessidade e no recebimento: nada fica pela metade", async () => {
    const w = await world();
    await installAuditFailure("necessidade.criada");
    expect((await postNeed(post("needs", w.owner, { organizationId: w.org.id, title: "Não deve existir", quantityNeeded: 5, unit: "unidade", priority: "media" }))).status).toBeGreaterThanOrEqual(400);
    expect(await db.selectFrom("needs").select("id").where("title", "=", "Não deve existir").execute()).toHaveLength(0);
    await sql`DROP TRIGGER m40_fail_audit_trg ON audit_log`.execute(db);
    const need = await newNeed(w); const allocationId = await allocate(w, await newOffer(w), need.id, 10); await decide(w, allocationId, "aceita");
    await installAuditFailure("atribuicao.recebida");
    expect((await receive(w, allocationId, 5)).status).toBeGreaterThanOrEqual(400);
    expect(await stockOf(w)).toBe(0); expect(await db.selectFrom("needFulfillments").select("id").execute()).toHaveLength(0);
    expect((await db.selectFrom("opportunityAllocations").select("status").where("id", "=", allocationId).executeTakeFirstOrThrow()).status).toBe("aceita"); // a atribuição NÃO virou 'recebida'
    await sql`DROP TRIGGER m40_fail_audit_trg ON audit_log`.execute(db);
    expect((await receive(w, allocationId, 5)).status).toBe(200); expect(await stockOf(w)).toBe(5);
  });
});
