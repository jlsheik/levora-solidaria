/**
 * Fase 94 — precisão e limites das quantidades nas ENTRADAS do núcleo (estoque, recebimento, necessidade). As colunas são
 * NUMERIC(12,3): uma quantidade com mais de 3 casas ou acima de 999.999.999,999 não pode (a) estourar como 500, nem (b) ser
 * persistida arredondada enquanto a API/auditoria informam outro valor. Contrato: 400 de validação, nada persistido.
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { handle as postStock } from "../src/endpoints/stock-transactions_POST";
import { handle as postReceive } from "../src/endpoints/allocations-receive_POST";
import { schema as oppReceiveSchema } from "../src/endpoints/opportunities-receive_POST.schema";
import { schema as allocSchema } from "../src/endpoints/opportunity-allocations_POST.schema";
import { schema as oppSchema } from "../src/endpoints/opportunities_POST.schema";
import { schema as registrySchema } from "../src/endpoints/opportunity-registry_POST.schema";
import { handle as postNeed } from "../src/endpoints/needs_POST";
import { computeNeedProgress } from "../src/helpers/needFulfillment";
import { roundQuantity } from "../src/helpers/quantityRules";
import { createAuthenticatedUser, createTestOrganization, createTestSource, createTestOpportunityRegistry, createTestInventoryItem, buildRequest } from "./helpers";

async function env() {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
  const platform = await createAuthenticatedUser();
  const source = await createTestSource(platform.userId);
  return { owner, orgId: org.id, itemId: item.id, sourceId: source.id, platformId: platform.userId };
}
const post = (path: string, cookie: string, body: unknown) => buildRequest(path, { method: "POST", cookie, body });
const BAD = [0.0004, 0.0006, 1.2345, 1000000000, 1e12, 1e21];
const stockCount = async (orgId: number) => Number((await db.selectFrom("stockTransactions").select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", orgId).executeTakeFirstOrThrow()).n);

describe("quantidades fora da precisão/limite da coluna são recusadas com 400 e nada é persistido", () => {
  for (const type of ["entrada", "saida", "ajuste"] as const) {
    it(`lançamento manual (${type})`, async () => {
      const e = await env();
      await postStock(post("stock-transactions", e.owner.cookie, { organizationId: e.orgId, itemId: e.itemId, type: "entrada", quantity: 999, reason: "carga inicial" }));
      const before = await stockCount(e.orgId);
      for (const quantity of BAD) {
        const res = await postStock(post("stock-transactions", e.owner.cookie, { organizationId: e.orgId, itemId: e.itemId, type, quantity, reason: "teste de precisão" }));
        expect(res.status, `${type} ${quantity}`).toBe(400);
      }
      expect(await stockCount(e.orgId)).toBe(before);
    });
  }

  it("recebimento de atribuição", async () => {
    const e = await env();
    for (const quantityReceived of BAD) {
      const opp = await createTestOpportunityRegistry(e.sourceId, e.platformId, { status: "reservada" });
      const [al] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: opp.id, organizationId: e.orgId, quantityAllocated: "100", status: "aceita" }).returning(["id"]).execute();
      const res = await postReceive(post("allocations-receive", e.owner.cookie, { organizationId: e.orgId, allocationId: al.id, itemId: e.itemId, quantityReceived }));
      expect(res.status, `receive ${quantityReceived}`).toBe(400);
      expect((await db.selectFrom("opportunityAllocations").select("status").where("id", "=", al.id).executeTakeFirstOrThrow()).status).toBe("aceita");
    }
    expect(await stockCount(e.orgId)).toBe(0);
  });

  it("necessidade (quantidade necessária)", async () => {
    const e = await env();
    for (const quantityNeeded of BAD) {
      const res = await postNeed(post("needs", e.owner.cookie, { organizationId: e.orgId, title: "Cestas", quantityNeeded, unit: "kg", priority: "media", itemId: e.itemId }));
      expect(res.status, `need ${quantityNeeded}`).toBe(400);
    }
    expect(Number((await db.selectFrom("needs").select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", e.orgId).executeTakeFirstOrThrow()).n)).toBe(0);
  });

  it("valores válidos continuam aceitos (3 casas, e o máximo da coluna)", async () => {
    const e = await env();
    for (const quantity of [0.001, 1.5, 12.345, 999999999.999]) {
      const res = await postStock(post("stock-transactions", e.owner.cookie, { organizationId: e.orgId, itemId: e.itemId, type: "entrada", quantity, reason: "valor válido" }));
      expect(res.status, `entrada ${quantity}`).toBe(200);
    }
  });

  it("os demais pontos de entrada de quantidade usam a MESMA regra (schemas): recebimento da oportunidade, atribuição, oportunidade e registro", () => {
    const base = { organizationId: 1 };
    const cases: Array<[string, (q: number) => { success: boolean }]> = [
      ["opportunities-receive", (q) => oppReceiveSchema.safeParse({ ...base, opportunityId: 1, itemId: 1, quantityReceived: q })],
      ["opportunity-allocations", (q) => allocSchema.safeParse({ ...base, opportunityId: 1, quantityAllocated: q })],
      ["opportunities", (q) => oppSchema.safeParse({ ...base, title: "Oferta", donorName: "Doador", quantityOffered: q })],
      ["opportunity-registry", (q) => registrySchema.safeParse({ title: "Oferta", sourceId: 1, quantity: q })],
    ];
    for (const [name, parse] of cases) {
      for (const bad of BAD) expect(parse(bad).success, `${name} ${bad}`).toBe(false);
      expect(parse(12.345).success, `${name} válido`).toBe(true);
    }
  });
});

describe("tipos inválidos e aritmética exata de quantidades (Fase 94, continuação)", () => {
  it("true, null, lista, objeto, texto e notação científica/hexadecimal NÃO viram quantidade (antes: true virava 1)", async () => {
    const e = await env();
    for (const quantity of [true, false, null, [], {}, "abc", "", "1e3", "0x10", "  "]) {
      const res = await postStock(post("stock-transactions", e.owner.cookie, { organizationId: e.orgId, itemId: e.itemId, type: "entrada", quantity, reason: "tipo inválido" }));
      expect(res.status, JSON.stringify(quantity)).toBe(400);
      const need = await postNeed(post("needs", e.owner.cookie, { organizationId: e.orgId, title: "Cestas", quantityNeeded: quantity, unit: "kg", priority: "media" }));
      expect(need.status, JSON.stringify(quantity)).toBe(400);
    }
    expect(await stockCount(e.orgId)).toBe(0);
  });

  it("strings decimais continuam aceitas (formulários): \"12.345\" e \" 7 \"", async () => {
    const e = await env();
    for (const quantity of ["12.345", " 7 ", "0.001"]) {
      const res = await postStock(post("stock-transactions", e.owner.cookie, { organizationId: e.orgId, itemId: e.itemId, type: "entrada", quantity, reason: "string decimal" }));
      expect(res.status, String(quantity)).toBe(200);
    }
  });

  it("diferenças na escala da coluna: 0,3 − 0,1 = 0,2 e 0,1 + 0,2 = 0,3 (sem resíduo binário) no progresso da necessidade", () => {
    expect(roundQuantity(0.1 + 0.2)).toBe(0.3);
    expect(computeNeedProgress(0.3, 0.1)).toEqual({ fulfilled: 0.1, requiredRemaining: 0.2, surplus: 0 });
    expect(computeNeedProgress(0.3, 0.4)).toEqual({ fulfilled: 0.4, requiredRemaining: 0, surplus: 0.1 });
    expect(computeNeedProgress(500, 120)).toEqual({ fulfilled: 120, requiredRemaining: 380, surplus: 0 });
  });
});
