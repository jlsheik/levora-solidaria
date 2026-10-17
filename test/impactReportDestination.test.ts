/**
 * Fase 99H — bloco "Destinação" da prestação de contas (PostgreSQL real, banco `_test`): destinação por finalidade × item × unidade, físico × contabilizável, indicadores separados,
 * saídas sem destinação estruturada (duas subclasses), conciliação por item, recebimento da rede × destinação final, data de registro × data efetiva, histórico, isolamento e
 * permissão. O relatório é SÓ leitura: nenhum teste aqui depende de o relatório escrever algo.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { businessDateOf, parseCivilDate } from "../src/helpers/businessDate";
import { buildImpactReport, type ImpactReportOutput } from "../src/helpers/impactReport";
import { handle as reportHandle } from "../src/endpoints/impact-report_GET";
import { handle as destHandle } from "../src/endpoints/stock-destinations_POST";
import { handle as reverseHandle } from "../src/endpoints/stock-destination-reversal_POST";
import { handle as correctHandle } from "../src/endpoints/stock-destination-correction_POST";
import { handle as receiveHandle } from "../src/endpoints/allocations-receive_POST";
import { addMembership, buildRequest, createAuthenticatedUser, createTestInventoryItem, createTestOpportunityRegistry, createTestOrganization, createTestSource, parseJson } from "./helpers";

type Auth = Awaited<ReturnType<typeof createAuthenticatedUser>>;
const post = (p: string, cookie: string, body: unknown) => buildRequest(p, { method: "POST", cookie, body });
const key = () => `k-${randomBytes(8).toString("hex")}`;
const today = () => businessDateOf(new Date());
const daysAgo = (n: number) => {
  const t = parseCivilDate(today())!;
  return new Date(Date.UTC(t.y, t.m - 1, t.d - n)).toISOString().slice(0, 10);
};
/** Janela do dia de negócio de hoje: [00:00 BRT, 00:00 BRT do dia seguinte). */
const dayWindow = () => {
  const s = new Date(`${today()}T00:00:00-03:00`);
  return { startDate: s, endDate: new Date(s.getTime() + 24 * 3600 * 1000) };
};
const wideWindow = () => ({ startDate: new Date(Date.now() - 3 * 86400000), endDate: new Date(Date.now() + 86400000) });

async function world(opts: { balance?: number } = {}) {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const admin = await createAuthenticatedUser();
  await addMembership(org.id, admin.userId, "administrador");
  const operator = await createAuthenticatedUser();
  await addMembership(org.id, operator.userId, "operador");
  const rice = await createTestInventoryItem(org.id, owner.userId, { name: "Arroz", unit: "kg" });
  const milk = await createTestInventoryItem(org.id, owner.userId, { name: "Leite", unit: "unidade" });
  for (const it of [rice, milk]) await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: it.id, type: "entrada", delta: String(opts.balance ?? 10000), reason: "saldo inicial", createdByUserId: owner.userId }).execute();
  const need = async (title: string, qty: number, unit: string, itemId: number | null) =>
    (await db.insertInto("needs").values({ organizationId: org.id, itemId, title, quantityNeeded: String(qty), unit, priority: "alta", createdByUserId: owner.userId }).returning("id").execute())[0].id;
  return { owner, admin, operator, org, rice, milk, need };
}
type W = Awaited<ReturnType<typeof world>>;

const dest = async (w: W, itemId: number, quantity: number, over: Record<string, unknown> = {}, user: Auth = w.admin) => {
  const res = await destHandle(post("stock-destinations", user.cookie, { organizationId: w.org.id, itemId, quantity, destinationType: "distribuicao_familias", deliveredOn: today(), idempotencyKey: key(), ...over }));
  const out = await parseJson<{ destination?: { id: string } }>(res);
  return { status: res.status, id: out.destination?.id as string };
};
const reverse = (w: W, destinationId: string, kind: string, quantity: number) =>
  reverseHandle(post("stock-destination-reversal", w.admin.cookie, { organizationId: w.org.id, destinationId, kind, quantity, reason: "Registro feito por engano", idempotencyKey: key() }));
