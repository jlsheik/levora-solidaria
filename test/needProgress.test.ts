/**
 * Prova comportamental da camada de progresso da need (Fase 42):
 * `computeNeedProgress` (pura) e `getNeedFulfillmentBalanceBatch` (mesma
 * fórmula de `getNeedFulfillmentBalance`, em lote — evita N+1 numa
 * listagem). `fulfilled` é exclusivamente o saldo contábil do Modelo B
 * (recebimentos da rede); `needs.status` e `need_resolutions` nunca
 * entram nesse cálculo, e este helper nunca escreve em nenhum dos dois.
 *
 * Cenários usam só o que o Modelo B congelado permite estruturalmente —
 * nenhum reversal excede o quantity do seu alvo direto.
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { computeNeedProgress, getNeedFulfillmentBalanceBatch } from "../src/helpers/needFulfillment";
import {
  createAuthenticatedUser,
  createTestOrganization,
  createTestSource,
  createTestOpportunityRegistry,
  createTestInventoryItem,
  createTestAllocation,
} from "./helpers";

async function setupNeed(quantityNeeded: number, unit = "kg") {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const [need] = await db
    .insertInto("needs")
    .values({ organizationId: org.id, title: "Need Fase 42", quantityNeeded: String(quantityNeeded), unit, priority: "media", status: "aberta", createdByUserId: owner.userId })
    .returning(["id"])
    .execute();
  return { owner, org, needId: need.id };
}

async function addFulfillment(
  orgId: number,
  ownerId: number,
  needId: number,
  opts: { quantity: number; unit?: string; isCountable?: boolean; entryType?: "original" | "correction" | "reversal"; reversesFulfillmentId?: number | null; allocationId?: number }
): Promise<{ id: number; allocationId: number }> {
  let allocationId = opts.allocationId;
  let stockTransactionId: string | null = null;
  if (!allocationId) {
    const admin = await createAuthenticatedUser();
    const source = await createTestSource(admin.userId);
    const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "atribuida" });
    const allocation = await createTestAllocation(opportunity.id, orgId, { status: "aceita", quantityAllocated: opts.quantity });
    allocationId = allocation.id;
  }
  if (opts.entryType === "original" || opts.entryType === undefined) {
    const item = await createTestInventoryItem(orgId, ownerId, { unit: opts.unit ?? "kg" });
    const [tx] = await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId: item.id, type: "entrada", delta: String(opts.quantity) }).returning(["id"]).execute();
    stockTransactionId = tx.id;
  }
  const [row] = await db
    .insertInto("needFulfillments")
    .values({
      organizationId: orgId,
      needId,
      allocationId,
      stockTransactionId,
      quantity: String(opts.quantity),
      unit: opts.unit ?? "kg",
      entryType: opts.entryType ?? "original",
      isCountable: opts.isCountable ?? true,
      reversesFulfillmentId: opts.reversesFulfillmentId ?? null,
    })
    .returning(["id"])
    .execute();
  return { id: row.id, allocationId };
}

describe("computeNeedProgress (função pura) — fórmula", () => {
  it("caso A: sem recebimentos", () => {
    expect(computeNeedProgress(500, 0)).toEqual({ fulfilled: 0, requiredRemaining: 500, surplus: 0 });
  });

  it("caso B: parcial", () => {
    expect(computeNeedProgress(500, 200)).toEqual({ fulfilled: 200, requiredRemaining: 300, surplus: 0 });
  });

  it("caso C: total exato", () => {
    expect(computeNeedProgress(500, 500)).toEqual({ fulfilled: 500, requiredRemaining: 0, surplus: 0 });
  });

  it("caso D: over-fulfillment", () => {
    expect(computeNeedProgress(500, 650)).toEqual({ fulfilled: 650, requiredRemaining: 0, surplus: 150 });
  });

  it("precisão NUMERIC: valores fracionários de 3 casas decimais não perdem precisão", () => {
    expect(computeNeedProgress(500.125, 200.5)).toEqual({ fulfilled: 200.5, requiredRemaining: 299.625, surplus: 0 });
  });
});

describe("getNeedFulfillmentBalanceBatch — mesma fórmula de getNeedFulfillmentBalance, em lote", () => {
  it("caso E: efeito líquido de '+500 -100' (fulfilled=400) representado por uma sequência estruturalmente válida — reversal só pode reverter EXATAMENTE o quantity do seu alvo direto (Fase 33), nunca um valor arbitrário; aqui: original 400 + correction 100 + reversal -100 da correction", async () => {
    const { org, owner, needId } = await setupNeed(500);
    const original = await addFulfillment(org.id, owner.userId, needId, { quantity: 400 });
    const correction = await addFulfillment(org.id, owner.userId, needId, { quantity: 100, entryType: "correction", reversesFulfillmentId: original.id, allocationId: original.allocationId });
    await addFulfillment(org.id, owner.userId, needId, { quantity: 100, entryType: "reversal", reversesFulfillmentId: correction.id, allocationId: original.allocationId });

    const balances = await getNeedFulfillmentBalanceBatch(db, [needId]);
    const fulfilled = balances.get(needId) ?? 0;
    expect(fulfilled).toBe(400); // 400 + 100 - 100, mesmo efeito líquido de "+500 -100"
    expect(computeNeedProgress(500, fulfilled)).toEqual({ fulfilled: 400, requiredRemaining: 100, surplus: 0 });
  });

  it("caso F: original 200 + correction 100 + reversal -100 da correction -> fulfilled=200, requiredRemaining=300", async () => {
    const { org, owner, needId } = await setupNeed(500);
    const original = await addFulfillment(org.id, owner.userId, needId, { quantity: 200 });
    const correction = await addFulfillment(org.id, owner.userId, needId, { quantity: 100, entryType: "correction", reversesFulfillmentId: original.id, allocationId: original.allocationId });
    await addFulfillment(org.id, owner.userId, needId, { quantity: 100, entryType: "reversal", reversesFulfillmentId: correction.id, allocationId: original.allocationId });

    const balances = await getNeedFulfillmentBalanceBatch(db, [needId]);
    const fulfilled = balances.get(needId) ?? 0;
    expect(fulfilled).toBe(200);
    expect(computeNeedProgress(500, fulfilled)).toEqual({ fulfilled: 200, requiredRemaining: 300, surplus: 0 });
  });

  it("non-countable: evento presente no ledger mas fora do progresso (fulfilled=0, requiredRemaining=quantityNeeded)", async () => {
    const { org, owner, needId } = await setupNeed(500);
    await addFulfillment(org.id, owner.userId, needId, { quantity: 200, isCountable: false });

    const balances = await getNeedFulfillmentBalanceBatch(db, [needId]);
    const fulfilled = balances.get(needId) ?? 0;
    expect(fulfilled).toBe(0);
    expect(computeNeedProgress(500, fulfilled)).toEqual({ fulfilled: 0, requiredRemaining: 500, surplus: 0 });

    // O evento continua no ledger, auditável — só fora do progresso.
    const row = await db.selectFrom("needFulfillments").select(["quantity", "isCountable"]).where("needId", "=", needId).executeTakeFirstOrThrow();
    expect(Number(row.quantity)).toBe(200);
    expect(row.isCountable).toBe(false);
  });

  it("múltiplos fulfillments (3 originals): fulfilled é a soma de todos", async () => {
    const { org, owner, needId } = await setupNeed(500);
    await addFulfillment(org.id, owner.userId, needId, { quantity: 100 });
    await addFulfillment(org.id, owner.userId, needId, { quantity: 150 });
    await addFulfillment(org.id, owner.userId, needId, { quantity: 250 });

    const balances = await getNeedFulfillmentBalanceBatch(db, [needId]);
    expect(balances.get(needId)).toBe(500);
  });

  it("need atendida manualmente com fulfilled=0 (need_resolutions nunca entra no cálculo)", async () => {
    const { org, owner, needId } = await setupNeed(500);
    // Resolução administrativa (Fase 40) SEM nenhum need_fulfillment.
    await db.insertInto("needResolutions").values({ needId, stockTransactionId: null, createdByUserId: owner.userId }).execute();
    await db.updateTable("needs").set({ status: "atendida" }).where("id", "=", needId).execute();

    const balances = await getNeedFulfillmentBalanceBatch(db, [needId]);
    const fulfilled = balances.get(needId) ?? 0;
    expect(fulfilled).toBe(0);
    expect(computeNeedProgress(500, fulfilled)).toEqual({ fulfilled: 0, requiredRemaining: 500, surplus: 0 });

    const need = await db.selectFrom("needs").select(["status"]).where("id", "=", needId).executeTakeFirstOrThrow();
    expect(need.status).toBe("atendida"); // status independente, nunca sincronizado
  });

  it("need cancelada: progresso continua calculável normalmente, status permanece cancelada", async () => {
    const { org, owner, needId } = await setupNeed(500);
    await addFulfillment(org.id, owner.userId, needId, { quantity: 300 });
    await db.updateTable("needs").set({ status: "cancelada" }).where("id", "=", needId).execute();

    const balances = await getNeedFulfillmentBalanceBatch(db, [needId]);
    expect(computeNeedProgress(500, balances.get(needId) ?? 0)).toEqual({ fulfilled: 300, requiredRemaining: 200, surplus: 0 });

    const need = await db.selectFrom("needs").select(["status"]).where("id", "=", needId).executeTakeFirstOrThrow();
    expect(need.status).toBe("cancelada");
  });

  it("lote: calcula o progresso de várias needs em UMA única query (sem N+1) e needs sem fulfillment ficam ausentes do Map", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const [needA] = await db.insertInto("needs").values({ organizationId: org.id, title: "A", quantityNeeded: "500", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId }).returning(["id"]).execute();
    const [needB] = await db.insertInto("needs").values({ organizationId: org.id, title: "B", quantityNeeded: "300", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId }).returning(["id"]).execute();
    const [needC] = await db.insertInto("needs").values({ organizationId: org.id, title: "C (sem fulfillment)", quantityNeeded: "100", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId }).returning(["id"]).execute();

    await addFulfillment(org.id, owner.userId, needA.id, { quantity: 200 });
    await addFulfillment(org.id, owner.userId, needB.id, { quantity: 300 });

    const balances = await getNeedFulfillmentBalanceBatch(db, [needA.id, needB.id, needC.id]);
    expect(balances.get(needA.id)).toBe(200);
    expect(balances.get(needB.id)).toBe(300);
    expect(balances.has(needC.id)).toBe(false); // ausente, não zero explícito — o chamador trata com `?? 0`
    expect(computeNeedProgress(100, balances.get(needC.id) ?? 0)).toEqual({ fulfilled: 0, requiredRemaining: 100, surplus: 0 });
  });

  it("lote com array vazio retorna Map vazio sem consultar o banco", async () => {
    const balances = await getNeedFulfillmentBalanceBatch(db, []);
    expect(balances.size).toBe(0);
  });
});
