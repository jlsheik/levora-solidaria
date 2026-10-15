/**
 * Fase 99C — regularização auditável de unidades no recebimento (PostgreSQL real, banco `_test`).
 * Regra de ouro verificada aqui: unidade sem equivalência comprovada NUNCA vira estoque, ledger ou atendimento por conversão presumida; o recebimento apresentado vira um caso
 * auditável que só se resolve por conferência física validada, correção cadastral comprovada ou encerramento com motivo.
 */
import { describe, it, expect, afterAll } from "vitest";
import postgres from "postgres";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { expireAssignmentDeadlines } from "../src/helpers/expireAssignmentDeadlines";
import { getItemStockBalance } from "../src/helpers/stockBalance";
import { handle as receiveHandle } from "../src/endpoints/allocations-receive_POST";
import { handle as receiveLocalHandle } from "../src/endpoints/opportunities-receive_POST";
import { handle as logisticsHandle } from "../src/endpoints/allocations-logistics_POST";
import { handle as conferHandle } from "../src/endpoints/unit-regularization-confer_POST";
import { handle as validateHandle } from "../src/endpoints/unit-regularization-validate_POST";
import { handle as closeHandle } from "../src/endpoints/unit-regularization-close_POST";
import { handle as correctHandle } from "../src/endpoints/unit-regularization-correct_POST";
import { handle as correctOfferHandle } from "../src/endpoints/unit-regularization-correct-offer_POST";
import { handle as casesHandle } from "../src/endpoints/unit-regularization-cases_GET";
import { handle as platformHandle } from "../src/endpoints/unit-regularization-platform_GET";
import { handle as orgAllocations } from "../src/endpoints/organization-allocations_GET";
import type { OutputType as CasesOut } from "../src/endpoints/unit-regularization-cases_GET.schema";
import { addMembership, buildRequest, createAuthenticatedUser, createPlatformAdmin, createTestInventoryItem, createTestOpportunityRegistry, createTestOrganization, createTestSource, parseJson } from "./helpers";

type Auth = Awaited<ReturnType<typeof createAuthenticatedUser>>;
const side = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
afterAll(async () => { await side.end({ timeout: 5 }); });

const post = (path: string, cookie: string, body: unknown) => buildRequest(path, { method: "POST", cookie, body });

async function network(o: { offerUnit: string | null; itemUnit: string; deadlinePast?: boolean; status?: "aceita" | "em_coleta" | "em_transporte" }) {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const item = await createTestInventoryItem(org.id, owner.userId, { name: "Arroz", unit: o.itemUnit });
  const platform = await createPlatformAdmin();
  const source = await createTestSource(platform.userId);
  const registry = await createTestOpportunityRegistry(source.id, platform.userId, { status: "reservada", unit: o.offerUnit });
  const [allocation] = await db
    .insertInto("opportunityAllocations")
    .values({
      opportunityRegistryId: registry.id,
      organizationId: org.id,
      status: o.status ?? "aceita",
      quantityAllocated: "10",
      autoMatched: o.deadlinePast === true,
      responseDueAt: o.deadlinePast ? sql<Date>`now() - interval '1 hour'` : null,
    })
    .returning("id")
    .execute();
  return { owner, org, item, platform, registryId: registry.id, allocId: allocation.id };
}
type Net = Awaited<ReturnType<typeof network>>;

const receive = (n: Net, cookie = n.owner.cookie, quantityReceived: number | string = 10, itemId = n.item.id) =>
  receiveHandle(post("allocations-receive", cookie, { organizationId: n.org.id, allocationId: n.allocId, itemId, quantityReceived }));
const logistics = (n: Net, eventType: string, cookie = n.owner.cookie) => logisticsHandle(post("allocations-logistics", cookie, { organizationId: n.org.id, allocationId: n.allocId, eventType }));
const confer = (n: Net, caseId: number, body: Record<string, unknown> = {}, cookie = n.owner.cookie) =>
  conferHandle(post("unit-regularization-confer", cookie, { organizationId: n.org.id, caseId, checkedQuantity: 12.5, reason: "Contagem direta de 12,5 kg na balança", ...body }));
const validate = (n: Net, caseId: number, decision: "aprovar" | "devolver" = "aprovar", cookie = n.owner.cookie, note = "") =>
  validateHandle(post("unit-regularization-validate", cookie, { organizationId: n.org.id, caseId, decision, note }));
const closeCase = (n: Net, caseId: number, cookie = n.owner.cookie) =>
  closeHandle(post("unit-regularization-close", cookie, { organizationId: n.org.id, caseId, category: "informacao_insuficiente", reason: "Faltam dados do doador para estabelecer a quantidade." }));
const listCases = async (n: Net, cookie = n.owner.cookie, query = "") => {
  const res = await casesHandle(buildRequest(`unit-regularization-cases?organizationId=${n.org.id}${query}`, { cookie }));
  return res;
};