const report = (w: W, over: Record<string, unknown> = {}): Promise<ImpactReportOutput> => buildImpactReport(db, { organizationId: w.org.id, ...wideWindow(), ...over } as never);
const purpose = (r: ImpactReportOutput, type: string, itemId?: number) => r.destination.byPurpose.find((p) => p.destinationType === type && (itemId === undefined || p.itemId === itemId));

describe("A. destinação por finalidade, item e unidade; físico × contabilizável", () => {
  it("agrega por finalidade × item × UNIDADE, com físico, revertido, líquido e atendimento em colunas separadas", async () => {
    const w = await world();
    const n = await w.need("Cestas", 40, "kg", w.rice.id);
    expect((await dest(w, w.rice.id, 10, { needId: n, peopleServed: 12, peopleUnit: "familias" })).status).toBe(200);
    expect((await dest(w, w.rice.id, 5, { needId: n })).status).toBe(200);
    expect((await dest(w, w.milk.id, 7, { destinationType: "atendimento_coletivo" })).status).toBe(200);
    const r = await report(w);
    const fam = purpose(r, "distribuicao_familias", w.rice.id)!;
    expect(fam).toMatchObject({ unit: "kg", records: 2, physical: 15, reverted: 0, physicalNet: 15, appliedNet: 15, surplusNet: 0, incompatibleNet: 0 });
    expect(fam.declaredPeople).toEqual({ pessoas: 0, familias: 12 });
    expect(purpose(r, "atendimento_coletivo", w.milk.id)).toMatchObject({ unit: "unidade", physicalNet: 7, appliedNet: 0 }); // sem necessidade: físico, não atendimento
    expect(r.destination.byPurpose.map((p) => p.unit).sort()).toEqual(["kg", "unidade"]); // nunca somados
    expect(r.destination.records).toBe(3);
  });

  it("excedente autorizado: físico > atendimento; a diferença aparece como excedente e não conta como atendimento", async () => {
    const w = await world();
    const n = await w.need("Cestas", 10, "kg", w.rice.id);
    expect((await dest(w, w.rice.id, 15, { needId: n, authorizeSurplus: true, surplusReason: "Embalagens fechadas de 5 kg" })).status).toBe(200);
    const p = purpose(await report(w), "distribuicao_familias")!;
    expect(p).toMatchObject({ physicalNet: 15, appliedNet: 10, surplusNet: 5 });
  });

  it("unidade incompatível com a necessidade: o físico é mostrado, mas NÃO conta como atendimento (e a necessidade fica sem atendimento)", async () => {
    const w = await world();
    const n = await w.need("Caixas", 10, "caixas", null);
    expect((await dest(w, w.rice.id, 5, { needId: n })).status).toBe(200);
    const r = await report(w);
    expect(purpose(r, "distribuicao_familias")).toMatchObject({ physicalNet: 5, appliedNet: 0, incompatibleNet: 5 });
    const row = r.needs.rows.find((x) => x.id === n)!;
    expect(row.attendance).toMatchObject({ attended: 0, unitIncompatibleDestined: 5 });
  });

  it("indicadores separados por grupo e unidade: operação, terceiros, devolução ao doador ficam fora do atendimento e fora uns dos outros", async () => {
    const w = await world();
    const n = await w.need("Cestas", 40, "kg", w.rice.id);
    await dest(w, w.rice.id, 10, { needId: n });
    await dest(w, w.rice.id, 4, { destinationType: "uso_operacional_instituicao", notes: "Uso na cozinha da instituição" });
    await dest(w, w.rice.id, 6, { destinationType: "doacao_a_terceiro", notes: "Doação à associação parceira" });
    await dest(w, w.rice.id, 2, { destinationType: "devolucao_ao_doador", notes: "Devolvido ao doador por erro de entrega" });
    const ind = (await report(w)).destination.indicators;
    const get = (g: string) => ind.find((i) => i.group === g && i.unit === "kg")?.physicalNet;
    expect(get("atendimento")).toBe(10);
    expect(get("operacao")).toBe(4);
    expect(get("terceiros")).toBe(6);
    expect(get("devolucao_ao_doador")).toBe(2);
    expect(get("perdas")).toBeUndefined();
  });

  it("filtros do bloco: finalidade, item e necessidade restringem; a data usada é explícita", async () => {
    const w = await world();
    const n = await w.need("Cestas", 40, "kg", w.rice.id);
    await dest(w, w.rice.id, 10, { needId: n });
    await dest(w, w.milk.id, 3, { destinationType: "uso_operacional_instituicao", notes: "Uso na cozinha da instituição" });
    expect((await report(w, { destinationType: "uso_operacional_instituicao" })).destination.byPurpose).toHaveLength(1);
    expect((await report(w, { itemId: w.rice.id })).destination.byPurpose.every((p) => p.itemId === w.rice.id)).toBe(true);
    expect((await report(w, { needId: n })).destination.records).toBe(1);
    expect((await report(w)).destination.basis).toBe("registro");
  });
});

