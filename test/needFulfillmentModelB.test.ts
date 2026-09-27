/**
 * Prova comportamental definitiva do Modelo B de `need_fulfillments`
 * (Fase 32, corrigindo lacunas encontradas na auditoria da Fase 31/32):
 * herança estrutural de `organization_id`/`need_id` entre correction/
 * reversal e a linha referenciada; `reversal` herda TAMBÉM unit/quantity/
 * is_countable (é a reversão direta do evento apontado, nunca um evento
 * com dados próprios); no máximo uma reversal direta por alvo (protegido
 * por índice único, não só por checagem de aplicação); cadeias
 * (`correction→correction`, `reversal→correction`) continuam permitidas
 * deliberadamente; ciclos continuam estruturalmente impossíveis.
 *
 * Ver db/migrations/0009_need_fulfillments_inheritance_rules.sql e
 * src/helpers/needFulfillment.tsx (`getNeedFulfillmentBalance`, a fórmula
 * canônica de saldo).
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

async function setupOriginal(overrides: { needId?: number | null; isCountable?: boolean; unit?: string; quantity?: number; ownerId?: number; orgId?: number; itemName?: string } = {}) {
  const owner = overrides.ownerId ? { userId: overrides.ownerId } : await createAuthenticatedUser();
  const org = overrides.orgId ? { id: overrides.orgId } : await createTestOrganization(owner.userId);
  const item = await createTestInventoryItem(org.id, owner.userId, { name: overrides.itemName ?? `Item Modelo B ${Date.now()}-${Math.random()}`, unit: overrides.unit ?? "kg" });
  const admin = await createAuthenticatedUser();
  const source = await createTestSource(admin.userId);
  const opportunity = await createTestOpportunityRegistry(source.id, admin.userId, { status: "atribuida" });
  const allocation = await createTestAllocation(opportunity.id, org.id, { status: "aceita", quantityAllocated: overrides.quantity ?? 200 });
  const [tx] = await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: item.id, type: "entrada", delta: String(overrides.quantity ?? 200) }).returning(["id"]).execute();
  const [original] = await db
    .insertInto("needFulfillments")
    .values({
      organizationId: org.id,
      needId: overrides.needId ?? null,
      allocationId: allocation.id,
      stockTransactionId: tx.id,
      quantity: String(overrides.quantity ?? 200),
      unit: overrides.unit ?? "kg",
      entryType: "original",
      isCountable: overrides.isCountable ?? true,
    })
    .returning(["id"])
    .execute();
  return { owner, org, item, opportunityId: opportunity.id, allocation, original };
}

async function makeNeed(orgId: number, ownerId: number, unit = "kg") {
  const [need] = await db.insertInto("needs").values({ organizationId: orgId, title: "Need Modelo B", quantityNeeded: "500", unit, priority: "media", status: "aberta", createdByUserId: ownerId }).returning(["id"]).execute();
  return need.id;
}

describe("Modelo B — testes obrigatórios A-X", () => {
  it("A: correction sem reverses_fulfillment_id -> rejeitado", async () => {
    const { org, allocation } = await setupOriginal();
    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "10", unit: "kg", entryType: "correction" }).execute()
    ).rejects.toThrow(/exige reverses_fulfillment_id/);
  });

  it("B: correction -> original -> permitido", async () => {
    const { org, allocation, original } = await setupOriginal();
    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "10", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id }).execute()
    ).resolves.not.toThrow();
  });

  it("C: correction -> correction -> permitido (cadeia)", async () => {
    const { org, allocation, original } = await setupOriginal();
    const [c1] = await db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "10", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id }).returning(["id"]).execute();
    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "5", unit: "kg", entryType: "correction", reversesFulfillmentId: c1.id }).execute()
    ).resolves.not.toThrow();
  });

  it("D: reversal -> original -> permitido (herda unit/quantity/is_countable/need_id/organization_id)", async () => {
    const { org, allocation, original } = await setupOriginal({ quantity: 200, unit: "kg", isCountable: true });
    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "200", unit: "kg", entryType: "reversal", isCountable: true, reversesFulfillmentId: original.id }).execute()
    ).resolves.not.toThrow();
  });

  it("E: reversal -> correction -> permitido", async () => {
    const { org, allocation, original } = await setupOriginal();
    const [correction] = await db
      .insertInto("needFulfillments")
      .values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "50", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id })
      .returning(["id"])
      .execute();
    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "50", unit: "kg", entryType: "reversal", isCountable: true, reversesFulfillmentId: correction.id }).execute()
    ).resolves.not.toThrow();
  });

  it("F: qualquer referência a uma linha 'reversal' -> bloqueada", async () => {
    const { org, allocation, original } = await setupOriginal();
    const [reversal] = await db
      .insertInto("needFulfillments")
      .values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "200", unit: "kg", entryType: "reversal", isCountable: true, reversesFulfillmentId: original.id })
      .returning(["id"])
      .execute();
    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "1", unit: "kg", entryType: "correction", reversesFulfillmentId: reversal.id }).execute()
    ).rejects.toThrow(/já é entry_type=reversal/);
  });

  it("G: tentativa de allocation diferente da referenciada -> bloqueada", async () => {
    const { org, original } = await setupOriginal();
    const other = await setupOriginal(); // allocation completamente diferente
    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: other.allocation.id, stockTransactionId: null, quantity: "10", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id }).execute()
    ).rejects.toThrow(/mesma allocation_id/);
  });

  it("H: organization_id diferente do alvo, mesmo com allocation_id correta -> bloqueado especificamente pela nova regra de organization_id (achado corrigido)", async () => {
    // Usa a allocation/organização corretas em tudo, MAS declara um
    // organization_id de outra organização no INSERT — isola exatamente a
    // checagem de organization_id (não a de allocation_id, já coberta por G).
    const { allocation, original } = await setupOriginal();
    const orgB = await createAuthenticatedUser().then((u) => createTestOrganization(u.userId));

    await expect(
      db.insertInto("needFulfillments").values({ organizationId: orgB.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "10", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id }).execute()
    ).rejects.toThrow(/organization_id precisa ser igual/);
  });

  it("I: tentativa de need_id diferente do alvo -> bloqueada (herança obrigatória)", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const needA = await makeNeed(org.id, owner.userId);
    const needB = await makeNeed(org.id, owner.userId);
    const { allocation, original } = await setupOriginal({ needId: needA, ownerId: owner.userId, orgId: org.id });

    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: needB, allocationId: allocation.id, stockTransactionId: null, quantity: "10", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id }).execute()
    ).rejects.toThrow(/need_id é herdado/);
  });

  it("I2: correction herdando o MESMO need_id do alvo (needId=123) -> permitido", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const needId = await makeNeed(org.id, owner.userId);
    const { allocation, original } = await setupOriginal({ needId, ownerId: owner.userId, orgId: org.id });

    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId, allocationId: allocation.id, stockTransactionId: null, quantity: "10", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id }).execute()
    ).resolves.not.toThrow();
  });

  it("I3: alvo com need_id=NULL -> correction TAMBÉM precisa ter need_id=NULL", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const needId = await makeNeed(org.id, owner.userId);
    const { allocation, original } = await setupOriginal({ needId: null, ownerId: owner.userId, orgId: org.id });

    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId, allocationId: allocation.id, stockTransactionId: null, quantity: "10", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id }).execute()
    ).rejects.toThrow(/need_id é herdado/);

    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "10", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id }).execute()
    ).resolves.not.toThrow();
  });

  it("J: reversal com unit diferente do alvo -> bloqueado", async () => {
    const { org, allocation, original } = await setupOriginal({ unit: "kg", quantity: 200 });
    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "200", unit: "litros", entryType: "reversal", isCountable: true, reversesFulfillmentId: original.id }).execute()
    ).rejects.toThrow(/mesma unit/);
  });

  it("K: reversal com quantity diferente do alvo -> bloqueado", async () => {
    const { org, allocation, original } = await setupOriginal({ quantity: 200 });
    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "150", unit: "kg", entryType: "reversal", isCountable: true, reversesFulfillmentId: original.id }).execute()
    ).rejects.toThrow(/mesma quantity/);
  });

  it("L: reversal com is_countable diferente do alvo -> bloqueado", async () => {
    const { org, allocation, original } = await setupOriginal({ isCountable: true });
    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "200", unit: "kg", entryType: "reversal", isCountable: false, reversesFulfillmentId: original.id }).execute()
    ).rejects.toThrow(/mesmo is_countable/);
  });

  it("M: segunda reversal DIRETA do mesmo alvo -> bloqueada pelo índice único (sequencial)", async () => {
    const { org, allocation, original } = await setupOriginal();
    await db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "200", unit: "kg", entryType: "reversal", isCountable: true, reversesFulfillmentId: original.id }).execute();

    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "200", unit: "kg", entryType: "reversal", isCountable: true, reversesFulfillmentId: original.id }).execute()
    ).rejects.toThrow(/idx_need_fulfillments_one_reversal_per_target|duplicate key/);
  });

  it("N: duas reversões CONCORRENTES do mesmo alvo -> só uma persiste (proteção no banco, não na aplicação)", async () => {
    const { org, allocation, original } = await setupOriginal();

    const [r1, r2] = await Promise.allSettled([
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "200", unit: "kg", entryType: "reversal", isCountable: true, reversesFulfillmentId: original.id }).execute(),
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "200", unit: "kg", entryType: "reversal", isCountable: true, reversesFulfillmentId: original.id }).execute(),
    ]);
    const outcomes = [r1.status, r2.status];
    expect(outcomes.filter((s) => s === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((s) => s === "rejected")).toHaveLength(1);

    const reversals = await db.selectFrom("needFulfillments").select((eb) => eb.fn.countAll().as("c")).where("entryType", "=", "reversal").where("reversesFulfillmentId", "=", original.id).executeTakeFirstOrThrow();
    expect(Number(reversals.c)).toBe(1);
  });

  it("N2: duas corrections legítimas concorrentes para o mesmo alvo continuam permitidas (não introduzimos unicidade artificial)", async () => {
    const { org, allocation, original } = await setupOriginal();
    const [r1, r2] = await Promise.allSettled([
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "10", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id }).execute(),
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "20", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id }).execute(),
    ]);
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
    const corrections = await db.selectFrom("needFulfillments").select((eb) => eb.fn.countAll().as("c")).where("entryType", "=", "correction").executeTakeFirstOrThrow();
    expect(Number(corrections.c)).toBe(2);
  });

  it("O: original + correction + reversal -> histórico reconstruível via allocation_id", async () => {
    const { org, allocation, original } = await setupOriginal();
    await db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "10", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id }).execute();
    await db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "200", unit: "kg", entryType: "reversal", isCountable: true, reversesFulfillmentId: original.id }).execute();

    const rows = await db.selectFrom("needFulfillments").select(["entryType"]).where("allocationId", "=", allocation.id).execute();
    expect(rows.map((r) => r.entryType).sort()).toEqual(["correction", "original", "reversal"]);
  });

  it("P: original non-countable + correction countable -> saldo canônico reflete só a correção", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const needId = await makeNeed(org.id, owner.userId, "kg");
    const { allocation, original } = await setupOriginal({ needId, isCountable: false, unit: "unidades", quantity: 200, ownerId: owner.userId, orgId: org.id });
    await db.insertInto("needFulfillments").values({ organizationId: org.id, needId, allocationId: allocation.id, stockTransactionId: null, quantity: "150", unit: "kg", entryType: "correction", isCountable: true, reversesFulfillmentId: original.id }).execute();

    const balance = await getNeedFulfillmentBalance(db, needId);
    expect(balance).toBe(150); // o original (200, unidades) não conta; só a correção (150, kg) conta
  });

  it("Q: cadeia de profundidade 3 (correction->correction->correction) -> permitida", async () => {
    const { org, allocation, original } = await setupOriginal();
    const [c1] = await db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "10", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id }).returning(["id"]).execute();
    const [c2] = await db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "20", unit: "kg", entryType: "correction", reversesFulfillmentId: c1.id }).returning(["id"]).execute();
    await expect(
      db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "30", unit: "kg", entryType: "correction", reversesFulfillmentId: c2.id }).execute()
    ).resolves.not.toThrow();
  });

  it("R: ciclo real (F1 apontar de volta para F2 depois de F2 já referenciar F1) -> impossível (append-only bloqueia)", async () => {
    const { org, allocation, original } = await setupOriginal();
    const [c1] = await db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "10", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id }).returning(["id"]).execute();
    await expect(
      db.updateTable("needFulfillments").set({ reversesFulfillmentId: c1.id }).where("id", "=", original.id).execute()
    ).rejects.toThrow(/append-only/);
  });

  it("S/T/U: append-only bloqueia UPDATE/DELETE em original, correction e reversal", async () => {
    const { org, allocation, original } = await setupOriginal();
    const [correction] = await db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "10", unit: "kg", entryType: "correction", reversesFulfillmentId: original.id }).returning(["id"]).execute();
    const [reversal] = await db.insertInto("needFulfillments").values({ organizationId: org.id, needId: null, allocationId: allocation.id, stockTransactionId: null, quantity: "200", unit: "kg", entryType: "reversal", isCountable: true, reversesFulfillmentId: original.id }).returning(["id"]).execute();

    for (const id of [original.id, correction.id, reversal.id]) {
      await expect(db.updateTable("needFulfillments").set({ quantity: "1" }).where("id", "=", id).execute()).rejects.toThrow(/append-only/);
      await expect(db.deleteFrom("needFulfillments").where("id", "=", id).execute()).rejects.toThrow(/append-only/);
    }
  });

  it("V: cálculo canônico do saldo (getNeedFulfillmentBalance) confere original+correction-reversal, ignorando non-countable", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const needId = await makeNeed(org.id, owner.userId);
    const { allocation, original } = await setupOriginal({ needId, isCountable: true, quantity: 200, ownerId: owner.userId, orgId: org.id });
    const [correction] = await db
      .insertInto("needFulfillments")
      .values({ organizationId: org.id, needId, allocationId: allocation.id, stockTransactionId: null, quantity: "100", unit: "kg", entryType: "correction", isCountable: true, reversesFulfillmentId: original.id })
      .returning(["id"])
      .execute();
    // reversal precisa herdar EXATAMENTE unit/quantity/is_countable do alvo direto (migration 0009) —
    // reverte a correction (quantity=100) por inteiro, não um valor arbitrário.
    await db.insertInto("needFulfillments").values({ organizationId: org.id, needId, allocationId: allocation.id, stockTransactionId: null, quantity: "100", unit: "kg", entryType: "reversal", isCountable: true, reversesFulfillmentId: correction.id }).execute();

    // Uma linha non-countable extra, associada a outra allocation da MESMA need, não deve contar.
    await setupOriginal({ needId, isCountable: false, unit: "litros", quantity: 999, ownerId: owner.userId, orgId: org.id });

    const balance = await getNeedFulfillmentBalance(db, needId);
    expect(balance).toBe(200); // 200 (original) + 100 (correction) - 100 (reversal da correction) = 200; os 999 non-countable ficam de fora
  });

  it("W: over-fulfillment (soma contabilizável > quantity_needed) continua representável sem bloqueio", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const [need] = await db.insertInto("needs").values({ organizationId: org.id, title: "Need pequena", quantityNeeded: "50", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId }).returning(["id"]).execute();
    await setupOriginal({ needId: need.id, isCountable: true, quantity: 600 });

    const balance = await getNeedFulfillmentBalance(db, need.id);
    expect(balance).toBe(600); // muito acima de quantityNeeded=50 — nenhum bloqueio, só identificável via consulta
  });

  it("X: multi-tenancy — correction/reversal de uma organização nunca pode aplicar-se a fulfillment de outra", async () => {
    const { original: originalA } = await setupOriginal();
    const { org: orgB, allocation: allocationB } = await setupOriginal();

    await expect(
      db.insertInto("needFulfillments").values({ organizationId: orgB.id, needId: null, allocationId: allocationB.id, stockTransactionId: null, quantity: "10", unit: "kg", entryType: "correction", reversesFulfillmentId: originalA.id }).execute()
    ).rejects.toThrow(/mesma allocation_id/);
  });
});