const stockRows = (itemId: number) => db.selectFrom("stockTransactions").selectAll().where("itemId", "=", itemId).execute();
const ledgerRows = (allocId: number) => db.selectFrom("needFulfillments").selectAll().where("allocationId", "=", allocId).execute();
const caseRows = (allocId: number) => db.selectFrom("unitRegularizationCases").selectAll().where("allocationId", "=", allocId).execute();
const allocStatus = async (id: number) => (await db.selectFrom("opportunityAllocations").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
const events = (caseId: number) => db.selectFrom("unitRegularizationEvents").selectAll().where("caseId", "=", caseId).orderBy("id").execute();
const audits = (action: string, entityId: number) => db.selectFrom("auditLog").select(["actorUserId", "metadata"]).where("action", "=", action).where("entityId", "=", String(entityId)).execute();

async function openCaseFor(n: Net) {
  const res = await receive(n);
  expect(res.status).toBe(202);
  const [c] = await caseRows(n.allocId);
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

describe("recebimento compatível segue o fluxo normal", () => {
  it("18/19: mesma unidade -> entrada de estoque, ledger e status recebida, na unidade do item", async () => {
    const n = await network({ offerUnit: "kg", itemUnit: "kg" });
    const res = await receive(n);
    expect(res.status).toBe(200);
    const stock = await stockRows(n.item.id);
    expect(stock).toHaveLength(1);
    expect(Number(stock[0].delta)).toBe(10);
    const ledger = await ledgerRows(n.allocId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].unit).toBe("kg");
    expect(await allocStatus(n.allocId)).toBe("recebida");
    expect(await caseRows(n.allocId)).toHaveLength(0);
  });

  it("alias comprovado (KG/kg; unidades/unidade) é compatível", async () => {
    for (const [offer, item] of [["KG", "kg"], ["unidades", "unidade"]] as const) {
      const n = await network({ offerUnit: offer, itemUnit: item });
      expect((await receive(n)).status, `${offer} x ${item}`).toBe(200);
      expect(await caseRows(n.allocId)).toHaveLength(0);
    }
  });
});

describe("recebimento com divergência: nada é lançado, o evento não se perde", () => {
  it("20/21/23/27: unidade diferente (caixa × unidade) abre caso e NÃO cria estoque, ledger nem muda o status da atribuição", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "unidade" });
    const res = await receive(n);
    expect(res.status).toBe(202);
    const body = await parseJson<{ pendingRegularization: { caseId: number; created: boolean }; allocation: { status: string } }>(res);
    expect(body.pendingRegularization.created).toBe(true);
    expect(body.allocation.status).toBe("pendente_de_regularizacao");
    expect(await stockRows(n.item.id)).toHaveLength(0);
    expect(await ledgerRows(n.allocId)).toHaveLength(0);
    expect(await allocStatus(n.allocId)).toBe("aceita"); // o recurso ainda não foi lançado
    const [c] = await caseRows(n.allocId);
    expect(c).toMatchObject({ status: "aberto", category: "a_classificar", divergenceKind: "unidade_diferente", offeredUnit: "caixa", itemUnit: "unidade", organizationId: n.org.id });
    expect(Number(c.offeredQuantity)).toBe(10);
    expect(Number(c.informedQuantity)).toBe(10);
    expect((await events(c.id)).map((e) => e.eventType)).toEqual(["aberto"]);
    expect((await audits("regularizacao.caso_aberto", c.id))[0].metadata).toMatchObject({ unidadeOfertada: "caixa", unidadeDoItem: "unidade", quantidadeInformada: 10 });
  });

  it("unidade sem classificação (x × kg) também abre caso, como 'sem equivalência comprovada'", async () => {
    const n = await network({ offerUnit: "x", itemUnit: "kg" });
    expect((await receive(n)).status).toBe(202);
    const [c] = await caseRows(n.allocId);
    expect(c.divergenceKind).toBe("unidade_nao_classificada");
    expect(await stockRows(n.item.id)).toHaveLength(0);
  });

  it("24: retry não cria caso nem estoque duplicados; a resposta é a mesma", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "unidade" });
    expect((await receive(n)).status).toBe(202);
    const second = await receive(n);
    expect(second.status).toBe(202);
    expect((await parseJson<{ pendingRegularization: { created: boolean } }>(second)).pendingRegularization.created).toBe(false);
    expect(await caseRows(n.allocId)).toHaveLength(1);
    expect(await stockRows(n.item.id)).toHaveLength(0);
    const otherItem = await createTestInventoryItem(n.org.id, n.owner.userId, { name: "Outro", unit: "unidade" });
    expect((await receive(n, n.owner.cookie, 10, otherItem.id)).status).toBe(202);
    expect(await caseRows(n.allocId)).toHaveLength(1);
  });

  it("a fila e a atribuição mostram a pendência; a pendência de prazo da Fase 98 não aparece como 'sem movimentação'", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "unidade", deadlinePast: true });
    await receive(n);
    const res = await orgAllocations(buildRequest(`organization-allocations?organizationId=${n.org.id}`, { cookie: n.owner.cookie }));
    const data = await parseJson<{ allocations: Array<{ id: number; pendingRegularizationCaseId: number | null; pendingAction: boolean }> }>(res);
    const row = data.allocations.find((a) => a.id === n.allocId)!;
    expect(row.pendingRegularizationCaseId).not.toBeNull();
    expect(row.pendingAction).toBe(false);
  });
});

