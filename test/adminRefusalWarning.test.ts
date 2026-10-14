/**
 * Fase 98 — visibilidade administrativa de recusas anteriores. A consulta usada pela tela (opportunity-allocation-refusals_GET) lê o histórico no banco; a atribuição
 * manual (opportunity-allocations_POST) exige confirmação EXPLÍCITA quando a organização já recusou/cancelou a oportunidade (o servidor valida, não só a tela), continua
 * restrita ao admin da plataforma e deixa a confirmação na auditoria. Expiração (prazo/reserva) não é recusa e não pede confirmação.
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { handle as refusalsGet } from "../src/endpoints/opportunity-allocation-refusals_GET";
import { handle as allocate } from "../src/endpoints/opportunity-allocations_POST";
import { handle as decideHandle } from "../src/endpoints/allocations-decide_POST";
import { handle as logisticsHandle } from "../src/endpoints/allocations-logistics_POST";
import { createAuthenticatedUser, createPlatformAdmin, createTestOrganization, createTestSource, createTestOpportunityRegistry, buildRequest, parseJson } from "./helpers";

async function world() {
  const a = await createPlatformAdmin(); const source = await createTestSource(a.userId);
  const mkOrg = async () => { const owner = await createAuthenticatedUser(); return { owner, org: await createTestOrganization(owner.userId) }; };
  const o = await createTestOpportunityRegistry(source.id, a.userId, { status: "reservada" });
  return { admin: a, oppId: o.id, A: await mkOrg(), B: await mkOrg() };
}
type W = Awaited<ReturnType<typeof world>>;
const refusals = (w: W, orgId: number, cookie = w.admin.cookie, oppId = w.oppId) =>
  refusalsGet(buildRequest(`opportunity-allocation-refusals?opportunityId=${oppId}&organizationId=${orgId}`, { cookie }));
const manual = (w: W, orgId: number, extra: Record<string, unknown> = {}, cookie = w.admin.cookie) =>
  allocate(buildRequest("opportunity-allocations", { method: "POST", cookie, body: { opportunityId: w.oppId, organizationId: orgId, quantityAllocated: 5, ...extra } }));
const proposal = async (w: W, orgId: number) => (await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: w.oppId, organizationId: orgId, status: "proposta", quantityAllocated: "5", autoMatched: true }).returning("id").execute())[0].id;
const countAllocs = async (w: W, orgId: number) => (await db.selectFrom("opportunityAllocations").select("id").where("opportunityRegistryId", "=", w.oppId).where("organizationId", "=", orgId).execute()).length;

describe("consulta do histórico de recusas (alimenta o aviso da tela)", () => {
  it("recusa explícita e cancelamento explícito aparecem; sem histórico, expiração por prazo e reserva vencida NÃO aparecem", async () => {
    const w = await world();
    expect((await parseJson<{ refusals: unknown[] }>(await refusals(w, w.A.org.id))).refusals).toEqual([]); // sem histórico

    const refused = await proposal(w, w.A.org.id);
    expect((await decideHandle(buildRequest("allocations-decide", { method: "POST", cookie: w.A.owner.cookie, body: { organizationId: w.A.org.id, allocationId: refused, decision: "recusada" } }))).status).toBe(200);
    const r1 = await parseJson<{ refusals: Array<{ allocationId: number; kind: string; occurredAt: string }> }>(await refusals(w, w.A.org.id));
    expect(r1.refusals).toHaveLength(1);
    expect(r1.refusals[0]).toMatchObject({ allocationId: refused, kind: "recusada" });
    expect(Number.isNaN(Date.parse(r1.refusals[0].occurredAt))).toBe(false);

    const [acc] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: w.oppId, organizationId: w.B.org.id, status: "aceita", quantityAllocated: "5" }).returning("id").execute();
    expect((await logisticsHandle(buildRequest("allocations-logistics", { method: "POST", cookie: w.B.owner.cookie, body: { organizationId: w.B.org.id, allocationId: acc.id, eventType: "cancelado" } }))).status).toBe(200);
    expect((await parseJson<{ refusals: Array<{ kind: string }> }>(await refusals(w, w.B.org.id))).refusals.map((x) => x.kind)).toEqual(["cancelada"]);

    const C = await (async () => { const owner = await createAuthenticatedUser(); return { owner, org: await createTestOrganization(owner.userId) }; })();
    await db.insertInto("opportunityAllocations").values([
      { opportunityRegistryId: w.oppId, organizationId: C.org.id, status: "cancelada", quantityAllocated: "5", closedReason: "prazo_expirado", closedAt: new Date() },
      { opportunityRegistryId: w.oppId, organizationId: C.org.id, status: "cancelada", quantityAllocated: "5", closedReason: "reserva_expirada", closedAt: new Date() },
    ] as never);
    expect((await parseJson<{ refusals: unknown[] }>(await refusals(w, C.org.id))).refusals).toEqual([]); // expirar não é recusar
  });

  it("restrita ao admin da plataforma, ao par consultado (sem vazar outras organizações) e sem sessão", async () => {
    const w = await world();
    await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: w.oppId, organizationId: w.A.org.id, status: "recusada", quantityAllocated: "5" }).execute();
    expect((await refusals(w, w.A.org.id, w.A.owner.cookie)).status).toBe(403); // a própria organização não usa esta consulta administrativa
    expect((await refusals(w, w.A.org.id, "")).status).toBe(401);
    expect((await parseJson<{ refusals: unknown[] }>(await refusals(w, w.B.org.id))).refusals).toEqual([]); // consulta de B não traz o histórico de A
    expect((await refusals(w, 0 as never)).status).toBe(400);
  });
});

describe("atribuição manual após recusa: confirmação explícita validada no servidor", () => {
  it("sem confirmação: 409 com código próprio e NADA é gravado; com confirmação: segue e a auditoria registra a confirmação e as recusas anteriores", async () => {
    const w = await world();
    const refused = await proposal(w, w.A.org.id);
    await db.updateTable("opportunityAllocations").set({ status: "recusada" }).where("id", "=", refused).execute();
    const before = await countAllocs(w, w.A.org.id);

    const blocked = await manual(w, w.A.org.id);
    expect(blocked.status).toBe(409);
    expect(await parseJson(blocked)).toMatchObject({ code: "recusa_anterior_requer_confirmacao" });
    expect(await countAllocs(w, w.A.org.id)).toBe(before);
    expect((await manual(w, w.A.org.id, { confirmPriorRefusal: false })).status).toBe(409);

    const ok = await manual(w, w.A.org.id, { confirmPriorRefusal: true });
    expect(ok.status).toBe(200);
    expect(await countAllocs(w, w.A.org.id)).toBe(before + 1);
    const audit = await db.selectFrom("auditLog").select("metadata").where("action", "=", "atribuicao.proposta").where("organizationId", "=", w.A.org.id).executeTakeFirstOrThrow();
    expect(audit.metadata).toMatchObject({ reatribuicaoAposRecusaExplicita: true, confirmacaoExplicitaDoAdministrador: true, atribuicoesRecusadasAnteriores: [{ id: refused, status: "recusada" }] });
  });

  it("organização sem histórico não precisa de confirmação (e a marca de recusa não aparece); a confirmação não contorna o RBAC (dono da organização continua com 403)", async () => {
    const w = await world();
    const ok = await manual(w, w.B.org.id);
    expect(ok.status).toBe(200);
    const audit = await db.selectFrom("auditLog").select("metadata").where("action", "=", "atribuicao.proposta").where("organizationId", "=", w.B.org.id).executeTakeFirstOrThrow();
    expect(audit.metadata).not.toHaveProperty("reatribuicaoAposRecusaExplicita");
    expect((await manual(w, w.A.org.id, { confirmPriorRefusal: true }, w.A.owner.cookie)).status).toBe(403);
    expect((await manual(w, w.A.org.id, { confirmPriorRefusal: true }, "")).status).toBe(401);
    expect(await countAllocs(w, w.A.org.id)).toBe(0);
  });

  it("expiração por prazo/reserva (não é recusa) não exige confirmação", async () => {
    const w = await world();
    await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: w.oppId, organizationId: w.A.org.id, status: "cancelada", quantityAllocated: "5", closedReason: "prazo_expirado", closedAt: new Date() } as never).execute();
    expect((await manual(w, w.A.org.id)).status).toBe(200);
  });
});
