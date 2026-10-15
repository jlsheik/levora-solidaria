/**
 * Política de excedentes (decisão do dono, pós-Fase 94): receber ACIMA do alocado ou do necessário é PERMITIDO; o ledger guarda o valor
 * realmente recebido (sem corte); o excedente fica IDENTIFICÁVEL na auditoria; o progresso da necessidade continua derivado do ledger
 * (fulfilled / requiredRemaining = max(0, needed − fulfilled) / surplus = max(0, fulfilled − needed)); o excedente NÃO vira nova doação nem
 * migra para outra necessidade; permissões, motivo, dupla aprovação e demais integridades seguem valendo.
 * Endpoints reais, linhas persistidas, estoque e auditoria. Postgres real e DESCARTÁVEL.
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { handle as postReceive } from "../src/endpoints/allocations-receive_POST";
import { handle as postCorrect } from "../src/endpoints/allocations-receipt-correct_POST";
import { handle as postReverse } from "../src/endpoints/allocations-receipt-reverse_POST";
import { handle as postDecide } from "../src/endpoints/approval-requests-decide_POST";
import { handle as getHistory } from "../src/endpoints/allocations-receipt-history_GET";
import { handle as getReport } from "../src/endpoints/impact-report_GET";
import { getNeedFulfillmentBalance, computeNeedProgress } from "../src/helpers/needFulfillment";
import {
  addMembership, buildRequest, createAuthenticatedUser, createTestInventoryItem, createTestOpportunityRegistry, createTestOrganization, createTestSource, parseJson,
  type AuthenticatedTestUser,
} from "./helpers";
import type { OutputType as Report } from "../src/endpoints/impact-report_GET.schema";
import type { OutputType as History } from "../src/endpoints/allocations-receipt-history_GET.schema";

interface Env { owner: AuthenticatedTestUser; operador: AuthenticatedTestUser; admin: AuthenticatedTestUser; voluntario: AuthenticatedTestUser; orgId: number; itemId: number; needId: number; otherNeedId: number; sourceId: number; platformId: number }

async function setup(needQuantity = 300): Promise<Env> {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const operador = await createAuthenticatedUser();
  const admin = await createAuthenticatedUser();
  const voluntario = await createAuthenticatedUser();
  await addMembership(org.id, operador.userId, "operador");
  await addMembership(org.id, admin.userId, "administrador");
  await addMembership(org.id, voluntario.userId, "voluntario");
  const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
  const mk = async (title: string, qty: number) =>
    (await db.insertInto("needs").values({ organizationId: org.id, title, quantityNeeded: String(qty), unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId, itemId: item.id }).returning(["id"]).executeTakeFirstOrThrow()).id;
  const needId = await mk("Cestas", needQuantity);
  const otherNeedId = await mk("Água", 50);
  const platform = await createAuthenticatedUser();
  const source = await createTestSource(platform.userId);
  return { owner, operador, admin, voluntario, orgId: org.id, itemId: item.id, needId, otherNeedId, sourceId: source.id, platformId: platform.userId };
}

async function allocation(e: Env, quantityAllocated: number, needId: number | null = e.needId) {
  const opp = await createTestOpportunityRegistry(e.sourceId, e.platformId, { unit: "kg", status: "reservada" });
  return (await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: opp.id, organizationId: e.orgId, quantityAllocated: String(quantityAllocated), status: "aceita", needId }).returning(["id"]).executeTakeFirstOrThrow()).id;
}
const receive = (e: Env, allocationId: number, quantityReceived: number, user = e.owner) =>
  postReceive(buildRequest("allocations-receive", { method: "POST", cookie: user.cookie, body: { organizationId: e.orgId, allocationId, itemId: e.itemId, quantityReceived } }));
const history = async (e: Env, allocationId: number) =>
  parseJson<History>(await getHistory(buildRequest(`allocations-receipt-history?organizationId=${e.orgId}&allocationId=${allocationId}`, { cookie: e.owner.cookie })));
const correct = async (e: Env, allocationId: number, quantity: number, user = e.operador, reason: string | null = "Conferência na chegada") =>
  postCorrect(buildRequest("allocations-receipt-correct", { method: "POST", cookie: user.cookie, body: { organizationId: e.orgId, allocationId, expectedVigenteFulfillmentId: (await history(e, allocationId)).vigenteFulfillmentId, quantity, ...(reason !== null ? { reason } : {}) } }));
const reverse = async (e: Env, allocationId: number, withdrawStock: boolean, user = e.operador) =>
  postReverse(buildRequest("allocations-receipt-reverse", { method: "POST", cookie: user.cookie, body: { organizationId: e.orgId, allocationId, expectedVigenteFulfillmentId: (await history(e, allocationId)).vigenteFulfillmentId, reason: "Doação duplicada", withdrawStock } }));
const decide = (e: Env, requestId: number, user = e.admin) =>
  postDecide(buildRequest("approval-requests-decide", { method: "POST", cookie: user.cookie, body: { organizationId: e.orgId, requestId, decision: "aprovada" } }));

const stockOf = async (itemId: number) => Number((await db.selectFrom("stockTransactions").select((eb) => eb.fn.sum("delta").as("t")).where("itemId", "=", itemId).executeTakeFirstOrThrow()).t ?? 0);
const ledger = (allocationId: number) => db.selectFrom("needFulfillments").select(["id", "entryType", "quantity", "needId", "isCountable", "stockTransactionId"]).where("allocationId", "=", allocationId).orderBy("id").execute();
const progress = async (e: Env, needId: number, needed: number) => computeNeedProgress(needed, await getNeedFulfillmentBalance(db as never, needId));
async function audits(allocationId: number, ...actions: string[]) {
  const rows = await db.selectFrom("auditLog").select(["action", "metadata", "actorUserId"]).where("entityType", "=", "opportunity_allocation").where("entityId", "=", String(allocationId)).where("action", "in", actions).orderBy("id").execute();
  return rows.map((r) => ({ action: r.action, actor: r.actorUserId, m: r.metadata as Record<string, unknown> }));
}
const counts = async () => ({
  stock: Number((await db.selectFrom("stockTransactions").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n),
  ledger: Number((await db.selectFrom("needFulfillments").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n),
  audit: Number((await db.selectFrom("auditLog").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n),
});
async function report(e: Env): Promise<Report> {
  const qs = new URLSearchParams({ organizationId: String(e.orgId), startDate: new Date(Date.now() - 86400000).toISOString(), endDate: new Date(Date.now() + 86400000).toISOString() });
  const res = await getReport(buildRequest(`impact-report?${qs}`, { cookie: e.owner.cookie }));
  expect(res.status).toBe(200);
  return parseJson<Report>(res);
}

describe("recebimento × alocado: inferior (parcial), igual e superior — sempre registra o valor REAL, sem corte", () => {
  for (const [label, received, over] of [["inferior (parcial)", 60, 0], ["igual", 100, 0], ["superior", 130, 30]] as const) {
    it(`${label}: ${received} contra 100 alocados`, async () => {
      const e = await setup();
      const al = await allocation(e, 100);
      const res = await receive(e, al, received);
      expect(res.status).toBe(200);
      // ledger: a quantidade realmente recebida, 1 linha original contável, ligada ao movimento físico
      const rows = await ledger(al);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entryType: "original", isCountable: true, needId: e.needId });
      expect(Number(rows[0].quantity)).toBe(received);
      expect(await stockOf(e.itemId)).toBe(received); // o estoque físico = o recebido (sem corte)
      expect((await db.selectFrom("opportunityAllocations").select("status").where("id", "=", al).executeTakeFirstOrThrow()).status).toBe("recebida");
      // auditoria: indicador de excedente com ids e valores
      const [a] = await audits(al, "atribuicao.recebida");
      expect(a.m).toMatchObject({ quantityReceived: received, quantidadeAlocada: 100, acimaDaAlocacao: over > 0, excedenteAlocacao: over, needId: e.needId, itemId: e.itemId });
      expect(a.m.stockTransactionId).toBeTruthy();
      expect((await progress(e, e.needId, 300)).fulfilled).toBe(received);
    });
  }

  it("superior ao NECESSÁRIO: fulfilled preserva o total, requiredRemaining = 0, surplus = excedente; auditoria diz quanto ESTE recebimento acrescentou ao excedente", async () => {
    const e = await setup(300);
    const a1 = await allocation(e, 250);
    expect((await receive(e, a1, 250)).status).toBe(200);
    const a2 = await allocation(e, 100);
    expect((await receive(e, a2, 120)).status).toBe(200); // 370 contra 300
    expect(await progress(e, e.needId, 300)).toEqual({ fulfilled: 370, requiredRemaining: 0, surplus: 70 });
    const [m1] = await audits(a1, "atribuicao.recebida");
    const [m2] = await audits(a2, "atribuicao.recebida");
    expect(m1.m).toMatchObject({ excedenteNecessidade: 0, acimaDaAlocacao: false, progressoNecessidade: { fulfilled: 250, requiredRemaining: 50, surplus: 0 } });
    expect(m2.m).toMatchObject({ excedenteNecessidade: 70, acimaDaAlocacao: true, excedenteAlocacao: 20, progressoNecessidade: { fulfilled: 370, requiredRemaining: 0, surplus: 70 } });
    // um 3º recebimento com a necessidade JÁ satisfeita: todo ele é excedente
    const a3 = await allocation(e, 10);
    expect((await receive(e, a3, 10)).status).toBe(200);
    expect((await audits(a3, "atribuicao.recebida"))[0].m).toMatchObject({ excedenteNecessidade: 10, progressoNecessidade: { fulfilled: 380, requiredRemaining: 0, surplus: 80 } });
    expect(await stockOf(e.itemId)).toBe(380);
  });

  it("o excedente NÃO é uma nova doação e NÃO migra para outra necessidade; o relatório reconcilia com o ledger e o estoque", async () => {
    const e = await setup(300);
    const al = await allocation(e, 100);
    expect((await receive(e, al, 400)).status).toBe(200);
    expect(await progress(e, e.otherNeedId, 50)).toEqual({ fulfilled: 0, requiredRemaining: 50, surplus: 0 }); // nada foi transferido
    const r = await report(e);
    expect(r.summary.donations.total).toBe(1); // 1 doação (a entrada física), não 2
    expect(r.donations.rows.map((d) => d.quantity)).toEqual([400]);
    const need = r.needs.rows.find((n) => n.id === e.needId)!;
    expect(need.atEnd).toEqual({ fulfilled: 400, requiredRemaining: 0, surplus: 100 });
    expect(need.components).toMatchObject({ recebido: 400, correcoes: 0, estornos: 0 });
    expect(r.needs.rows.find((n) => n.id === e.otherNeedId)).toBeUndefined();
    expect(r.itemMovements[0]).toMatchObject({ entradas: 400, currentStock: 400, balanceAtEnd: 400 });
  });

  it("sem permissão e sem alocação válida nada é gravado, mesmo recebendo acima do alocado", async () => {
    const e = await setup();
    const al = await allocation(e, 100);
    const before = await counts();
    expect((await receive(e, al, 500, e.voluntario)).status).toBe(403);
    expect(await counts()).toEqual(before);
    expect((await db.selectFrom("opportunityAllocations").select("status").where("id", "=", al).executeTakeFirstOrThrow()).status).toBe("aceita");
    // valor inválido continua recusado (a política não afrouxa a validação de quantidade)
    expect((await receive(e, al, 0.0004)).status).toBe(400);
    expect((await receive(e, al, 1000000000)).status).toBe(400);
    expect(await counts()).toEqual(before);
  });
});

describe("correção que gera excedente: permitida, com motivo obrigatório e indicador; aprovação quando exigida", () => {
  it("correção POSITIVA acima do alocado e do necessário: 200 direto, +físico, ledger por par, auditoria com excedente", async () => {
    const e = await setup(120);
    const al = await allocation(e, 100);
    expect((await receive(e, al, 100)).status).toBe(200);
    const res = await correct(e, al, 150);
    expect(res.status).toBe(200);
    expect(await stockOf(e.itemId)).toBe(150); // +50 físico
    expect(await progress(e, e.needId, 120)).toEqual({ fulfilled: 150, requiredRemaining: 0, surplus: 30 });
    const rows = await ledger(al);
    expect(rows.map((r) => r.entryType)).toEqual(["original", "reversal", "correction"]); // o original permanece; par reversal+correction
    expect(rows[0].quantity).toBe("100.000");
    const [c] = await audits(al, "atribuicao.recebimento_corrigido");
    expect(c.m).toMatchObject({ quantidadeAnterior: 100, quantidadeNova: 150, excedenteAnterior: 0, excedente: 30, quantidadeAlocada: 100, acimaDaAlocacao: true, excedenteAlocacao: 50, efeitoEstoque: "ajuste", deltaFisico: 50 });
    expect(String(c.m.motivo)).toMatch(/Conferência/);
    // não é nova doação; a correção aparece como correção
    const r = await report(e);
    expect(r.summary.donations.total).toBe(1);
    expect(r.summary.corrections).toBe(1);
    expect(r.itemMovements[0]).toMatchObject({ entradas: 100, ajustesRede: 50, currentStock: 150 });
  });

  it("MOTIVO obrigatório: sem motivo ⇒ 400 e nada gravado", async () => {
    const e = await setup();
    const al = await allocation(e, 100);
    await receive(e, al, 100);
    const before = await counts();
    expect((await correct(e, al, 150, e.operador, null)).status).toBe(400);
    expect(await counts()).toEqual(before);
  });

  it("correção NEGATIVA exige dupla aprovação: 202 sem efeito; aprovada por OUTRA pessoa, reduz estoque e excedente; auditoria com o aprovador", async () => {
    const e = await setup(300);
    const al = await allocation(e, 100);
    await receive(e, al, 400); // excedente 100
    const before = await counts();
    const res = await correct(e, al, 350);
    expect(res.status).toBe(202);
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(res);
    expect(await stockOf(e.itemId)).toBe(400); // pedido não mexe em nada
    expect((await ledger(al)).length).toBe(1);
    expect((await counts()).stock).toBe(before.stock);
    const dec = await decide(e, approvalRequestId);
    expect(dec.status).toBe(200);
    expect(await stockOf(e.itemId)).toBe(350);
    expect(await progress(e, e.needId, 300)).toEqual({ fulfilled: 350, requiredRemaining: 0, surplus: 50 });
    const [c] = await audits(al, "atribuicao.recebimento_corrigido");
    expect(c.m).toMatchObject({ quantidadeAnterior: 400, quantidadeNova: 350, excedenteAnterior: 100, excedente: 50, approvalRequestId, acimaDaAlocacao: true, excedenteAlocacao: 250 });
    expect(c.m.solicitanteUserId).toBe(e.operador.userId);
  });

  it("sem permissão logística ⇒ 403 mesmo para uma correção que geraria excedente", async () => {
    const e = await setup();
    const al = await allocation(e, 100);
    await receive(e, al, 100);
    const before = await counts();
    expect((await correct(e, al, 500, e.voluntario)).status).toBe(403);
    expect(await counts()).toEqual(before);
  });
});

describe("reversão que reduz o saldo: o original permanece, o excedente desaparece, o físico só sai se pedido", () => {
  it("estorno com retirada física (aprovado): fulfilled volta, surplus 0, estoque −400, auditoria com excedente anterior; o original permanece", async () => {
    const e = await setup(300);
    const al = await allocation(e, 100);
    await receive(e, al, 400);
    const res = await reverse(e, al, true);
    expect(res.status).toBe(202);
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(res);
    expect((await decide(e, approvalRequestId)).status).toBe(200);
    expect(await stockOf(e.itemId)).toBe(0);
    expect(await progress(e, e.needId, 300)).toEqual({ fulfilled: 0, requiredRemaining: 300, surplus: 0 });
    const rows = await ledger(al);
    expect(rows.map((r) => r.entryType)).toEqual(["original", "reversal"]);
    expect(Number(rows[0].quantity)).toBe(400); // histórico original intacto
    const [x] = await audits(al, "atribuicao.recebimento_estornado");
    expect(x.m).toMatchObject({ excedenteAnterior: 100, excedente: 0, efeitoEstoque: "ajuste", retiradaFisica: true, approvalRequestId });
    const r = await report(e);
    expect(r.summary.donations.total).toBe(1); // a doação original continua contada uma vez
    expect(r.summary.reversals).toMatchObject({ total: 1, withWithdrawal: 1, accountingOnly: 0 });
    expect(r.itemMovements[0]).toMatchObject({ entradas: 400, ajustesRede: -400, currentStock: 0 });
  });

  it("estorno só CONTÁBIL (padrão): o excedente some do progresso, o estoque físico permanece (a realidade física não é alterada)", async () => {
    const e = await setup(300);
    const al = await allocation(e, 100);
    await receive(e, al, 400);
    const { approvalRequestId } = await parseJson<{ approvalRequestId: number }>(await reverse(e, al, false));
    expect((await decide(e, approvalRequestId)).status).toBe(200);
    expect(await stockOf(e.itemId)).toBe(400);
    expect(await progress(e, e.needId, 300)).toEqual({ fulfilled: 0, requiredRemaining: 300, surplus: 0 });
    const [x] = await audits(al, "atribuicao.recebimento_estornado");
    expect(x.m).toMatchObject({ efeitoEstoque: "nenhum", excedenteAnterior: 100, excedente: 0 });
    expect(x.m.stockTransactionId).toBeUndefined(); // sem movimento físico ligado
  });

  it("estorno inválido/sem permissão não deixa alteração parcial", async () => {
    const e = await setup();
    const al = await allocation(e, 100);
    await receive(e, al, 150);
    const before = await counts();
    expect((await reverse(e, al, true, e.voluntario)).status).toBe(403);
    expect(await counts()).toEqual(before);
  });
});