describe("conferência física e validação", () => {
  it("22/25: conferir + validar por outra pessoa lança UMA entrada, na unidade do item, com a quantidade conferida (não a ofertada), ledger e status recebida", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "kg" });
    const c = await openCaseFor(n);
    const admin = await createAuthenticatedUser();
    await addMembership(n.org.id, admin.userId, "administrador");
    const operator = await createAuthenticatedUser();
    await addMembership(n.org.id, operator.userId, "operador");

    const conferred = await confer(n, c.id, {}, operator.cookie);
    expect(conferred.status).toBe(200);
    expect((await parseJson<{ status: string }>(conferred)).status).toBe("conferido");
    expect(await stockRows(n.item.id)).toHaveLength(0); // conferido ainda não lança nada
    expect(await allocStatus(n.allocId)).toBe("aceita");

    const validated = await validate(n, c.id, "aprovar", admin.cookie);
    expect(validated.status).toBe(200);
    const stock = await stockRows(n.item.id);
    expect(stock).toHaveLength(1);
    expect(Number(stock[0].delta)).toBe(12.5);
    expect(await getItemStockBalance(db, n.item.id)).toBe(12.5);
    const ledger = await ledgerRows(n.allocId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].unit).toBe("kg");
    expect(Number(ledger[0].quantity)).toBe(12.5);
    expect(await allocStatus(n.allocId)).toBe("recebida");
    const [row] = await caseRows(n.allocId);
    expect(row).toMatchObject({ status: "resolvido", category: "conferencia_fisica", checkedUnit: "kg", withoutSecondValidation: false, conferredByUserId: operator.userId, validatedByUserId: admin.userId });
    expect(String(row.resolvedStockTransactionId)).toBe(String(stock[0].id));
    expect((await events(c.id)).map((e) => e.eventType)).toEqual(["aberto", "conferencia_registrada", "validada_resolvida"]);
    expect((await audits("regularizacao.resolvida", c.id))[0].actorUserId).toBe(admin.userId);
    // 33: caso resolvido não é aplicado de novo
    expect((await validate(n, c.id, "aprovar", admin.cookie)).status).toBe(409);
    expect((await confer(n, c.id)).status).toBe(409);
    expect(await stockRows(n.item.id)).toHaveLength(1);
    // um novo pedido de recebimento da mesma atribuição (já recebida) é recusado como sempre
    expect((await receive(n)).status).toBe(409);
  });

  it("32: quantidade conferida inválida é recusada (negativa, zero, NaN, infinita, 4 casas, texto, acima do máximo) e nada muda", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "kg" });
    const c = await openCaseFor(n);
    for (const bad of [-1, 0, "NaN", "Infinity", 1.2345, "abc", 1e12, null, true, ""]) {
      const res = await confer(n, c.id, { checkedQuantity: bad });
      expect(res.status, String(bad)).toBe(400);
    }
    expect((await confer(n, c.id, { reason: "curto" })).status).toBe(400);
    const [row] = await caseRows(n.allocId);
    expect(row.status).toBe("aberto");
    expect(row.checkedQuantity).toBeNull();
    expect(await stockRows(n.item.id)).toHaveLength(0);
  });

  it("quem conferiu não valida a própria conferência quando há outro administrador; sem outro elegível, a validação no mesmo ato é aceita e marcada", async () => {
    const solo = await network({ offerUnit: "caixa", itemUnit: "kg" });
    const c1 = await openCaseFor(solo);
    const done = await confer(solo, c1.id, { validateNow: true });
    expect((await parseJson<{ status: string }>(done)).status).toBe("resolvido");
    const [r1] = await caseRows(solo.allocId);
    expect(r1.withoutSecondValidation).toBe(true);
    expect((await stockRows(solo.item.id))).toHaveLength(1);

    const duo = await network({ offerUnit: "caixa", itemUnit: "kg" });
    const second = await createAuthenticatedUser();
    await addMembership(duo.org.id, second.userId, "administrador");
    const c2 = await openCaseFor(duo);
    const stays = await confer(duo, c2.id, { validateNow: true });
    expect(stays.status).toBe(200);
    expect((await parseJson<{ status: string }>(stays)).status).toBe("conferido"); // há outro elegível: precisa de segunda validação
    expect((await validate(duo, c2.id, "aprovar", duo.owner.cookie)).status).toBe(403);
    expect(await stockRows(duo.item.id)).toHaveLength(0);
    expect((await validate(duo, c2.id, "aprovar", second.cookie)).status).toBe(200);
    expect(await stockRows(duo.item.id)).toHaveLength(1);
  });

  it("validação pode devolver a conferência: volta a aberto, nada é lançado, o histórico guarda o motivo", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "kg" });
    const second = await createAuthenticatedUser();
    await addMembership(n.org.id, second.userId, "administrador");
    const c = await openCaseFor(n);
    await confer(n, c.id);
    expect((await validate(n, c.id, "devolver", second.cookie)).status).toBe(400); // sem motivo
    const back = await validate(n, c.id, "devolver", second.cookie, "Contagem não bate com o romaneio");
    expect(back.status).toBe(200);
    const [row] = await caseRows(n.allocId);
    expect(row).toMatchObject({ status: "aberto", checkedQuantity: null });
    expect((await events(c.id)).map((e) => e.eventType)).toEqual(["aberto", "conferencia_registrada", "conferencia_devolvida"]);
    expect(await stockRows(n.item.id)).toHaveLength(0);
  });

  it("34: caso pendente (aberto ou conferido) nunca gera estoque, e validar um caso aberto é recusado", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "kg" });
    const second = await createAuthenticatedUser();
    await addMembership(n.org.id, second.userId, "administrador");
    const c = await openCaseFor(n);
    expect((await validate(n, c.id, "aprovar", second.cookie)).status).toBe(409);
    await confer(n, c.id);
    expect(await stockRows(n.item.id)).toHaveLength(0);
    expect(await ledgerRows(n.allocId)).toHaveLength(0);
  });
});

