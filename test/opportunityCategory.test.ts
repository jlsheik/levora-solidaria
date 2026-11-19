/**
 * M37 — correção autorizada da CATEGORIA da oportunidade e sua integração com a reavaliação do Risk Engine (serviços reais, PostgreSQL de teste).
 * Cobre: cadastro sem categoria (regra atual preservada), edição com permissão/organização/estado/versão, histórico e auditoria sem valores, concorrência determinística (duas edições, edição durante a
 * conclusão da avaliação, reavaliação durante edição), pausa, agente desligado, regra temporal de ativação, idempotência e regressão.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "../src/helpers/db";
import { ensureAgentPrincipal } from "../src/helpers/agentRegistry";
import { runAgentEventEngine } from "../src/helpers/agentEventEngine";
import { TOOL_TEST_HOOKS } from "../src/helpers/agentTools";
import { setAutomationControl } from "../src/helpers/automationControls";
import { parseCategory, isCategoryEditable } from "../src/helpers/opportunityCategory";
import { verifyAuditLogChain } from "../src/helpers/verifyAuditChain";
import { handle as postOpportunity } from "../src/endpoints/opportunities_POST";
import { handle as postStatus } from "../src/endpoints/opportunities-status_POST";
import { handle as getOpportunities } from "../src/endpoints/opportunities_GET";
import { handle as postCategory } from "../src/endpoints/opportunities-category_POST";
import { handle as getChanges } from "../src/endpoints/opportunity-changes_GET";
import { handle as postReevaluate } from "../src/endpoints/agent-event-reevaluate_POST";
import { handle as getRuns } from "../src/endpoints/agent-events_GET";
import type { MembershipRole } from "../src/helpers/schema";
import { createAuthenticatedUser, createTestOrganization, addMembership, buildRequest, parseJson, type AuthenticatedTestUser } from "./helpers";

const get = (p: string, a?: AuthenticatedTestUser) => buildRequest(p, { cookie: a?.cookie });
const post = (p: string, a: AuthenticatedTestUser | undefined, body: unknown) => buildRequest(p, { method: "POST", cookie: a?.cookie, body });
async function member(orgId: number, role: MembershipRole) { const u = await createAuthenticatedUser(); await addMembership(orgId, u.userId, role); return u; }
const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

type OppList = { categorySuggestions: Array<{ value: string; source: string }>; canSeeAssessment: boolean; opportunities: Array<{ id: number; category: string | null; version: number; canEditCategory: boolean; assessment: null | { runId: string; status: string; completeness: string | null; decision: string | null; reevaluation: string | null } }> };
type Detail = { detail: { run: { status: string }; explanation: null | { decision: string; facts: Record<string, unknown>; previous: Array<{ decision: string }>; supplement?: { sources: Array<{ recordVersion?: number; field: string }> } }; related: null | { id: number; currentCategory: string | null; version: number; categoryConsidered: string | null; categoryChangedSinceDecision: boolean; lastCategoryChange: null | { byName: string | null } } } };

describe("parseCategory (forma, sem catálogo inventado)", () => {
  it("aceita texto válido normalizado e recusa vazio, curto, longo e caracteres estranhos", () => {
    expect(parseCategory("  Roupa   de  inverno ")).toEqual({ ok: true, value: "Roupa de inverno" });
    expect(parseCategory("alimento_perecivel").ok).toBe(true); expect(parseCategory("higiene/limpeza").ok).toBe(true);
    for (const bad of ["", " ", "a", "x".repeat(61), "<script>", "-roupa", "roupa;drop", 42, null, undefined]) expect(parseCategory(bad).ok).toBe(false);
  });
  it("só os estados não finais permitem a edição", () => {
    expect(["registrada", "em_contato", "confirmada"].every((s) => isCategoryEditable(s as never))).toBe(true);
    expect(isCategoryEditable("recebida")).toBe(false); expect(isCategoryEditable("cancelada")).toBe(false);
  });
});

describe("jornada: oportunidade sem categoria → correção → nova análise (sem SQL manual)", () => {
  let owner: AuthenticatedTestUser; let orgId: number; let principalId: number;
  beforeEach(async () => { owner = await createAuthenticatedUser(); orgId = (await createTestOrganization(owner.userId)).id; principalId = (await ensureAgentPrincipal(db, "risk-engine", orgId)).id; await wait(); });
  afterEach(() => { TOOL_TEST_HOOKS.afterFence = undefined; });

  const create = async (extra: Record<string, unknown> = {}) => {
    const res = await postOpportunity(post("opportunities", owner, { organizationId: orgId, title: "Oferta sintética", donorName: "Doador Sintético", quantityOffered: 3, unit: "kg", ...extra }));
    expect(res.status).toBe(200);
    return (await db.selectFrom("donationOpportunities").select(["id", "version"]).where("organizationId", "=", orgId).orderBy("id", "desc").executeTakeFirstOrThrow());
  };
  const list = async (who = owner, org = orgId) => parseJson<OppList>(await getOpportunities(get(`opportunities?organizationId=${org}`, who)));
  const edit = (opp: number, category: string, version: number, who: AuthenticatedTestUser | null = owner, org = orgId, extra: Record<string, unknown> = {}) => postCategory(post("opportunities-category", who ?? undefined, { organizationId: org, opportunityId: opp, category, expectedVersion: version, ...extra }));
  const reevaluate = (runId: string, who = owner) => postReevaluate(post("agent-event-reevaluate", who, { organizationId: orgId, runId }));
  const runOf = (oppId: number) => db.selectFrom("agentEventRuns as r").innerJoin("domainEvents as e", "e.id", "r.eventId").select(["r.id", "r.status", "r.detail"]).where("e.entityId", "=", String(oppId)).where("e.eventType", "=", "opportunity.created").orderBy("r.id", "desc").executeTakeFirst();
  const detail = async (runId: string) => parseJson<Detail>(await getRuns(get(`agent-events?organizationId=${orgId}&runId=${runId}`, owner)));
  async function insufficient() { const opp = await create(); await runAgentEventEngine({ organizationId: orgId }); const run = (await runOf(opp.id))!; expect(run.status).toBe("dados_insuficientes"); return { opp, runId: String(run.id) }; }

  it("A cadastro SEM categoria continua permitido (regra atual); o Risk Engine registra dados insuficientes; a lista mostra a avaliação só a quem lê a automação", async () => {
    const { opp, runId } = await insufficient();
    const l = await list(); const row = l.opportunities.find((o) => o.id === opp.id)!;
    expect(row).toMatchObject({ category: null, version: 1, canEditCategory: true }); expect(row.assessment).toMatchObject({ runId, status: "dados_insuficientes", completeness: "insuficiente", reevaluation: "ainda_insuficiente" });
    expect(l.canSeeAssessment).toBe(true);
    const operator = await member(orgId, "operador"); const lo = await list(operator);
    expect(lo.canSeeAssessment).toBe(false); expect(lo.opportunities[0].assessment).toBeNull(); expect(lo.opportunities[0].canEditCategory).toBe(true); // operador edita (oportunidades.gerencie) mas não vê a análise
    const vol = await member(orgId, "voluntario"); const lv = await list(vol); expect(lv.opportunities[0].canEditCategory).toBe(false); expect(lv.opportunities[0].assessment).toBeNull();
  });

  it("B+C correção autorizada → persistida com versão, histórico e auditoria SEM valores; a edição NÃO publica evento nem reavalia; o pedido separado reavalia com a categoria persistida e preserva a avaliação anterior", async () => {
    const { opp, runId } = await insufficient();
    const eventsBefore = (await db.selectFrom("domainEvents").select("id").execute()).length; const runsBefore = (await db.selectFrom("agentEventRuns").select("id").execute()).length;
    const res = await edit(opp.id, "Roupa", 1, owner, orgId, { reason: "Categoria conferida com o doador" });
    expect(res.status).toBe(200);
    const out = await parseJson<{ opportunity: { category: string; version: number }; changed: boolean; correlationId: string; reevaluation: { available: boolean; runId: string } }>(res);
    expect(out).toMatchObject({ opportunity: { category: "Roupa", version: 2 }, changed: true }); expect(out.reevaluation).toEqual({ available: true, runId });
    // nada disparou sozinho
    expect((await db.selectFrom("domainEvents").select("id").execute()).length).toBe(eventsBefore); expect((await db.selectFrom("agentEventRuns").select("id").execute()).length).toBe(runsBefore);
    expect((await runOf(opp.id))!.status).toBe("dados_insuficientes");
    // histórico do recurso (de/para) e auditoria sem valores
    const ch = await db.selectFrom("opportunityChanges").selectAll().where("opportunityId", "=", opp.id).execute();
    expect(ch).toHaveLength(1); expect(ch[0]).toMatchObject({ field: "category", previousValue: null, newValue: "Roupa", versionBefore: 1, versionAfter: 2, changedByUserId: owner.userId, correlationId: out.correlationId, reason: "Categoria conferida com o doador" });
    const audit = await db.selectFrom("auditLog").select(["actorUserId", "metadata"]).where("action", "=", "oportunidade.categoria_alterada").where("entityId", "=", String(opp.id)).executeTakeFirstOrThrow();
    expect(audit.actorUserId).toBe(owner.userId); expect(audit.metadata).toMatchObject({ campo: "category", versaoAnterior: 1, versaoNova: 2, correlacao: out.correlationId, motivoInformado: true }); expect(JSON.stringify(audit.metadata)).not.toMatch(/Roupa|conferida/);
    await expect(db.updateTable("opportunityChanges").set({ newValue: "x" }).where("opportunityId", "=", opp.id).execute()).rejects.toThrow();
    // nova análise (pedido explícito)
    const rr = await reevaluate(runId); expect(rr.status).toBe(200);
    expect(await parseJson<{ newStatus: string; newDecision: string }>(rr)).toMatchObject({ newStatus: "simulacao_concluida", newDecision: "permitido" });
    const d = await detail(runId);
    expect(d.detail.explanation!.facts).toMatchObject({ categoria: "roupa", origemCategoria: "registro da oportunidade (versão 2)" });
    expect(d.detail.explanation!.previous.map((p) => p.decision)).toContain("dados_insuficientes"); // avaliação anterior preservada
    expect(d.detail.explanation!.supplement!.sources[0]).toMatchObject({ field: "category", recordVersion: 2 });
    expect(d.detail.related).toMatchObject({ id: opp.id, currentCategory: "Roupa", version: 2, categoryChangedSinceDecision: false }); expect(d.detail.related!.lastCategoryChange!.byName).toBeTruthy();
    const l = await list(); expect(l.opportunities.find((o) => o.id === opp.id)!.assessment).toMatchObject({ status: "simulacao_concluida", decision: "permitido", categoryConsidered: "roupa" });
    expect((await verifyAuditLogChain()).integra).toBe(true);
  });

  it("categoria de alto risco informada na correção: a nova análise vai para a FILA DE EXCEÇÕES (não conclui)", async () => {
    const { opp, runId } = await insufficient(); await edit(opp.id, "medicamento", 1);
    expect(await parseJson<{ newStatus: string }>(await reevaluate(runId))).toMatchObject({ newStatus: "aguardando_aprovacao" });
    expect((await db.selectFrom("exceptionQueue").select("id").where("organizationId", "=", orgId).execute()).length).toBe(1);
  });

  it("mesma categoria enviada de novo: sem alteração (nenhuma versão consumida, nenhuma linha de histórico, nenhuma auditoria nova)", async () => {
    const { opp } = await insufficient(); await edit(opp.id, "Roupa", 1);
    const again = await parseJson<{ changed: boolean; opportunity: { version: number }; correlationId: string | null }>(await edit(opp.id, "Roupa", 2));
    expect(again).toMatchObject({ changed: false, correlationId: null, opportunity: { version: 2 } });
    expect((await db.selectFrom("opportunityChanges").select("id").where("opportunityId", "=", opp.id).execute()).length).toBe(1);
    expect((await db.selectFrom("auditLog").select("id").where("action", "=", "oportunidade.categoria_alterada").execute()).length).toBe(1);
  });

  it("D/E permissões e isolamento: voluntário 403, sem sessão 401, outra organização 403, ID de outra organização 404, categoria inválida 400; nada muda e nada vaza", async () => {
    const { opp } = await insufficient();
    const vol = await member(orgId, "voluntario"); expect((await edit(opp.id, "Roupa", 1, vol)).status).toBe(403);
    expect((await edit(opp.id, "Roupa", 1, null)).status).toBe(401);
    const intruder = await createAuthenticatedUser(); const intruderOrg = (await createTestOrganization(intruder.userId)).id;
    const r1 = await edit(opp.id, "Roupa", 1, intruder, orgId); expect(r1.status).toBe(403); expect(await r1.text()).not.toMatch(/Oferta sintética|Doador/);
    expect((await edit(opp.id, "Roupa", 1, intruder, intruderOrg)).status).toBe(404);
    expect((await getChanges(get(`opportunity-changes?organizationId=${orgId}&opportunityId=${opp.id}`, intruder))).status).toBe(403);
    expect((await getChanges(get(`opportunity-changes?organizationId=${intruderOrg}&opportunityId=${opp.id}`, intruder))).status).toBe(404);
    expect((await edit(opp.id, "<b>", 1)).status).toBe(400); expect((await edit(opp.id, " ", 1)).status).toBe(400);
    expect((await db.selectFrom("donationOpportunities").select(["category", "version"]).where("id", "=", opp.id).executeTakeFirstOrThrow())).toEqual({ category: null, version: 1 });
    expect((await db.selectFrom("opportunityChanges").select("id").execute()).length).toBe(0);
    const operator = await member(orgId, "operador"); expect((await edit(opp.id, "Roupa", 1, operator)).status).toBe(200); // permissão existente oportunidades.gerencie
  });

  it("estado que não permite edição: recebida/cancelada → 409 estado_nao_permite, sem alteração", async () => {
    const a = await create({ title: "Cancelada" });
    expect((await postStatus(post("opportunities-status", owner, { organizationId: orgId, opportunityId: a.id, status: "cancelada" }))).status).toBe(200);
    const cur = await db.selectFrom("donationOpportunities").select("version").where("id", "=", a.id).executeTakeFirstOrThrow();
    const res = await edit(a.id, "Roupa", cur.version); expect(res.status).toBe(409); expect((await parseJson<{ code: string }>(res)).code).toBe("estado_nao_permite");
    const b = await create({ title: "Recebida" }); await db.updateTable("donationOpportunities").set({ status: "recebida" }).where("id", "=", b.id).execute();
    expect((await edit(b.id, "Roupa", 1)).status).toBe(409);
    expect((await db.selectFrom("opportunityChanges").select("id").execute()).length).toBe(0);
  });

  it("F1 versão desatualizada: 409 conflito_de_versao com a versão atual; mudança de status também consome versão", async () => {
    const opp = await create();
    expect((await postStatus(post("opportunities-status", owner, { organizationId: orgId, opportunityId: opp.id, status: "em_contato" }))).status).toBe(200); // outra pessoa mexeu → versão 2
    const res = await edit(opp.id, "Roupa", 1); expect(res.status).toBe(409);
    const body = await parseJson<{ code: string; current: { version: number; status: string } }>(res); expect(body.code).toBe("conflito_de_versao"); expect(body.current).toMatchObject({ version: 2, status: "em_contato" });
    expect((await edit(opp.id, "Roupa", 2)).status).toBe(200);
  });

  it("F2 duas pessoas editam a MESMA versão ao mesmo tempo: uma vence (200), a outra recebe conflito (409); versão final 2; 1 histórico", async () => {
    const opp = await create(); const admin = await member(orgId, "administrador");
    const [a, b] = await Promise.all([edit(opp.id, "Roupa", 1, owner), edit(opp.id, "Calçados", 1, admin)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const row = await db.selectFrom("donationOpportunities").select(["category", "version"]).where("id", "=", opp.id).executeTakeFirstOrThrow(); expect(row.version).toBe(2);
    const ch = await db.selectFrom("opportunityChanges").select(["newValue", "changedByUserId"]).where("opportunityId", "=", opp.id).execute(); expect(ch).toHaveLength(1); expect(ch[0].newValue).toBe(row.category);
  });

  it("F3 categoria muda DURANTE a conclusão da reavaliação: a decisão NÃO usa a versão antiga — a conclusão detecta a mudança, relê e decide com a categoria atual (versão 3)", async () => {
    const { opp, runId } = await insufficient(); await edit(opp.id, "roupa", 1); // versão 2: roupa (permitida)
    let calls = 0; const paused = gate(); const go = gate();
    TOOL_TEST_HOOKS.afterFence = async () => { if (calls++ === 0) { paused.open(); await go.p; } };
    const request = reevaluate(runId); await paused.p; // a conclusão leu 'roupa' (versão 2) e está parada logo depois da cerca
    expect((await edit(opp.id, "medicamento", 2)).status).toBe(200); // outra pessoa corrige para uma categoria de alto risco (versão 3)
    go.open(); const res = await request; expect(res.status).toBe(200);
    expect(await parseJson<{ newStatus: string }>(res)).toMatchObject({ newStatus: "aguardando_aprovacao" }); // NÃO concluiu com 'roupa'
    const d = await detail(runId); expect(d.detail.explanation!.facts).toMatchObject({ categoria: "medicamento", origemCategoria: "registro da oportunidade (versão 3)" });
    expect((await db.selectFrom("agentEventRunHistory").select("id").where("runId", "=", runId).where("toStatus", "=", "simulacao_concluida").execute()).length).toBe(0);
  });

  it("F4 reavaliação pedida ENQUANTO a edição ainda não confirmou: usa só dados confirmados (recusa); depois do commit da edição, passa", async () => {
    const { opp, runId } = await insufficient();
    const editing = gate(); const started = gate();
    const editor = db.transaction().execute(async (trx) => {
      await trx.selectFrom("donationOpportunities").select("id").where("id", "=", opp.id).forUpdate().execute();
      await trx.updateTable("donationOpportunities").set({ category: "roupa", version: 2 }).where("id", "=", opp.id).execute(); started.open(); await editing.p;
    });
    await started.p;
    const during = await reevaluate(runId); expect(during.status).toBe(409); expect((await parseJson<{ code: string }>(during)).code).toBe("dados_ainda_insuficientes"); // a edição não confirmada é invisível
    editing.open(); await editor;
    expect((await reevaluate(runId)).status).toBe(200);
  });

  it("G pausa e H agente desligado: a nova análise respeita (409) mesmo com a categoria corrigida; religar/retomar libera", async () => {
    const { opp, runId } = await insufficient(); await edit(opp.id, "roupa", 1);
    await db.transaction().execute((t) => setAutomationControl(t, { organizationId: orgId, paused: true, emergency: false, userId: owner.userId }));
    expect((await parseJson<{ code: string }>(await reevaluate(runId))).code).toBe("automacao_pausada");
    await db.transaction().execute((t) => setAutomationControl(t, { organizationId: orgId, paused: false, emergency: false, userId: owner.userId }));
    await db.updateTable("agentPrincipals").set({ enabled: false }).where("id", "=", principalId).execute();
    expect((await parseJson<{ code: string }>(await reevaluate(runId))).code).toBe("agente_desligado");
    expect((await runOf(opp.id))!.status).toBe("dados_insuficientes");
    await db.updateTable("agentPrincipals").set({ enabled: true }).where("id", "=", principalId).execute();
    expect((await reevaluate(runId)).status).toBe(200);
  });

  it("I oportunidade anterior à ativação do agente: editar NÃO a processa retroativamente (nenhuma execução existe; nada a reavaliar)", async () => {
    const other = await createAuthenticatedUser(); const org2 = (await createTestOrganization(other.userId)).id;
    await postOpportunity(post("opportunities", other, { organizationId: org2, title: "Antiga sem categoria", donorName: "Doador", quantityOffered: 1, unit: "kg" }));
    const opp = await db.selectFrom("donationOpportunities").select(["id", "version"]).where("organizationId", "=", org2).executeTakeFirstOrThrow();
    await wait(); await ensureAgentPrincipal(db, "risk-engine", org2); await wait();
    const res = await postCategory(post("opportunities-category", other, { organizationId: org2, opportunityId: opp.id, category: "roupa", expectedVersion: opp.version })); expect(res.status).toBe(200);
    expect((await parseJson<{ reevaluation: { available: boolean; runId: string | null } }>(res)).reevaluation).toEqual({ available: false, runId: null });
    expect((await runAgentEventEngine({ organizationId: org2 })).registered).toBe(0);
    expect((await db.selectFrom("agentEventRuns").select("id").where("organizationId", "=", org2).execute()).length).toBe(0);
  });

  it("J idempotência: dois pedidos iguais de nova análise → um conclui, o outro recebe conflito; uma única reavaliação e uma única conclusão", async () => {
    const { opp, runId } = await insufficient(); await edit(opp.id, "roupa", 1);
    const admin = await member(orgId, "administrador");
    const [a, b] = await Promise.all([reevaluate(runId, owner), reevaluate(runId, admin)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await db.selectFrom("agentEventReevaluations").select("outcome").where("runId", "=", runId).execute()).map((r) => r.outcome)).toEqual(["concluida"]);
    expect((await db.selectFrom("agentEventRunHistory").select("id").where("runId", "=", runId).where("toStatus", "=", "simulacao_concluida").execute()).length).toBe(1);
  });

  it("K rastreabilidade: oportunidade, evento original (imutável), avaliação original, correção e reavaliação permanecem ligados; histórico legível pela API", async () => {
    const { opp, runId } = await insufficient();
    const ev = await db.selectFrom("domainEvents").select(["id", "payload"]).where("entityId", "=", String(opp.id)).executeTakeFirstOrThrow();
    await edit(opp.id, "roupa", 1); await reevaluate(runId);
    expect((await db.selectFrom("domainEvents").select("payload").where("id", "=", ev.id).executeTakeFirstOrThrow()).payload).toEqual(ev.payload); // o evento original continua sem categoria
    expect((ev.payload as { category: unknown }).category).toBeNull();
    const ch = await parseJson<{ changes: Array<{ previousValue: string | null; newValue: string; changedByName: string | null; versionAfter: number }> }>(await getChanges(get(`opportunity-changes?organizationId=${orgId}&opportunityId=${opp.id}`, owner)));
    expect(ch.changes).toHaveLength(1); expect(ch.changes[0]).toMatchObject({ previousValue: null, newValue: "roupa", versionAfter: 2 }); expect(ch.changes[0].changedByName).toBeTruthy();
    const re = await db.selectFrom("agentEventReevaluations").select(["previousDecision", "newDecision", "correlationId"]).where("runId", "=", runId).executeTakeFirstOrThrow(); expect(re).toMatchObject({ previousDecision: "dados_insuficientes", newDecision: "permitido" });
    const actions = (await db.selectFrom("auditLog").select("action").where("organizationId", "=", orgId).orderBy("id").execute()).map((a) => a.action);
    expect(actions.indexOf("oportunidade.categoria_alterada")).toBeLessThan(actions.indexOf("agente.reavaliacao_solicitada"));
    expect((await verifyAuditLogChain()).integra).toBe(true);
  });

  it("sugestões de categoria são REAIS (usadas na organização ou com regra na política), sem repetição e sem categoria inventada", async () => {
    await create({ category: "Roupa" }); await create({ category: "roupa" });
    const l = await list(); const values = l.categorySuggestions.map((s) => s.value.toLowerCase());
    expect(values).toContain("medicamento"); expect(values.filter((v) => v === "roupa")).toHaveLength(1);
    expect(l.categorySuggestions.find((s) => s.value === "medicamento")!.source).toBe("politica");
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("paridade cliente × servidor da validação de categoria", () => {
  it("a validação da tela (espelho) e a do servidor (autoridade) concordam em uma bateria de entradas", async () => {
    const { validateCategoryDraft } = await import("../src/components/opportunityCategoryView");
    const inputs = ["", " ", "a", "ab", "Roupa", "  roupa   de inverno ", "x".repeat(60), "x".repeat(61), "alimento_perecivel", "higiene/limpeza", "<b>", "-roupa", "roupa;x", "çãõ É", "12", "a b", "a\tb"];
    for (const raw of inputs) {
      const server = parseCategory(raw); const client = validateCategoryDraft(raw);
      expect(client.ok, JSON.stringify(raw)).toBe(server.ok);
      if (server.ok && client.ok) expect(client.value).toBe(server.value);
    }
  });
});