describe("B. reversões, correções e o estoque no relatório", () => {
  it("devolução física: físico líquido cai, a entrada NÃO é doação recebida, aparece como devolução e a conciliação fecha", async () => {
    const w = await world();
    const before = await report(w);
    const donationsBefore = before.summary.donations.total;
    const d = await dest(w, w.rice.id, 10);
    expect((await reverse(w, d.id, "devolucao_fisica", 4)).status).toBe(200);
    expect((await reverse(w, d.id, "correcao_quantidade", 1)).status).toBe(200);
    expect((await reverse(w, d.id, "estorno_documental", 2)).status).toBe(200);
    const r = await report(w);
    expect(purpose(r, "distribuicao_familias")).toMatchObject({ physical: 10, reverted: 7, physicalNet: 3 });
    expect(r.summary.donations.total).toBe(donationsBefore); // a devolução NÃO vira doação
    expect(r.donations.rows.every((x) => x.reason?.indexOf("Devolução física") !== 0)).toBe(true);
    const m = r.itemMovements.find((x) => x.itemId === w.rice.id)!;
    expect(m).toMatchObject({ entradasDevolucao: 4, ajustesDestinacao: 1, saidas: 10, saidasComDestinacao: 10, saidasSemDestinacao: 0 });
    expect(r.reconciliation.every((x) => x.balanced && x.exitsBalanced)).toBe(true);
    expect(r.destination.eventsInPeriod).toMatchObject({ estornoDocumental: 1, devolucaoFisica: 1, correcaoQuantidade: 1 });
    expect(r.destination.revertedRecords).toBe(1);
  });

  it("registro totalmente revertido não conta pessoas declaradas; correções documentais sobrepõem pessoas e entram na contagem de corrigidos", async () => {
    const w = await world();
    const a = await dest(w, w.rice.id, 5, { peopleServed: 10, peopleUnit: "pessoas" });
    const b = await dest(w, w.rice.id, 5, { peopleServed: 20, peopleUnit: "pessoas" });
    expect((await correctHandle(post("stock-destination-correction", w.admin.cookie, { organizationId: w.org.id, destinationId: a.id, peopleServed: 15, peopleUnit: "pessoas", reason: "Contagem corrigida", idempotencyKey: key() }))).status).toBe(200);
    expect((await reverse(w, b.id, "estorno_documental", 5)).status).toBe(200);
    const r = await report(w);
    expect(purpose(r, "distribuicao_familias")!.declaredPeople).toEqual({ pessoas: 15, familias: 0 });
    expect(r.destination.correctedRecords).toBe(1);
    expect(r.destination.eventsInPeriod.corrections).toBe(1);
  });

  it("necessidade atendida e depois revertida: o relatório mostra o atendimento atual (aberta, parcial) e nenhum aviso de status", async () => {
    const w = await world();
    const n = await w.need("Cestas", 10, "kg", w.rice.id);
    const d = await dest(w, w.rice.id, 10, { needId: n });
    expect((await report(w)).needs.rows.find((x) => x.id === n)!).toMatchObject({ status: "atendida", statusWarning: false, historicalAttended: false });
    await reverse(w, d.id, "estorno_documental", 4);
    const row = (await report(w)).needs.rows.find((x) => x.id === n)!;
    expect(row).toMatchObject({ status: "aberta", statusWarning: false });
    expect(row.attendance).toMatchObject({ attended: 6, remaining: 4, state: "parcial" });
  });
});