describe("encerramento sem resolução", () => {
  it("encerrar exige categoria e motivo, não lança nada, é terminal e permite novo recebimento (novo caso)", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "kg" });
    const c = await openCaseFor(n);
    expect((await closeHandle(post("unit-regularization-close", n.owner.cookie, { organizationId: n.org.id, caseId: c.id, category: "informacao_insuficiente", reason: "curto" }))).status).toBe(400);
    expect((await closeCase(n, c.id)).status).toBe(200);
    const [row] = await caseRows(n.allocId);
    expect(row).toMatchObject({ status: "encerrado", category: "informacao_insuficiente", closedByUserId: n.owner.userId });
    expect(row.closedReason).toContain("Faltam dados");
    expect(await stockRows(n.item.id)).toHaveLength(0);
    expect((await closeCase(n, c.id)).status).toBe(409);
    expect((await confer(n, c.id)).status).toBe(409);
    expect((await events(c.id)).map((e) => e.eventType)).toEqual(["aberto", "encerrado"]);
    // o recurso continua não recebido: um novo pedido abre OUTRO caso (histórico preservado)
    expect((await receive(n)).status).toBe(202);
    expect(await caseRows(n.allocId)).toHaveLength(2);
  });
});

describe("correção cadastral comprovada", () => {
  async function localDonation(offerUnit: string | null, itemUnit: string) {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const item = await createTestInventoryItem(org.id, owner.userId, { name: "Item", unit: itemUnit });
    const [d] = await db.insertInto("donationOpportunities").values({ organizationId: org.id, title: "Doação local", donorName: "Doador", quantityOffered: "8", unit: offerUnit, createdByUserId: owner.userId }).returning("id").execute();
    return { owner, org, item, donationId: d.id };
  }
  const recvLocal = (l: Awaited<ReturnType<typeof localDonation>>, quantityReceived = 8) => receiveLocalHandle(post("opportunities-receive", l.owner.cookie, { organizationId: l.org.id, opportunityId: l.donationId, itemId: l.item.id, quantityReceived }));

  it("29/30: corrige a unidade da doação local (anterior, novo e motivo registrados), não lança estoque; depois o recebimento segue normal", async () => {
    const l = await localDonation("caixa", "kg");
    expect((await recvLocal(l)).status).toBe(202);
    const [c] = await db.selectFrom("unitRegularizationCases").selectAll().where("donationOpportunityId", "=", l.donationId).execute();
    const res = await correctHandle(post("unit-regularization-correct", l.owner.cookie, { organizationId: l.org.id, caseId: c.id, newUnit: "KG", reason: "A doação foi cadastrada com a unidade errada" }));
    expect(res.status).toBe(200);
    expect(await parseJson<{ previousUnit: string; newUnit: string }>(res)).toMatchObject({ previousUnit: "caixa", newUnit: "kg" });
    expect((await db.selectFrom("donationOpportunities").select("unit").where("id", "=", l.donationId).executeTakeFirstOrThrow()).unit).toBe("kg");
    expect(await stockRows(l.item.id)).toHaveLength(0);
    const [after] = await db.selectFrom("unitRegularizationCases").selectAll().where("id", "=", c.id).execute();
    expect(after).toMatchObject({ status: "corrigido", category: "erro_cadastral" });
    const evs = await events(c.id);
    expect(evs.at(-1)).toMatchObject({ eventType: "correcao_cadastral", previousValue: "caixa", newValue: "kg", fieldRef: "donation_opportunities.unit" });
    expect((await audits("regularizacao.caso_corrigido", c.id))[0].metadata).toMatchObject({ valorAnterior: "caixa", valorNovo: "kg" });
    expect((await recvLocal(l)).status).toBe(200);
    expect(Number((await stockRows(l.item.id))[0].delta)).toBe(8);
  });

  it("unidade nova que continua incompatível (409), inválida (400) ou de papel sem permissão (403) não altera nada", async () => {
    const l = await localDonation("caixa", "kg");
    await recvLocal(l);
    const [c] = await db.selectFrom("unitRegularizationCases").selectAll().where("donationOpportunityId", "=", l.donationId).execute();
    const attempt = (cookie: string, newUnit: string) => correctHandle(post("unit-regularization-correct", cookie, { organizationId: l.org.id, caseId: c.id, newUnit, reason: "Erro de cadastro da unidade" }));
    expect((await attempt(l.owner.cookie, "litro")).status).toBe(409);
    expect((await attempt(l.owner.cookie, "galões")).status).toBe(400);
    expect((await attempt(l.owner.cookie, "x")).status).toBe(400);
    const operator = await createAuthenticatedUser();
    await addMembership(l.org.id, operator.userId, "operador");
    expect((await attempt(operator.cookie, "kg")).status).toBe(403);
    expect((await db.selectFrom("donationOpportunities").select("unit").where("id", "=", l.donationId).executeTakeFirstOrThrow()).unit).toBe("caixa");
    expect((await db.selectFrom("unitRegularizationCases").select("status").where("id", "=", c.id).executeTakeFirstOrThrow()).status).toBe("aberto");
  });

  it("26: doação local conferida e validada lança estoque (unidade do item), marca a doação recebida e NÃO cria linha no ledger da rede", async () => {
    const l = await localDonation("x", "kg");
    expect((await recvLocal(l)).status).toBe(202);
    const [c] = await db.selectFrom("unitRegularizationCases").selectAll().where("donationOpportunityId", "=", l.donationId).execute();
    const ledgerBefore = await db.selectFrom("needFulfillments").select("id").execute();
    const done = await conferHandle(post("unit-regularization-confer", l.owner.cookie, { organizationId: l.org.id, caseId: c.id, checkedQuantity: 7.5, reason: "Pesado na entrada: 7,5 kg", validateNow: true }));
    expect((await parseJson<{ status: string }>(done)).status).toBe("resolvido");
    expect(Number((await stockRows(l.item.id))[0].delta)).toBe(7.5);
    expect((await db.selectFrom("donationOpportunities").select("status").where("id", "=", l.donationId).executeTakeFirstOrThrow()).status).toBe("recebida");
    expect(await db.selectFrom("needFulfillments").select("id").execute()).toHaveLength(ledgerBefore.length);
    expect(await recvLocal(l)).toHaveProperty("status", 409);
  });

  it("oferta da rede: só o admin da plataforma corrige; sem recebimentos lançados com a unidade antiga; o retry heals o caso", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "kg" });
    await openCaseFor(n);
    const [c] = await caseRows(n.allocId);
    const correct = (cookie: string, newUnit = "kg") => correctOfferHandle(post("unit-regularization-correct-offer", cookie, { caseId: c.id, newUnit, reason: "Cadastro da oferta com unidade errada" }));
    expect((await correct(n.owner.cookie)).status).toBe(403); // dono da organização não corrige oferta global
    expect((await correct(n.platform.cookie, "litro")).status).toBe(409);
    // dependente: outra organização já recebeu esta mesma oferta -> não se reinterpreta o histórico
    const other = await createAuthenticatedUser();
    const otherOrg = await createTestOrganization(other.userId);
    await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: n.registryId, organizationId: otherOrg.id, status: "recebida", quantityAllocated: "3" }).execute();
    const blocked = await correct(n.platform.cookie);
    expect(blocked.status).toBe(409);
    expect((await db.selectFrom("opportunityRegistry").select("unit").where("id", "=", n.registryId).executeTakeFirstOrThrow()).unit).toBe("caixa");
    await db.deleteFrom("opportunityAllocations").where("organizationId", "=", otherOrg.id).execute();
    const ok = await correct(n.platform.cookie);
    expect(ok.status).toBe(200);
    expect((await db.selectFrom("opportunityRegistry").select("unit").where("id", "=", n.registryId).executeTakeFirstOrThrow()).unit).toBe("kg");
    expect(await stockRows(n.item.id)).toHaveLength(0);
    expect((await events(c.id)).at(-1)).toMatchObject({ eventType: "correcao_cadastral", previousValue: "caixa", newValue: "kg", fieldRef: "opportunity_registry.unit" });
    expect((await receive(n)).status).toBe(200);
    expect(await stockRows(n.item.id)).toHaveLength(1);
  });

  it("revalidação no retry: se a oferta passou a ser compatível por outro caminho, o caso fecha como corrigido e o recebimento segue", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "kg" });
    await openCaseFor(n);
    await db.updateTable("opportunityRegistry").set({ unit: "kg" }).where("id", "=", n.registryId).execute();
    expect((await receive(n)).status).toBe(200);
    const [c] = await caseRows(n.allocId);
    expect(c.status).toBe("corrigido");
    expect(await stockRows(n.item.id)).toHaveLength(1);
  });
});

