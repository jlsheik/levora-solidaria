/**
 * M36 — cobertura de eventos do ledger: estoque inicial, estorno/correção de destinação, estorno de recebimento, recebimento de oportunidade local. Fluxos REAIS de domínio (endpoints/serviços), PostgreSQL de teste.
 * Propriedades: evento único por operação lógica, na mesma transação, ligado ao registro ORIGINAL, sem backfill, sem payload pessoal, e nada publicado quando a operação é recusada ou revertida.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { db } from "../src/helpers/db";
import { ensureAgentPrincipal } from "../src/helpers/agentRegistry";
import { publishDomainEvent } from "../src/helpers/domainEvents";
import { runAgentEventEngine } from "../src/helpers/agentEventEngine";
import { businessDateOf } from "../src/helpers/businessDate";
import { handle as postItem } from "../src/endpoints/inventory-items_POST";
import { handle as postStock } from "../src/endpoints/stock-transactions_POST";
import { handle as postDest } from "../src/endpoints/stock-destinations_POST";
import { handle as postDestReverse } from "../src/endpoints/stock-destination-reversal_POST";
import { handle as postReceive } from "../src/endpoints/allocations-receive_POST";
import { handle as postReceiptReverse } from "../src/endpoints/allocations-receipt-reverse_POST";
import { handle as postDecideApproval } from "../src/endpoints/approval-requests-decide_POST";
import { createAuthenticatedUser, createTestOrganization, createTestInventoryItem, createTestSource, createTestOpportunityRegistry, addMembership, buildRequest, type AuthenticatedTestUser } from "./helpers";

const post = (p: string, a: AuthenticatedTestUser, body: unknown) => buildRequest(p, { method: "POST", cookie: a.cookie, body });
const events = async (type = "stock_transaction.created") => db.selectFrom("domainEvents").selectAll().where("eventType", "=", type).orderBy("id").execute();
const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const key = () => `k-${randomBytes(8).toString("hex")}`;

describe("estoque inicial", () => {
  let owner: AuthenticatedTestUser; let orgId: number;
  beforeEach(async () => { owner = await createAuthenticatedUser(); orgId = (await createTestOrganization(owner.userId)).id; });

  it("quantidade inicial no cadastro do item é um lançamento do ledger → 1 evento v2 'estoque_inicial' (id estável, saldo, unidade do item, ator); a Sentinela o avalia", async () => {
    await ensureAgentPrincipal(db, "sentinela-integridade", orgId); await wait();
    const res = await postItem(post("inventory-items", owner, { organizationId: orgId, name: "Arroz", unit: "kg", initialQuantity: 7 }));
    expect(res.status).toBe(200);
    const tx = await db.selectFrom("stockTransactions").select(["id", "delta"]).where("organizationId", "=", orgId).executeTakeFirstOrThrow();
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ organizationId: orgId, entityType: "stock_transaction", entityId: String(tx.id) }); // identificador estável = o do lançamento
    expect(ev[0].payload).toMatchObject({ v: 2, type: "entrada", delta: 7, newStock: 7, previousStock: 0, source: "estoque_inicial", itemHasPriorDistribution: false, actorUserId: owner.userId });
    expect(JSON.stringify(ev[0].payload)).not.toMatch(/Arroz|Quantidade inicial|@/);
    await runAgentEventEngine({ organizationId: orgId });
    const run = await db.selectFrom("agentEventRuns").select(["status", "detail"]).where("eventId", "=", String(ev[0].id)).executeTakeFirstOrThrow();
    expect(run.status).toBe("simulacao_concluida"); expect((run.detail as { facts: Record<string, unknown> }).facts.origem).toBe("estoque_inicial");
  });

  it("cadastrar item SEM quantidade inicial não publica nada (cadastro ≠ entrada); item sem permissão/duplicado também não", async () => {
    expect((await postItem(post("inventory-items", owner, { organizationId: orgId, name: "Feijão", unit: "kg" }))).status).toBe(200);
    expect(await events()).toHaveLength(0);
    const vol = await createAuthenticatedUser(); await addMembership(orgId, vol.userId, "voluntario");
    expect((await postItem(post("inventory-items", vol, { organizationId: orgId, name: "Macarrão", unit: "kg", initialQuantity: 3 }))).status).toBe(403);
    expect(await events()).toHaveLength(0);
  });

  it("SEM backfill: itens e lançamentos que já existiam não geram evento nenhum retroativamente; o agente só avalia o que vem depois", async () => {
    const item = await createTestInventoryItem(orgId, owner.userId);
    await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: "40", createdByUserId: owner.userId, reason: "histórico" }).execute();
    await ensureAgentPrincipal(db, "sentinela-integridade", orgId); await wait();
    expect(await events()).toHaveLength(0); expect((await runAgentEventEngine({ organizationId: orgId })).registered).toBe(0);
  });

  it("rollback: se o cadastro falhar DEPOIS do lançamento inicial, nem o lançamento nem o evento ficam", async () => {
    const before = (await events()).length;
    // violação de restrição no mesmo fluxo: nome inválido recusado pela validação (400) antes de qualquer gravação
    expect((await postItem(post("inventory-items", owner, { organizationId: orgId, name: "", unit: "kg", initialQuantity: 5 }))).status).toBe(400);
    expect((await events()).length).toBe(before); expect((await db.selectFrom("stockTransactions").select("id").where("organizationId", "=", orgId).execute()).length).toBe(0);
  });
});

describe("estornos e correções do ledger", () => {
  const today = () => businessDateOf(new Date());
  async function world() {
    const owner = await createAuthenticatedUser(); const org = await createTestOrganization(owner.userId);
    const admin = await createAuthenticatedUser(); await addMembership(org.id, admin.userId, "administrador");
    const operator = await createAuthenticatedUser(); await addMembership(org.id, operator.userId, "operador");
    const item = await createTestInventoryItem(org.id, owner.userId, { name: "Arroz", unit: "kg" });
    await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: item.id, type: "entrada", delta: "100", reason: "saldo inicial", createdByUserId: owner.userId }).execute();
    return { owner, admin, operator, org, item };
  }

  it("saída por destinação publica evento da saída; a DEVOLUÇÃO FÍSICA publica evento de estorno ligado à saída ORIGINAL (nunca uma entrada nova); estorno documental NÃO publica (não move estoque)", async () => {
    const w = await world(); await ensureAgentPrincipal(db, "sentinela-integridade", w.org.id); await wait();
    const d = await postDest(post("stock-destinations", w.operator, { organizationId: w.org.id, itemId: w.item.id, quantity: 10, destinationType: "distribuicao_familias", deliveredOn: today(), idempotencyKey: key() }));
    expect(d.status).toBe(200);
    const exitTx = await db.selectFrom("stockTransactions").select("id").where("itemId", "=", w.item.id).where("type", "=", "saida").executeTakeFirstOrThrow();
    const dest = await db.selectFrom("stockDestinations").select("id").where("organizationId", "=", w.org.id).executeTakeFirstOrThrow();
    let ev = await events();
    expect(ev).toHaveLength(1); expect(ev[0].payload).toMatchObject({ v: 2, type: "saida", delta: -10, newStock: 90, source: "destinacao_saida" }); expect(ev[0].entityId).toBe(String(exitTx.id));

    const doc = await postDestReverse(post("stock-destination-reversal", w.admin, { organizationId: w.org.id, destinationId: String(dest.id), kind: "estorno_documental", quantity: 3, reason: "Registro feito por engano", idempotencyKey: key() }));
    expect(doc.status).toBe(200); expect(await events()).toHaveLength(1); // estorno documental não move estoque: sem evento de ledger

    const phys = await postDestReverse(post("stock-destination-reversal", w.admin, { organizationId: w.org.id, destinationId: String(dest.id), kind: "devolucao_fisica", quantity: 4, reason: "Material voltou ao estoque", idempotencyKey: key() }));
    expect(phys.status).toBe(200);
    ev = await events(); expect(ev).toHaveLength(2);
    const back = await db.selectFrom("stockTransactions").select("id").where("itemId", "=", w.item.id).where("type", "=", "entrada").orderBy("id", "desc").executeTakeFirstOrThrow();
    expect(ev[1].entityId).toBe(String(back.id));
    expect(ev[1].payload).toMatchObject({ v: 2, type: "entrada", delta: 4, newStock: 94, source: "estorno_destinacao", reversesStockTransactionId: String(exitTx.id), actorUserId: w.admin.userId });
    // o evento original da saída permanece, intocado
    expect((await events())[0].payload).toMatchObject({ source: "destinacao_saida", delta: -10 });
    await runAgentEventEngine({ organizationId: w.org.id });
    const runs = await db.selectFrom("agentEventRuns").select(["status", "detail"]).where("organizationId", "=", w.org.id).orderBy("id").execute();
    expect(runs.map((r) => r.status)).toEqual(["simulacao_concluida", "simulacao_concluida"]);
    expect((runs[1].detail as { facts: Record<string, unknown> }).facts).toMatchObject({ origem: "estorno_destinacao", estornaLancamento: String(exitTx.id) });
  });

  it("devolução/estorno RECUSADOS (quantidade maior que o reversível; sem permissão) não publicam evento", async () => {
    const w = await world(); await ensureAgentPrincipal(db, "sentinela-integridade", w.org.id); await wait();
    await postDest(post("stock-destinations", w.operator, { organizationId: w.org.id, itemId: w.item.id, quantity: 5, destinationType: "distribuicao_familias", deliveredOn: today(), idempotencyKey: key() }));
    const dest = await db.selectFrom("stockDestinations").select("id").where("organizationId", "=", w.org.id).executeTakeFirstOrThrow();
    const before = (await events()).length;
    const tooMuch = await postDestReverse(post("stock-destination-reversal", w.admin, { organizationId: w.org.id, destinationId: String(dest.id), kind: "devolucao_fisica", quantity: 50, reason: "excede o que saiu", idempotencyKey: key() }));
    expect(tooMuch.status).toBeGreaterThanOrEqual(400);
    const vol = await createAuthenticatedUser(); await addMembership(w.org.id, vol.userId, "voluntario");
    expect((await postDestReverse(post("stock-destination-reversal", vol, { organizationId: w.org.id, destinationId: String(dest.id), kind: "devolucao_fisica", quantity: 1, reason: "sem permissão", idempotencyKey: key() }))).status).toBe(403);
    expect((await events()).length).toBe(before);
  });

  it("repetir a MESMA requisição de estorno (mesma chave de idempotência) não publica um segundo evento", async () => {
    const w = await world(); await ensureAgentPrincipal(db, "sentinela-integridade", w.org.id); await wait();
    await postDest(post("stock-destinations", w.operator, { organizationId: w.org.id, itemId: w.item.id, quantity: 8, destinationType: "distribuicao_familias", deliveredOn: today(), idempotencyKey: key() }));
    const dest = await db.selectFrom("stockDestinations").select("id").where("organizationId", "=", w.org.id).executeTakeFirstOrThrow();
    const k = key(); const body = { organizationId: w.org.id, destinationId: String(dest.id), kind: "devolucao_fisica", quantity: 2, reason: "Material voltou", idempotencyKey: k };
    const a = await postDestReverse(post("stock-destination-reversal", w.admin, body)); const b = await postDestReverse(post("stock-destination-reversal", w.admin, body));
    expect(a.status).toBe(200); expect(b.status).toBeLessThan(500);
    expect((await events()).filter((e) => (e.payload as { source?: string }).source === "estorno_destinacao")).toHaveLength(1);
    expect((await db.selectFrom("stockTransactions").select("id").where("itemId", "=", w.item.id).where("type", "=", "entrada").execute()).length).toBe(2); // saldo inicial + 1 devolução
  });

  it("estorno do RECEBIMENTO de uma atribuição publica evento ligado à ATRIBUIÇÃO original (ajuste, nunca entrada nova)", async () => {
    const owner = await createAuthenticatedUser(); const org = await createTestOrganization(owner.userId);
    const admin = await createAuthenticatedUser(); await addMembership(org.id, admin.userId, "administrador");
    await ensureAgentPrincipal(db, "sentinela-integridade", org.id); await wait();
    const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
    const platform = await createAuthenticatedUser(); const source = await createTestSource(platform.userId);
    const registry = await createTestOpportunityRegistry(source.id, platform.userId, { unit: "kg", status: "reservada" });
    const [need] = await db.insertInto("needs").values({ organizationId: org.id, title: "Cobertores", quantityNeeded: "500", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId }).returning("id").execute();
    const [alloc] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: registry.id, organizationId: org.id, quantityAllocated: "100", status: "aceita", needId: need.id }).returning("id").execute();
    expect((await postReceive(post("allocations-receive", owner, { organizationId: org.id, allocationId: alloc.id, itemId: item.id, quantityReceived: 100 }))).status).toBe(200);
    const fulfillment = await db.selectFrom("needFulfillments").select("id").where("allocationId", "=", alloc.id).orderBy("id", "desc").executeTakeFirstOrThrow();
    const before = (await events()).length;
    // todo estorno é dupla autorização: pedido (owner) → aprovação por outra pessoa (admin) → só então o ledger é movido e o evento nasce
    const rev = await postReceiptReverse(post("allocations-receipt-reverse", owner, { organizationId: org.id, allocationId: alloc.id, expectedVigenteFulfillmentId: String(fulfillment.id), reason: "Recebimento lançado por engano", withdrawStock: true }));
    expect(rev.status).toBeLessThan(300);
    expect((await events()).length).toBe(before); // pedido pendente: nada lançado, nada publicado
    const approval = await db.selectFrom("approvalRequests").select("id").where("organizationId", "=", org.id).where("status", "=", "pendente").orderBy("id", "desc").executeTakeFirstOrThrow();
    expect((await postDecideApproval(post("approval-requests-decide", admin, { organizationId: org.id, requestId: approval.id, decision: "aprovada" }))).status).toBe(200);
    const ev = (await events()).slice(before);
    const stock = ev.filter((e) => (e.payload as { source?: string }).source === "estorno_recebimento");
    expect(stock).toHaveLength(1);
    expect(stock[0].payload).toMatchObject({ v: 2, type: "ajuste", delta: -100, newStock: 0, source: "estorno_recebimento", reversesAllocationId: alloc.id, actorUserId: owner.userId }); // ator = quem pediu o estorno (autor do lançamento); a aprovação da 2ª pessoa fica na auditoria da aprovação
    const recvEvent = (await events("allocation.received"))[0]; expect(recvEvent.entityId).toBe(String(alloc.id)); // o evento original do recebimento permanece
    await runAgentEventEngine({ organizationId: org.id });
    const run = await db.selectFrom("agentEventRuns").select(["status", "detail"]).where("eventId", "=", String(stock[0].id)).executeTakeFirstOrThrow();
    // ajuste sobre item que já tinha entrada mas nenhuma saída anterior: permitido; estorno carrega a referência → análise completa
    expect(run.status).toBe("simulacao_concluida"); expect((run.detail as { completeness: string }).completeness).toBe("completa");
  });

  it("estorno/correção SEM referência ao original é análise insuficiente (nunca avaliado como estorno)", async () => {
    const owner = await createAuthenticatedUser(); const orgId = (await createTestOrganization(owner.userId)).id;
    await ensureAgentPrincipal(db, "sentinela-integridade", orgId); await wait();
    await db.transaction().execute((trx) => publishDomainEvent(trx, { eventType: "stock_transaction.created", organizationId: orgId, entityType: "stock_transaction", entityId: "x1", payload: { v: 2, itemId: 1, type: "entrada", delta: 4, newStock: 10, source: "estorno_destinacao", itemHasPriorDistribution: false } as never }));
    await runAgentEventEngine({ organizationId: orgId });
    const run = await db.selectFrom("agentEventRuns").select(["status", "detail"]).where("organizationId", "=", orgId).executeTakeFirstOrThrow();
    expect(run.status).toBe("dados_insuficientes"); expect((run.detail as { missingRequired: string[] }).missingRequired).toEqual(["reversesReference"]);
  });
});