describe("C. saídas sem destinação estruturada e histórico", () => {
  it("duas subclasses (baixa automática histórica × sem destinação) e a conciliação saídas = com + sem", async () => {
    const w = await world();
    const n = await w.need("Antiga", 10, "kg", w.rice.id);
    const [auto] = await db.insertInto("stockTransactions").values({ organizationId: w.org.id, itemId: w.rice.id, type: "saida", delta: "-20", reason: "baixa antiga", createdByUserId: w.owner.userId } as never).returning("id").execute();
    await db.insertInto("needResolutions").values({ needId: n, stockTransactionId: auto.id, createdByUserId: w.owner.userId }).execute();
    await db.insertInto("stockTransactions").values({ organizationId: w.org.id, itemId: w.rice.id, type: "saida", delta: "-5", reason: "saída antiga qualquer", createdByUserId: w.owner.userId } as never).execute();
    await dest(w, w.rice.id, 3);
    const r = await report(w);
    expect(r.destination.withoutStructuredDestination.automaticHistorical).toEqual([expect.objectContaining({ itemId: w.rice.id, quantity: 20, count: 1 })]);
    expect(r.destination.withoutStructuredDestination.notClassified).toEqual([expect.objectContaining({ itemId: w.rice.id, quantity: 5, count: 1 })]);
    const m = r.itemMovements.find((x) => x.itemId === w.rice.id)!;
    expect(m).toMatchObject({ saidas: 28, saidasComDestinacao: 3, saidasSemDestinacao: 25 });
    expect(r.reconciliation.find((x) => x.itemId === w.rice.id)).toMatchObject({ balanced: true, exitsBalanced: true, saidasComDestinacao: 3, saidasSemDestinacao: 25 });
    // com o filtro de necessidade só a baixa automática DAQUELA necessidade permanece
    const filtered = await report(w, { needId: n });
    expect(filtered.destination.withoutStructuredDestination.notClassified).toHaveLength(0);
    expect(filtered.destination.withoutStructuredDestination.automaticHistorical).toHaveLength(1);
  });

  it("necessidade 'atendida' histórica (sem destinação) com suprimento da rede: indicada como histórica, atendido 0, NUNCA reaberta nem recalculada; aviso factual de suprimento preservado", async () => {
    const w = await world();
    const n = await w.need("Antiga", 100, "kg", w.rice.id);
    const platform = await createAuthenticatedUser();
    const source = await createTestSource(platform.userId);
    const opp = await createTestOpportunityRegistry(source.id, platform.userId, { unit: "kg", status: "reservada" });
    const [al] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: opp.id, organizationId: w.org.id, quantityAllocated: "40", status: "aceita", needId: n }).returning("id").execute();
    const rec = await receiveHandle(post("allocations-receive", w.owner.cookie, { organizationId: w.org.id, allocationId: al.id, itemId: w.rice.id, quantityReceived: 40 }));
    expect(rec.status).toBe(200);
    await db.updateTable("needs").set({ status: "atendida" }).where("id", "=", n).execute(); // registro anterior ao controle por destinações
    const row = (await report(w)).needs.rows.find((x) => x.id === n)!;
    expect(row).toBeDefined();
    expect(row.today.fulfilled).toBe(40); // suprimento da rede
    expect(row.historicalAttended).toBe(true);
    expect(row.attendance).toMatchObject({ attended: 0, state: "atendida_historica" }); // nada foi inventado a partir do suprimento
    expect(row.statusWarning).toBe(true); // histórico: segue o aviso factual de suprimento (40 de 100)
    expect((await db.selectFrom("needs").select("status").where("id", "=", n).executeTakeFirstOrThrow()).status).toBe("atendida");
    expect(await db.selectFrom("stockDestinations").select("id").where("organizationId", "=", w.org.id).execute()).toHaveLength(0);
  });

  it("necessidade que só tem destinações (sem ledger de suprimento) aparece na lista de necessidades com o atendimento separado do suprimento", async () => {
    const w = await world();
    const n = await w.need("Só destinação", 20, "kg", w.rice.id);
    await dest(w, w.rice.id, 8, { needId: n });
    const row = (await report(w)).needs.rows.find((x) => x.id === n)!;
    expect(row).toBeDefined();
    expect(row.today.fulfilled).toBe(0); // suprimento da rede
    expect(row.attendance).toMatchObject({ attended: 8, remaining: 12 }); // atendimento final
    expect(row.hasActivityInPeriod).toBe(true);
  });
});