describe("autorização e isolamento", () => {
  it("37/38: voluntário e quem não é da organização não veem nem agem; operador confere mas não valida/encerra/corrige; outra organização não resolve o caso", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "kg" });
    const c = await openCaseFor(n);
    const volunteer = await createAuthenticatedUser();
    await addMembership(n.org.id, volunteer.userId, "voluntario");
    const operator = await createAuthenticatedUser();
    await addMembership(n.org.id, operator.userId, "operador");
    const stranger = await createAuthenticatedUser();
    const strangerOrg = await createTestOrganization(stranger.userId);

    expect((await listCases(n, volunteer.cookie)).status).toBe(403);
    expect((await listCases(n, stranger.cookie)).status).toBe(403);
    expect((await listCases(n, "")).status).toBe(401);
    expect((await confer(n, c.id, {}, volunteer.cookie)).status).toBe(403);
    expect((await confer(n, c.id, {}, stranger.cookie)).status).toBe(403);
    // o dono de OUTRA organização, mesmo informando a própria organização e o id do caso alheio, recebe "não encontrado"
    const viaOwnOrg = await conferHandle(post("unit-regularization-confer", stranger.cookie, { organizationId: strangerOrg.id, caseId: c.id, checkedQuantity: 1, reason: "tentativa em caso alheio" }));
    expect(viaOwnOrg.status).toBe(404);
    expect((await closeCase(n, c.id, operator.cookie)).status).toBe(403);
    expect((await validate(n, c.id, "aprovar", operator.cookie)).status).toBe(403);
    expect((await confer(n, c.id, {}, operator.cookie)).status).toBe(200);
    expect((await caseRows(n.allocId))[0].conferredByUserId).toBe(operator.userId);
    expect(await stockRows(n.item.id)).toHaveLength(0);
  });

  it("a fila lista só os casos da organização, em ordem de antiguidade, com histórico e filtros; ids de outra organização nunca aparecem", async () => {
    const a = await network({ offerUnit: "caixa", itemUnit: "kg" });
    const b = await network({ offerUnit: "x", itemUnit: "kg" });
    await receive(a); await receive(b);
    const ca = (await caseRows(a.allocId))[0];
    await closeCase(a, ca.id);
    await receive(a); // segundo caso de a
    const all = await parseJson<CasesOut>(await listCases(a, a.owner.cookie, "&status=todos"));
    expect(all.cases).toHaveLength(2);
    expect(all.cases[0].id).toBeLessThan(all.cases[1].id); // mais antigo primeiro
    const bCaseId = (await caseRows(b.allocId))[0].id;
    expect(all.cases.every((c) => c.id !== bCaseId)).toBe(true);
    expect(all.cases[0].events.map((e) => e.eventType)).toEqual(["aberto", "encerrado"]);
    const active = await parseJson<CasesOut>(await listCases(a, a.owner.cookie));
    expect(active.cases).toHaveLength(1);
    expect(active.activeCount).toBe(1);
    expect((await parseJson<CasesOut>(await listCases(a, a.owner.cookie, "&status=encerrado"))).cases).toHaveLength(1);
    expect((await parseJson<CasesOut>(await listCases(a, a.owner.cookie, "&source=local_donation&status=todos"))).cases).toHaveLength(0);
    expect((await listCases(a, a.owner.cookie, "&status=invalido")).status).toBe(400);
  });

  it("a lista da plataforma exige admin da plataforma e mostra só o mínimo", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "kg" });
    await openCaseFor(n);
    expect((await platformHandle(buildRequest("unit-regularization-platform", { cookie: n.owner.cookie }))).status).toBe(403);
    const res = await platformHandle(buildRequest("unit-regularization-platform", { cookie: n.platform.cookie }));
    expect(res.status).toBe(200);
    const data = await parseJson<{ cases: Array<Record<string, unknown>> }>(res);
    expect(Object.keys(data.cases[0]).sort()).toEqual(["divergenceKind", "id", "itemUnit", "offeredQuantity", "offeredUnit", "openedAt", "organizationName", "resourceTitle", "status"]);
  });
});

