/**
 * Prova comportamental do isolamento multi-tenant do lastro físico de
 * `need_fulfillments` (Fase 33, migration 0010): FK composta
 * (stock_transaction_id, organization_id) → stock_transactions(id,
 * organization_id) garante ESTRUTURALMENTE que um fulfillment nunca
 * referencia um stock_transaction de outra organização — antes desta
 * migration isso era aceito (achado de auditoria, reproduzido em
 * transação temporária, nada persistido).
 *
 * Compatibilidade física ALÉM da organização (item/unidade/quantidade/
 * direção do movimento) permanece deliberadamente sem validação
 * estrutural — não existe, hoje, uma fonte canônica desses dados na
 * cadeia allocation→opportunity/need (ver comentário em db/schema.sql).
 * Esta suíte não testa isso por não ser uma regra implementada.
 *
 * Ver db/migrations/0010_need_fulfillments_stock_transaction_org_fk.sql.
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { getNeedFulfillmentBalance } from "../src/helpers/needFulfillment";
import {
  createAuthenticatedUser,
  createTestOrganization,
  createTestSource,
  createTestOpportunityRegistry,
  createTestInventoryItem,
  createTestAllocation,
} from "./helpers";

async function setupAllocation(orgId: number, ownerId: number) {
  const admin = await createAuthenticatedUser();
  const source = await createTestSource(admin.userId);
  const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "atribuida" });
  const allocation = await createTestAllocation(opportunity.id, orgId, { status: "aceita", quantityAllocated: 200 });
  return allocation;
}

describe("need_fulfillments — isolamento multi-tenant do lastro físico (stock_transaction_id) — Fase 33", () => {
  it("organização: fulfillment da org A referenciando stock_transaction da PRÓPRIA org A -> aceito", async () => {
    const owner = await createAuthenticatedUser();
    const orgA = await createTestOrganization(owner.userId);
    const itemA = await createTestInventoryItem(orgA.id, owner.userId, { unit: "kg" });
    const allocation = await setupAllocation(orgA.id, owner.userId);
    const [txA] = await db.insertInto("stockTransactions").values({ organizationId: orgA.id, itemId: itemA.id, type: "entrada", delta: "200" }).returning(["id"]).execute();

    await expect(
      db
        .insertInto("needFulfillments")
        .values({ organizationId: orgA.id, needId: null, allocationId: allocation.id, stockTransactionId: txA.id, quantity: "200", unit: "kg", entryType: "original" })
        .execute()
    ).resolves.not.toThrow();
  });

  it("organização: fulfillment da org A referenciando stock_transaction da org B -> rejeitado pelo banco (FK composta)", async () => {
    const ownerA = await createAuthenticatedUser();
    const orgA = await createTestOrganization(ownerA.userId);
    const ownerB = await createAuthenticatedUser();
    const orgB = await createTestOrganization(ownerB.userId);
    const itemB = await createTestInventoryItem(orgB.id, ownerB.userId, { unit: "kg" });
    const allocation = await setupAllocation(orgA.id, ownerA.userId);
    const [txB] = await db.insertInto("stockTransactions").values({ organizationId: orgB.id, itemId: itemB.id, type: "entrada", delta: "999" }).returning(["id"]).execute();

    await expect(
      db
        .insertInto("needFulfillments")
        .values({ organizationId: orgA.id, needId: null, allocationId: allocation.id, stockTransactionId: txB.id, quantity: "200", unit: "kg", entryType: "original" })
        .execute()
    ).rejects.toThrow(/need_fulfillments_stock_transaction_org_fkey/);
  });

  it("organização: correction da org A referenciando stock_transaction da org B -> rejeitado (mesma FK composta vale para correction)", async () => {
    const ownerA = await createAuthenticatedUser();
    const orgA = await createTestOrganization(ownerA.userId);
    const itemA = await createTestInventoryItem(orgA.id, ownerA.userId, { unit: "kg" });
    const ownerB = await createAuthenticatedUser();
    const orgB = await createTestOrganization(ownerB.userId);
    const itemB = await createTestInventoryItem(orgB.id, ownerB.userId, { unit: "kg" });
    const allocation = await setupAllocation(orgA.id, ownerA.userId);
    const [txA] = await db.insertInto("stockTransactions").values({ organizationId: orgA.id, itemId: itemA.id, type: "entrada", delta: "200" }).returning(["id"]).execute();
    const [original] = await db
      .insertInto("needFulfillments")
      .values({ organizationId: orgA.id, needId: null, allocationId: allocation.id, stockTransactionId: txA.id, quantity: "200", unit: "kg", entryType: "original" })
      .returning(["id"])
      .execute();
    const [txB] = await db.insertInto("stockTransactions").values({ organizationId: orgB.id, itemId: itemB.id, type: "ajuste", delta: "10" }).returning(["id"]).execute();

    await expect(
      db
        .insertInto("needFulfillments")
        .values({ organizationId: orgA.id, needId: null, allocationId: allocation.id, stockTransactionId: txB.id, quantity: "100", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id })
        .execute()
    ).rejects.toThrow(/need_fulfillments_stock_transaction_org_fkey/);
  });

  it("correction com stock_transaction_id de um movimento físico REAL da própria organização -> aceito (correction física)", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
    const allocation = await setupAllocation(org.id, owner.userId);
    const [txOriginal] = await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: item.id, type: "entrada", delta: "200" }).returning(["id"]).execute();
    const [original] = await db
      .insertInto("needFulfillments")
      .values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: txOriginal.id, quantity: "200", unit: "kg", entryType: "original" })
      .returning(["id"])
      .execute();
    const [txAjuste] = await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: item.id, type: "ajuste", delta: "10" }).returning(["id"]).execute();

    await expect(
      db
        .insertInto("needFulfillments")
        .values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: txAjuste.id, quantity: "100", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id })
        .execute()
    ).resolves.not.toThrow();
  });

  it("correction com stock_transaction_id = NULL (correção interpretativa, sem novo movimento físico) -> aceito", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
    const allocation = await setupAllocation(org.id, owner.userId);
    const [tx] = await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: item.id, type: "entrada", delta: "200" }).returning(["id"]).execute();
    const [original] = await db
      .insertInto("needFulfillments")
      .values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: tx.id, quantity: "200", unit: "kg", entryType: "original" })
      .returning(["id"])
      .execute();

    await expect(
      db
        .insertInto("needFulfillments")
        .values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "100", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id })
        .execute()
    ).resolves.not.toThrow();
  });

  it("UNIQUE(stock_transaction_id): dois fulfillments para o MESMO stock_transaction -> rejeitado (índice preservado pela migration 0010)", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
    const allocationA = await setupAllocation(org.id, owner.userId);
    const allocationB = await setupAllocation(org.id, owner.userId);
    const [tx] = await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: item.id, type: "entrada", delta: "200" }).returning(["id"]).execute();

    await db
      .insertInto("needFulfillments")
      .values({ organizationId: org.id, needId: null, allocationId: allocationA.id, stockTransactionId: tx.id, quantity: "200", unit: "kg", entryType: "original" })
      .execute();

    await expect(
      db
        .insertInto("needFulfillments")
        .values({ organizationId: org.id, needId: null, allocationId: allocationB.id, stockTransactionId: tx.id, quantity: "50", unit: "kg", entryType: "original" })
        .execute()
    ).rejects.toThrow(/need_fulfillments_stock_transaction_id_key/);
  });

  it("múltiplos stock_transaction_id = NULL continuam permitidos (UNIQUE não colide em NULL) e o saldo contábil ignora stock_transaction_id", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
    const [need] = await db.insertInto("needs").values({ organizationId: org.id, title: "Need Fase 33", quantityNeeded: "500", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId }).returning(["id"]).execute();
    const allocation = await setupAllocation(org.id, owner.userId);
    const [tx] = await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: item.id, type: "entrada", delta: "200" }).returning(["id"]).execute();
    const [original] = await db
      .insertInto("needFulfillments")
      .values({ organizationId: org.id, needId: need.id, allocationId: allocation.id, stockTransactionId: tx.id, quantity: "200", unit: "kg", entryType: "original" })
      .returning(["id"])
      .execute();

    const [correction] = await db
      .insertInto("needFulfillments")
      .values({ organizationId: org.id, needId: need.id, allocationId: allocation.id, stockTransactionId: null, quantity: "100", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id })
      .returning(["id"])
      .execute();
    await db
      .insertInto("needFulfillments")
      .values({ organizationId: org.id, needId: need.id, allocationId: allocation.id, stockTransactionId: null, quantity: "100", unit: "kg", entryType: "reversal", reversesFulfillmentId: correction.id })
      .execute();

    const balance = await getNeedFulfillmentBalance(db, need.id);
    expect(balance).toBe(200); // 200 (original) + 100 (correction) - 100 (reversal) = 200; stock_transaction_id nunca entra na fórmula
  });
});
