/**
 * Fase 94 (continuação) — validação de quantidade DE PONTA A PONTA nos 4 caminhos que antes só tinham prova no nível do schema:
 * recebimento da oportunidade (`opportunities-receive`), atribuição (`opportunity-allocations`), oportunidade da organização
 * (`opportunities`) e registro central (`opportunity-registry`). As colunas são NUMERIC(12,3). Para cada valor inválido: HTTP 400
 * (nunca 500 por violação de constraint), NADA gravado/alterado (estoque, ledger, status da oportunidade/atribuição, auditoria).
 * Para cada válido: sucesso e o valor exato persistido, respeitando as permissões. Postgres real e DESCARTÁVEL (levora_f94_test).
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { handle as postReceive } from "../src/endpoints/opportunities-receive_POST";
import { handle as postAllocation } from "../src/endpoints/opportunity-allocations_POST";
import { handle as postOpportunity } from "../src/endpoints/opportunities_POST";
import { handle as postRegistry } from "../src/endpoints/opportunity-registry_POST";
import {
  addMembership, buildRequest, createAuthenticatedUser, createPlatformAdmin, createTestInventoryItem, createTestOpportunityRegistry, createTestOrganization, createTestSource,
} from "./helpers";

const MAX = 999999999.999;
const VALID: Array<number | string> = [0.001, 1, 12.345, 100, MAX, "12.345"];
/** inválidos NUMÉRICOS: zero, negativos, mais de 3 casas, arredondam para 0,000, acima do máximo */
const INVALID_NUMBERS: number[] = [0, -1, -0.001, 0.0004, 0.0006, 1.2345, 0.0015, 1000000000, 1e12, 1e21];
/** inválidos de TIPO (coerção do schema: "abc"→NaN; null/""→0) */
const INVALID_TYPES: unknown[] = ["abc", null, "", {}, [], true];