describe("proteções de logística e prazo", () => {
  it("28: a atribuição com recebimento pendente NÃO expira por prazo; sem o caso, expira", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "kg", deadlinePast: true });
    await openCaseFor(n);
    await expireAssignmentDeadlines();
    expect(await allocStatus(n.allocId)).toBe("aceita");
    const [c] = await caseRows(n.allocId);
    await closeCase(n, c.id);
    await expireAssignmentDeadlines();
    expect(await allocStatus(n.allocId)).toBe("cancelada");
  });

  it("cancelar a atribuição com caso ativo é recusado (409); coleta continua permitida; após encerrar o caso, cancelar funciona", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "kg" });
    const [c] = [await openCaseFor(n)];
    expect((await logistics(n, "cancelado")).status).toBe(409);
    expect(await allocStatus(n.allocId)).toBe("aceita");
    expect((await logistics(n, "coleta_agendada")).status).toBe(200);
    expect((await logistics(n, "cancelado")).status).toBe(409);
    await closeCase(n, c.id);
    expect((await logistics(n, "cancelado")).status).toBe(200);
    expect(await allocStatus(n.allocId)).toBe("cancelada");
  });

  it("resolver um caso cuja atribuição já não está recebível (cancelada) é recusado e nada é lançado", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "kg" });
    const c = await openCaseFor(n);
    await confer(n, c.id);
    await db.updateTable("opportunityAllocations").set({ status: "cancelada" }).where("id", "=", n.allocId).execute();
    expect((await validate(n, c.id)).status).toBe(409);
    expect(await stockRows(n.item.id)).toHaveLength(0);
    expect((await caseRows(n.allocId))[0].status).toBe("conferido");
  });
});