describe("D. data de registro × data efetiva", () => {
  it("a mesma destinação cai na janela de HOJE por registro, mas não por data efetiva quando a entrega foi dias antes", async () => {
    const w = await world();
    await dest(w, w.rice.id, 6, { deliveredOn: daysAgo(3) });
    const win = dayWindow();
    const byRegistro = await report(w, { ...win, destinationDateBasis: "registro" });
    const byEfetiva = await report(w, { ...win, destinationDateBasis: "efetiva" });
    expect(byRegistro.destination.records).toBe(1);
    expect(byEfetiva.destination.records).toBe(0);
    const wide = await report(w, { startDate: new Date(`${daysAgo(4)}T00:00:00-03:00`), endDate: win.endDate, destinationDateBasis: "efetiva" });
    expect(wide.destination.records).toBe(1);
    expect(byEfetiva.destination.basis).toBe("efetiva");
  });
});

describe("E. isolamento, permissão e leitura apenas", () => {
  it("destinações de outra organização nunca aparecem", async () => {
    const a = await world();
    const b = await world();
    await dest(a, a.rice.id, 9);
    await dest(b, b.rice.id, 1);
    const r = await report(b);
    expect(r.destination.records).toBe(1);
    expect(r.destination.byPurpose.reduce((s, p) => s + p.physicalNet, 0)).toBe(1);
  });

  it("endpoint: proprietário e administrador leem (200); operador não (403); parâmetros inválidos são 400", async () => {
    const w = await world();
    await dest(w, w.rice.id, 2);
    const { startDate, endDate } = wideWindow();
    const q = (extra = "") => `impact-report?organizationId=${w.org.id}&startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}${extra}`;
    const get = (u: Auth, extra?: string) => reportHandle(buildRequest(q(extra), { method: "GET", cookie: u.cookie }));
    const ok = await get(w.owner);
    expect(ok.status).toBe(200);
    expect((await parseJson<ImpactReportOutput>(ok)).destination.records).toBe(1);
    expect((await get(w.admin, "&destinationDateBasis=efetiva&destinationType=distribuicao_familias")).status).toBe(200);
    expect((await get(w.operator)).status).toBe(403);
    expect((await get(w.owner, "&destinationDateBasis=ontem")).status).toBe(400);
    expect((await get(w.owner, "&destinationType=inventada")).status).toBe(400);
  });

  it("gerar o relatório não escreve nada (tabelas de destinação, estoque, necessidades e auditoria inalteradas)", async () => {
    const w = await world();
    const n = await w.need("Cestas", 10, "kg", w.rice.id);
    await dest(w, w.rice.id, 10, { needId: n });
    const count = async () => {
      const t = async (name: string) => Number((await sql<{ c: string }>`SELECT count(*) AS c FROM ${sql.raw(name)}`.execute(db)).rows[0].c);
      return [await t("stock_destinations"), await t("stock_transactions"), await t("needs"), await t("audit_log"), await t("need_fulfillments"), await t("destination_correction_requests")];
    };
    const before = await count();
    const statusBefore = (await db.selectFrom("needs").select("status").where("id", "=", n).executeTakeFirstOrThrow()).status;
    await report(w);
    await report(w, { destinationDateBasis: "efetiva" });
    expect(await count()).toEqual(before);
    expect((await db.selectFrom("needs").select("status").where("id", "=", n).executeTakeFirstOrThrow()).status).toBe(statusBefore);
  });
});