const post = (path: string, cookie: string, body: unknown) => buildRequest(path, { method: "POST", cookie, body });
const count = async (table: "stockTransactions" | "auditLog" | "needFulfillments" | "opportunityAllocations" | "donationOpportunities" | "opportunityRegistry") =>
  Number((await db.selectFrom(table).select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);
const snapshot = async () => ({
  stock: await count("stockTransactions"), audit: await count("auditLog"), ledger: await count("needFulfillments"),
  allocations: await count("opportunityAllocations"), opportunities: await count("donationOpportunities"), registry: await count("opportunityRegistry"),
});

async function base() {
  const admin = await createPlatformAdmin();
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const voluntario = await createAuthenticatedUser();
  await addMembership(org.id, voluntario.userId, "voluntario");
  const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
  const source = await createTestSource(admin.userId);
  return { admin, owner, voluntario, orgId: org.id, itemId: item.id, sourceId: source.id };
}
type Base = Awaited<ReturnType<typeof base>>;

async function newDonationOpportunity(b: Base) {
  const [o] = await db.insertInto("donationOpportunities").values({ organizationId: b.orgId, title: "Oferta de teste", donorName: "Doador", unit: "kg", createdByUserId: b.owner.userId }).returning(["id", "status"]).execute();
  return o.id;
}
async function newRegistryOpportunity(b: Base, quantity: string | null = "999999999.999") {
  const opp = await createTestOpportunityRegistry(b.sourceId, b.admin.userId, { unit: "kg", status: "validada" });
  await db.updateTable("opportunityRegistry").set({ quantity }).where("id", "=", opp.id).execute();
  return opp.id;
}

describe("opportunities-receive (recebimento da oportunidade): quantityReceived — OBRIGATÓRIA", () => {
  const call = (b: Base, opportunityId: number, quantityReceived: unknown, cookie = b.owner.cookie) =>
    postReceive(post("opportunities-receive", cookie, { organizationId: b.orgId, opportunityId, itemId: b.itemId, ...(quantityReceived === undefined ? {} : { quantityReceived }) }));

  for (const value of [...INVALID_NUMBERS, ...INVALID_TYPES, undefined]) {
    it(`inválido ${JSON.stringify(value) ?? "ausente"} ⇒ 400, nada gravado, oportunidade intacta`, async () => {
      const b = await base();
      const opportunityId = await newDonationOpportunity(b);
      const before = await snapshot();
      const res = await call(b, opportunityId, value);
      expect(res.status).toBe(400);
      expect(await snapshot()).toEqual(before);
      expect((await db.selectFrom("donationOpportunities").select("status").where("id", "=", opportunityId).executeTakeFirstOrThrow()).status).not.toBe("recebida");
    });
  }

  for (const value of VALID) {
    it(`válido ${value} ⇒ 200; entrada física com o valor exato; oportunidade recebida; 1 auditoria`, async () => {
      const b = await base();
      const opportunityId = await newDonationOpportunity(b);
      const before = await snapshot();
      const res = await call(b, opportunityId, value);
      expect(res.status).toBe(200);
      const [tx] = await db.selectFrom("stockTransactions").select(["delta", "type"]).where("itemId", "=", b.itemId).execute();
      expect(tx.type).toBe("entrada");
      expect(Number(tx.delta)).toBe(Number(value));
      expect((await db.selectFrom("donationOpportunities").select("status").where("id", "=", opportunityId).executeTakeFirstOrThrow()).status).toBe("recebida");
      const after = await snapshot();
      expect(after.stock).toBe(before.stock + 1);
      expect(after.audit).toBe(before.audit + 1);
    });
  }

  it("permissão: sem `oportunidades.gerencie` ⇒ 403 mesmo com quantidade válida; nada gravado", async () => {
    const b = await base();
    const opportunityId = await newDonationOpportunity(b);
    const before = await snapshot();
    expect((await call(b, opportunityId, 10, b.voluntario.cookie)).status).toBe(403);
    expect(await snapshot()).toEqual(before);
  });
});

describe("opportunity-allocations (atribuição): quantityAllocated — OBRIGATÓRIA; somente administrador da plataforma", () => {
  const call = (b: Base, opportunityId: number, quantityAllocated: unknown, cookie = b.admin.cookie) =>
    postAllocation(post("opportunity-allocations", cookie, { opportunityId, organizationId: b.orgId, ...(quantityAllocated === undefined ? {} : { quantityAllocated }) }));

  for (const value of [...INVALID_NUMBERS, ...INVALID_TYPES, undefined]) {
    it(`inválido ${JSON.stringify(value) ?? "ausente"} ⇒ 400, nada gravado, descoberta intacta`, async () => {
      const b = await base();
      const opportunityId = await newRegistryOpportunity(b);
      const before = await snapshot();
      const res = await call(b, opportunityId, value);
      expect(res.status).toBe(400);
      expect(await snapshot()).toEqual(before);
      expect((await db.selectFrom("opportunityRegistry").select("status").where("id", "=", opportunityId).executeTakeFirstOrThrow()).status).toBe("validada");
    });
  }

  for (const value of VALID) {
    it(`válido ${value} ⇒ 200; atribuição com o valor exato; descoberta reservada`, async () => {
      const b = await base();
      const opportunityId = await newRegistryOpportunity(b);
      const res = await call(b, opportunityId, value);
      expect(res.status).toBe(200);
      const [al] = await db.selectFrom("opportunityAllocations").select(["quantityAllocated"]).where("opportunityRegistryId", "=", opportunityId).execute();
      expect(Number(al.quantityAllocated)).toBe(Number(value));
      expect((await db.selectFrom("opportunityRegistry").select("status").where("id", "=", opportunityId).executeTakeFirstOrThrow()).status).toBe("reservada");
    });
  }

  it("regra de negócio preservada: atribuir acima do total da descoberta continua recusado (409), sem gravar nada", async () => {
    const b = await base();
    const opportunityId = await newRegistryOpportunity(b, "10");
    const before = await snapshot();
    const res = await call(b, opportunityId, 10.001);
    expect([400, 409, 422]).toContain(res.status);
    expect(await snapshot()).toEqual(before);
  });

  it("somas em decimais exatos: 0,1 + 0,2 cabem numa descoberta de 0,3 (sem erro de ponto flutuante)", async () => {
    const b = await base();
    const opportunityId = await newRegistryOpportunity(b, "0.3");
    expect((await call(b, opportunityId, 0.1)).status).toBe(200);
    expect((await call(b, opportunityId, 0.2)).status, "0,1 + 0,2 = 0,3 exatamente").toBe(200);
    expect((await call(b, opportunityId, 0.001)).status, "agora esgotou").toBeGreaterThanOrEqual(400);
    const total = await db.selectFrom("opportunityAllocations").select((eb) => eb.fn.sum("quantityAllocated").as("t")).where("opportunityRegistryId", "=", opportunityId).executeTakeFirstOrThrow();
    expect(Number(total.t)).toBe(0.3);
  });

  it("permissão: quem não é administrador da plataforma ⇒ 403 mesmo com quantidade válida; nada gravado", async () => {
    const b = await base();
    const opportunityId = await newRegistryOpportunity(b);
    const before = await snapshot();
    expect((await call(b, opportunityId, 10, b.owner.cookie)).status).toBe(403);
    expect(await snapshot()).toEqual(before);
  });
});

describe("opportunities (oportunidade da organização): quantityOffered — OPCIONAL", () => {
  const call = (b: Base, quantityOffered: unknown, cookie = b.owner.cookie) =>
    postOpportunity(post("opportunities", cookie, { organizationId: b.orgId, title: "Cestas básicas", donorName: "Doador", ...(quantityOffered === undefined ? {} : { quantityOffered }) }));

  for (const value of [...INVALID_NUMBERS, ...INVALID_TYPES]) {
    it(`inválido ${JSON.stringify(value)} ⇒ 400 e nada gravado`, async () => {
      const b = await base();
      const before = await snapshot();
      expect((await call(b, value)).status).toBe(400);
      expect(await snapshot()).toEqual(before);
    });
  }

  it("ausente é permitido (opcional): cria a oportunidade sem quantidade", async () => {
    const b = await base();
    expect((await call(b, undefined)).status).toBe(200);
    const [o] = await db.selectFrom("donationOpportunities").select("quantityOffered").where("organizationId", "=", b.orgId).execute();
    expect(o.quantityOffered).toBeNull();
  });

  for (const value of VALID) {
    it(`válido ${value} ⇒ 200 com o valor exato`, async () => {
      const b = await base();
      expect((await call(b, value)).status).toBe(200);
      const [o] = await db.selectFrom("donationOpportunities").select("quantityOffered").where("organizationId", "=", b.orgId).execute();
      expect(Number(o.quantityOffered)).toBe(Number(value));
    });
  }

  it("permissão: sem `oportunidades.gerencie` ⇒ 403; nada gravado", async () => {
    const b = await base();
    const before = await snapshot();
    expect((await call(b, 10, b.voluntario.cookie)).status).toBe(403);
    expect(await snapshot()).toEqual(before);
  });
});

describe("opportunity-registry (registro central): quantity — OPCIONAL; somente administrador da plataforma", () => {
  const call = (b: Base, quantity: unknown, cookie = b.admin.cookie) =>
    postRegistry(post("opportunity-registry", cookie, { sourceId: b.sourceId, title: "Descoberta de teste", ...(quantity === undefined ? {} : { quantity }) }));

  for (const value of [...INVALID_NUMBERS, ...INVALID_TYPES]) {
    it(`inválido ${JSON.stringify(value)} ⇒ 400 e nada gravado`, async () => {
      const b = await base();
      const before = await snapshot();
      expect((await call(b, value)).status).toBe(400);
      expect(await snapshot()).toEqual(before);
    });
  }

  it("ausente é permitido (opcional)", async () => {
    const b = await base();
    expect((await call(b, undefined)).status).toBe(200);
    const [o] = await db.selectFrom("opportunityRegistry").select("quantity").execute();
    expect(o.quantity).toBeNull();
  });

  for (const value of VALID) {
    it(`válido ${value} ⇒ 200 com o valor exato`, async () => {
      const b = await base();
      expect((await call(b, value)).status).toBe(200);
      const [o] = await db.selectFrom("opportunityRegistry").select("quantity").execute();
      expect(Number(o.quantity)).toBe(Number(value));
    });
  }

  it("permissão: quem não é administrador da plataforma ⇒ 403; nada gravado", async () => {
    const b = await base();
    const before = await snapshot();
    expect((await call(b, 10, b.owner.cookie)).status).toBe(403);
    expect(await snapshot()).toEqual(before);
  });
});

import { handle as postItem } from "../src/endpoints/inventory-items_POST";
import { handle as postCapacity } from "../src/endpoints/organization-capacities_POST";

const itemCount = async (orgId: number) => Number((await db.selectFrom("inventoryItems").select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", orgId).executeTakeFirstOrThrow()).n);

describe("inventory-items (cadastro do item): initialQuantity — OPCIONAL, ≥ 0; permissão `inventario.lance`", () => {
  const call = (b: Base, initialQuantity: unknown, cookie = b.owner.cookie) =>
    postItem(post("inventory-items", cookie, { organizationId: b.orgId, name: `Item ${Math.random()}`, unit: "kg", ...(initialQuantity === undefined ? {} : { initialQuantity }) }));
  const NEGATIVE_OR_BAD = INVALID_NUMBERS.filter((v) => v !== 0); // zero É permitido aqui (item sem saldo inicial)

  for (const value of [...NEGATIVE_OR_BAD, ...INVALID_TYPES]) {
    it(`inválido ${JSON.stringify(value)} ⇒ 400; o item NÃO é criado (nem parcialmente), sem estoque e sem auditoria`, async () => {
      const b = await base();
      const items = await itemCount(b.orgId);
      const before = await snapshot();
      expect((await call(b, value)).status).toBe(400);
      expect(await itemCount(b.orgId)).toBe(items);
      expect(await snapshot()).toEqual(before);
    });
  }

  it("0 e ausente: cria o item SEM entrada de estoque", async () => {
    const b = await base();
    for (const v of [0, undefined]) {
      const before = await snapshot();
      expect((await call(b, v)).status).toBe(200);
      const after = await snapshot();
      expect(after.stock).toBe(before.stock);
    }
  });

  for (const value of [0.001, 12.345, MAX, "7.5"]) {
    it(`válido ${value} ⇒ 200; item criado com UMA entrada de estoque do valor exato`, async () => {
      const b = await base();
      const before = await snapshot();
      expect((await call(b, value)).status).toBe(200);
      const after = await snapshot();
      expect(after.stock).toBe(before.stock + 1);
      const tx = await db.selectFrom("stockTransactions").select("delta").orderBy("id", "desc").executeTakeFirstOrThrow();
      expect(Number(tx.delta)).toBe(Number(value));
    });
  }

  it("permissão: sem `inventario.lance` ⇒ 403; nada criado", async () => {
    const b = await base();
    const before = await snapshot();
    const items = await itemCount(b.orgId);
    expect((await call(b, 5, b.voluntario.cookie)).status).toBe(403);
    expect(await itemCount(b.orgId)).toBe(items);
    expect(await snapshot()).toEqual(before);
  });
});

describe("organization-capacities: maxCapacity — OBRIGATÓRIA, ≥ 0; permissão `organizacao.gerencie`", () => {
  const call = (b: Base, maxCapacity: unknown, cookie = b.owner.cookie) =>
    postCapacity(post("organization-capacities", cookie, { organizationId: b.orgId, category: "alimentos", unit: "kg", ...(maxCapacity === undefined ? {} : { maxCapacity }) }));
  const capacities = async (orgId: number) => Number((await db.selectFrom("organizationCapacities").select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", orgId).executeTakeFirstOrThrow()).n);

  for (const value of [...INVALID_NUMBERS.filter((v) => v !== 0), ...INVALID_TYPES, undefined]) {
    it(`inválido ${JSON.stringify(value) ?? "ausente"} ⇒ 400 e nada gravado`, async () => {
      const b = await base();
      const before = await snapshot();
      expect((await call(b, value)).status).toBe(400);
      expect(await capacities(b.orgId)).toBe(0);
      expect(await snapshot()).toEqual(before);
    });
  }

  for (const value of [0, 0.001, 12.345, MAX]) {
    it(`válido ${value} ⇒ 200 com o valor exato`, async () => {
      const b = await base();
      expect((await call(b, value)).status).toBe(200);
      const [c] = await db.selectFrom("organizationCapacities").select("maxCapacity").where("organizationId", "=", b.orgId).execute();
      expect(Number(c.maxCapacity)).toBe(value);
    });
  }

  it("permissão: sem `organizacao.gerencie` ⇒ 403; nada gravado", async () => {
    const b = await base();
    expect((await call(b, 10, b.voluntario.cookie)).status).toBe(403);
    expect(await capacities(b.orgId)).toBe(0);
  });
});