describe("transação: falha injetada reverte tudo e a tentativa seguinte funciona", () => {
  it("35/36: falha na auditoria da resolução -> sem estoque, sem ledger, caso continua conferido; depois funciona", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "kg" });
    const c = await openCaseFor(n);
    await confer(n, c.id);
    await installAuditFailure("regularizacao.resolvida");
    try {
      const failed = await validate(n, c.id);
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await stockRows(n.item.id)).toHaveLength(0);
      expect(await ledgerRows(n.allocId)).toHaveLength(0);
      expect(await allocStatus(n.allocId)).toBe("aceita");
      expect((await caseRows(n.allocId))[0].status).toBe("conferido");
      expect((await events(c.id)).map((e) => e.eventType)).toEqual(["aberto", "conferencia_registrada"]);
    } finally {
      await removeAuditFailure();
    }
    expect((await validate(n, c.id)).status).toBe(200);
    expect(await stockRows(n.item.id)).toHaveLength(1);
  });

  it("falha na auditoria da abertura do caso -> nenhum caso, nenhum estoque; o retry abre o caso", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "kg" });
    await installAuditFailure("regularizacao.caso_aberto");
    try {
      expect((await receive(n)).status).toBeGreaterThanOrEqual(500);
      expect(await caseRows(n.allocId)).toHaveLength(0);
      expect(await stockRows(n.item.id)).toHaveLength(0);
    } finally {
      await removeAuditFailure();
    }
    expect((await receive(n)).status).toBe(202);
    expect(await caseRows(n.allocId)).toHaveLength(1);
  });

  it("falha na auditoria do recebimento compatível não deixa estoque nem status (regressão da Fase 96/extração)", async () => {
    const n = await network({ offerUnit: "kg", itemUnit: "kg" });
    await installAuditFailure("atribuicao.recebida");
    try {
      expect((await receive(n)).status).toBeGreaterThanOrEqual(500);
      expect(await stockRows(n.item.id)).toHaveLength(0);
      expect(await ledgerRows(n.allocId)).toHaveLength(0);
      expect(await allocStatus(n.allocId)).toBe("aceita");
    } finally {
      await removeAuditFailure();
    }
    expect((await receive(n)).status).toBe(200);
  });
});

describe("integridade no banco", () => {
  it("histórico imutável: eventos não mudam nem somem; os fatos de origem do caso não mudam; estado terminal não volta", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "kg" });
    const c = await openCaseFor(n);
    await expect(db.updateTable("unitRegularizationEvents").set({ reason: "adulterado" }).where("caseId", "=", c.id).execute()).rejects.toThrow();
    await expect(db.deleteFrom("unitRegularizationEvents").where("caseId", "=", c.id).execute()).rejects.toThrow();
    await expect(db.deleteFrom("unitRegularizationCases").where("id", "=", c.id).execute()).rejects.toThrow();
    await expect(db.updateTable("unitRegularizationCases").set({ offeredUnit: "kg" }).where("id", "=", c.id).execute()).rejects.toThrow(/imutáveis/);
    await expect(db.updateTable("unitRegularizationCases").set({ informedQuantity: "99" }).where("id", "=", c.id).execute()).rejects.toThrow(/imutáveis/);
    await closeCase(n, c.id);
    await expect(db.updateTable("unitRegularizationCases").set({ status: "aberto" }).where("id", "=", c.id).execute()).rejects.toThrow(/terminal/);
  });

  it("no máximo um caso ativo por atribuição (índice único parcial) e referências cruzadas entre organizações são rejeitadas", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "kg" });
    const c = await openCaseFor(n);
    const dup = { organizationId: n.org.id, sourceType: "allocation" as const, allocationId: n.allocId, itemId: n.item.id, divergenceKind: "unidade_diferente" as const, informedQuantity: "1", itemUnit: "kg", openedByUserId: n.owner.userId };
    await expect(db.insertInto("unitRegularizationCases").values(dup).execute()).rejects.toThrow();
    const other = await network({ offerUnit: "caixa", itemUnit: "kg" });
    await expect(db.insertInto("unitRegularizationCases").values({ ...dup, organizationId: other.org.id }).execute()).rejects.toThrow(/pertence/);
    await expect(db.insertInto("unitRegularizationCases").values({ ...dup, allocationId: other.allocId }).execute()).rejects.toThrow();
    await closeCase(n, c.id);
    await db.insertInto("unitRegularizationCases").values(dup).execute(); // com o anterior encerrado, pode haver outro ativo
  });

  it("39: nenhum fluxo cria quantidade fictícia: o estoque só muda pela quantidade conferida, e o saldo nunca é alterado por correção cadastral", async () => {
    const n = await network({ offerUnit: "caixa", itemUnit: "kg" });
    const c = await openCaseFor(n);
    await db.insertInto("stockTransactions").values({ organizationId: n.org.id, itemId: n.item.id, type: "entrada", delta: "5", reason: "saldo anterior", createdByUserId: n.owner.userId }).execute();
    const before = await getItemStockBalance(db, n.item.id);
    await correctOfferHandle(post("unit-regularization-correct-offer", n.platform.cookie, { caseId: c.id, newUnit: "kg", reason: "Cadastro da oferta com unidade errada" }));
    expect(await getItemStockBalance(db, n.item.id)).toBe(before);
    expect(await ledgerRows(n.allocId)).toHaveLength(0);
  });
});

describe("oferta SEM unidade (NULL, vazia, só espaços) é unidade desconhecida: nunca presumida compatível", () => {
  it("NULL, vazia e só espaços: 202, caso 'unidade_ausente', sem estoque, ledger, atendimento nem mudança de status; a quantidade original é preservada", async () => {
    for (const offerUnit of [null, "", "   "]) {
      const n = await network({ offerUnit, itemUnit: "kg" });
      const res = await receive(n);
      expect(res.status, JSON.stringify(offerUnit)).toBe(202);
      expect(await stockRows(n.item.id)).toHaveLength(0);
      expect(await ledgerRows(n.allocId)).toHaveLength(0);
      expect(await allocStatus(n.allocId)).toBe("aceita");
      const [c] = await caseRows(n.allocId);
      expect(c).toMatchObject({ status: "aberto", divergenceKind: "unidade_ausente", itemUnit: "kg" });
      expect(c.offeredUnit === null || c.offeredUnit.trim() === "").toBe(true);
      expect(Number(c.offeredQuantity)).toBe(10);
      expect(Number(c.informedQuantity)).toBe(10);
    }
  });

  it("fluxo curto: conferir (quantidade sugerida pela informada, mas CONFIRMADA) + validar lança uma vez a quantidade CONFERIDA, não a original; retry durante a regularização não duplica", async () => {
    const n = await network({ offerUnit: null, itemUnit: "kg" });
    const second = await createAuthenticatedUser();
    await addMembership(n.org.id, second.userId, "administrador");
    expect((await receive(n)).status).toBe(202);
    expect((await receive(n)).status).toBe(202); // retry durante a regularização
    const [c] = await caseRows(n.allocId);
    expect(await caseRows(n.allocId)).toHaveLength(1);
    expect((await confer(n, c.id, { checkedQuantity: 8.25 })).status).toBe(200);
    expect((await receive(n)).status).toBe(202); // retry com o caso conferido
    expect(await stockRows(n.item.id)).toHaveLength(0);
    expect((await validate(n, c.id, "aprovar", second.cookie)).status).toBe(200);
    const stock = await stockRows(n.item.id);
    expect(stock).toHaveLength(1);
    expect(Number(stock[0].delta)).toBe(8.25); // a quantidade original (10) NÃO é reinterpretada
    const ledger = await ledgerRows(n.allocId);
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].quantity)).toBe(8.25);
    expect(ledger[0].unit).toBe("kg");
    const [row] = await caseRows(n.allocId);
    expect(Number(row.offeredQuantity)).toBe(10);
    expect(Number(row.checkedQuantity)).toBe(8.25);
  });

  it("único proprietário/administrador ativo: confere e valida no mesmo ato; a exceção fica registrada no caso e na auditoria", async () => {
    const n = await network({ offerUnit: null, itemUnit: "kg" });
    const c = await openCaseFor(n);
    const done = await confer(n, c.id, { validateNow: true, checkedQuantity: 7 });
    expect((await parseJson<{ status: string }>(done)).status).toBe("resolvido");
    const [row] = await caseRows(n.allocId);
    expect(row.withoutSecondValidation).toBe(true);
    const events = await db.selectFrom("unitRegularizationEvents").select(["eventType", "reason"]).where("caseId", "=", c.id).orderBy("id").execute();
    expect(events.at(-1)!.reason).toContain("sem segunda validação");
    expect((await audits("regularizacao.resolvida", c.id))[0].metadata).toMatchObject({ semSegundaValidacao: true, quantidadeConferida: 7 });
  });

  it("falha de auditoria na abertura do caso por unidade ausente: nada fica gravado, o retry funciona; outra organização não enxerga nem resolve o caso", async () => {
    const n = await network({ offerUnit: null, itemUnit: "kg" });
    await installAuditFailure("regularizacao.caso_aberto");
    try {
      expect((await receive(n)).status).toBeGreaterThanOrEqual(500);
      expect(await caseRows(n.allocId)).toHaveLength(0);
      expect(await stockRows(n.item.id)).toHaveLength(0);
    } finally {
      await removeAuditFailure();
    }
    expect((await receive(n)).status).toBe(202);
    const [c] = await caseRows(n.allocId);
    const stranger = await createAuthenticatedUser();
    const strangerOrg = await createTestOrganization(stranger.userId);
    expect((await conferHandle(post("unit-regularization-confer", stranger.cookie, { organizationId: strangerOrg.id, caseId: c.id, checkedQuantity: 1, reason: "tentativa em caso de outra organização" }))).status).toBe(404);
    expect((await caseRows(n.allocId))[0].status).toBe("aberto");
  });

  it("oferta com unidade conhecida e compatível continua pelo fluxo normal, e a idempotência do recebimento local (Fase 96) permanece: a segunda tentativa é 409", async () => {
    const n = await network({ offerUnit: "kg", itemUnit: "kg" });
    expect((await receive(n)).status).toBe(200);
    expect((await receive(n)).status).toBe(409);
    expect(await stockRows(n.item.id)).toHaveLength(1);
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const item = await createTestInventoryItem(org.id, owner.userId, { name: "Item", unit: "kg" });
    const [d] = await db.insertInto("donationOpportunities").values({ organizationId: org.id, title: "Local sem unidade", donorName: "Doador", quantityOffered: "5", createdByUserId: owner.userId }).returning("id").execute();
    const local = () => receiveLocalHandle(post("opportunities-receive", owner.cookie, { organizationId: org.id, opportunityId: d.id, itemId: item.id, quantityReceived: 5 }));
    expect((await local()).status).toBe(202); // doação local sem unidade também é desconhecida
    expect((await db.selectFrom("stockTransactions").select("id").where("itemId", "=", item.id).execute())).toHaveLength(0);
    expect((await db.selectFrom("donationOpportunities").select("status").where("id", "=", d.id).executeTakeFirstOrThrow()).status).not.toBe("recebida");
  });
});
