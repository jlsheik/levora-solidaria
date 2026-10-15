/**
 * Fase 99B — inventário de unidades (backend real): agregação, filtros, autorização, isolamento por
 * organização e ausência de escrita. Banco `_test` (ver test/setup.ts); nada aqui toca produção.
 */
import { describe, it, expect } from "vitest";
import { sql } from "kysely";
import { readFileSync } from "node:fs";
import { db } from "../src/helpers/db";
import { handle } from "../src/endpoints/unit-inventory_GET";
import { handle as receiveHandle } from "../src/endpoints/allocations-receive_POST";
import { UNIT_SOURCES } from "../src/helpers/unitInventory";
import type { OutputType } from "../src/endpoints/unit-inventory_GET.schema";
import {
  addMembership,
  buildRequest,
  createAuthenticatedUser,
  createPlatformAdmin,
  createTestAllocation,
  createTestInventoryItem,
  createTestOpportunityRegistry,
  createTestOrganization,
  createTestSource,
  parseJson,
} from "./helpers";

type Auth = Awaited<ReturnType<typeof createAuthenticatedUser>>;

async function call(user: Auth | { cookie?: string }, organizationId: number, query: Record<string, string> = {}) {
  const qs = new URLSearchParams({ organizationId: String(organizationId), ...query });
  return handle(buildRequest(`unit-inventory?${qs.toString()}`, { cookie: user.cookie }));
}

async function inventory(user: Auth, organizationId: number, query: Record<string, string> = {}) {
  const res = await call(user, organizationId, query);
  expect(res.status).toBe(200);
  return parseJson<OutputType>(res);
}

/** Organização com um valor de unidade em CADA um dos 6 campos de unidade do schema. */
async function seedOrg(opts: { units: { item: string[]; need: string[]; capacity: string; donation: Array<string | null>; registry: string | null; ledgerItem: string } }) {
  const owner = await createAuthenticatedUser();
  const admin = await createPlatformAdmin();
  const org = await createTestOrganization(owner.userId);
  for (const [i, unit] of opts.units.item.entries()) await createTestInventoryItem(org.id, owner.userId, { name: `Item ${i}`, unit });
  for (const [i, unit] of opts.units.need.entries()) {
    await db.insertInto("needs").values({ organizationId: org.id, title: `Necessidade ${i}`, quantityNeeded: "10", unit, priority: "media", status: "aberta", createdByUserId: owner.userId }).execute();
  }
  await db.insertInto("organizationCapacities").values({ organizationId: org.id, category: "Alimentos", unit: opts.units.capacity, maxCapacity: "100", createdByUserId: owner.userId }).execute();
  for (const [i, unit] of opts.units.donation.entries()) {
    await db.insertInto("donationOpportunities").values({ organizationId: org.id, title: `Doação ${i}`, donorName: "Doador", unit, createdByUserId: owner.userId }).execute();
  }
  const source = await createTestSource(admin.userId);
  const registry = await createTestOpportunityRegistry(source.id, admin.userId, { title: "Oferta sigilosa do doador", unit: opts.units.ledgerItem });
  const allocation = await createTestAllocation(registry.id, org.id, { status: "em_transporte", quantityAllocated: 5 });
  const ledgerItem = await createTestInventoryItem(org.id, owner.userId, { name: "Item do ledger", unit: opts.units.ledgerItem });
  const receive = await receiveHandle(buildRequest("allocations-receive", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, allocationId: allocation.id, itemId: ledgerItem.id, quantityReceived: 5 } }));
  expect(receive.status).toBe(200);
  // Fase 99C: o recebimento acima exige oferta sem divergência; o valor de unidade da oferta a inventariar é gravado DEPOIS (dado histórico direto, como num banco antigo).
  await db.updateTable("opportunityRegistry").set({ unit: opts.units.registry }).where("id", "=", registry.id).execute();
  return { owner, org };
}

const DEFAULTS = {
  item: ["kg", "KG", " KG ", "x"],
  need: ["unidades", "un"],
  capacity: "caixa",
  donation: [null, "galões"],
  registry: "litros",
  ledgerItem: "peça",
};

async function snapshot(organizationId: number) {
  const q = async (table: string, extra = "") => {
    const r = await sql<{ n: string }>`SELECT COUNT(*) AS n FROM ${sql.table(table)} ${sql.raw(extra)}`.execute(db);
    return Number(r.rows[0].n);
  };
  const dump = async (table: string, where: string) => (await sql<{ d: string }>`SELECT COALESCE(json_agg(t ORDER BY t.id)::text, '[]') AS d FROM (SELECT * FROM ${sql.table(table)} ${sql.raw(where)}) t`.execute(db)).rows[0].d;
  return {
    counts: {
      stock: await q("stock_transactions"),
      ledger: await q("need_fulfillments"),
      audit: await q("audit_log"),
      allocations: await q("opportunity_allocations"),
    },
    dumps: {
      items: await dump("inventory_items", `WHERE organization_id = ${organizationId}`),
      needs: await dump("needs", `WHERE organization_id = ${organizationId}`),
      donations: await dump("donation_opportunities", `WHERE organization_id = ${organizationId}`),
      caps: await dump("organization_capacities", `WHERE organization_id = ${organizationId}`),
      registry: await dump("opportunity_registry", ""),
      ledger: await dump("need_fulfillments", `WHERE organization_id = ${organizationId}`),
    },
  };
}

describe("unit-inventory_GET — agregação", () => {
  it("13: cada campo de unidade do schema é uma origem do inventário (nada fica de fora)", async () => {
    // Todas as colunas `unit` de db/schema.sql (exceto `unit_mismatch_note`) precisam estar em UNIT_SOURCES.
    const schemaSql = readFileSync("db/schema.sql", "utf8");
    const found: string[] = [];
    let table = "";
    for (const line of schemaSql.split("\n")) {
      const t = line.match(/^CREATE TABLE (\w+)/);
      if (t) table = t[1];
      if (/^\s+unit\s+TEXT/.test(line)) found.push(`${table}.unit`);
    }
    expect(found.length).toBeGreaterThan(0);
    expect(UNIT_SOURCES.map((s) => `${s.table}.${s.column}`).sort()).toEqual([...found].sort());

    const { owner, org } = await seedOrg({ units: DEFAULTS });
    const result = await inventory(owner, org.id);
    expect(result.sources.map((s) => s.id).sort()).toEqual(UNIT_SOURCES.map((s) => s.id).sort());
    for (const source of result.sources) expect(source.distinctValues, source.id).toBeGreaterThan(0);
    expect(result.rows.map((r) => r.source)).toEqual(expect.arrayContaining(UNIT_SOURCES.map((s) => s.id)));
  });

  it("14: as contagens agrupadas batem com o banco (valor bruto distinto, sem normalizar)", async () => {
    const { owner, org } = await seedOrg({ units: DEFAULTS });
    const result = await inventory(owner, org.id);
    const count = (source: string, raw: string | null) => result.rows.find((r) => r.source === source && r.rawValue === raw)?.occurrences;

    expect(count("inventory_items", "kg")).toBe(1);
    expect(count("inventory_items", "KG")).toBe(1);
    expect(count("inventory_items", " KG ")).toBe(1);
    expect(count("inventory_items", "x")).toBe(1);
    expect(count("inventory_items", "peça")).toBe(1); // item do ledger
    expect(count("needs", "unidades")).toBe(1);
    expect(count("organization_capacities", "caixa")).toBe(1);
    expect(count("donation_opportunities", null)).toBe(1);
    expect(count("donation_opportunities", "galões")).toBe(1);
    expect(count("opportunity_registry", "litros")).toBe(1);
    expect(count("need_fulfillments", "peça")).toBe(1);

    const dbItems = await db.selectFrom("inventoryItems").select(["unit"]).where("organizationId", "=", org.id).execute();
    const inventoryRowsTotal = result.rows.filter((r) => r.source === "inventory_items").reduce((a, r) => a + r.occurrences, 0);
    expect(inventoryRowsTotal).toBe(dbItems.length);
    expect(result.summary.totalOccurrences).toBe(result.rows.reduce((a, r) => a + r.occurrences, 0));
    expect(result.summary.distinctValues).toBe(new Set(result.rows.map((r) => r.rawValue)).size);
    const sumKinds = Object.values(result.summary.byClassification).reduce((a, k) => a + k.distinctValues, 0);
    expect(sumKinds).toBeGreaterThanOrEqual(result.summary.distinctValues);
  });

  it("15: valores desconhecidos, ambíguos e ausentes continuam aparecendo com o valor bruto", async () => {
    const { owner, org } = await seedOrg({ units: DEFAULTS });
    const result = await inventory(owner, org.id);
    const find = (raw: string | null) => result.rows.filter((r) => r.rawValue === raw);
    expect(find("x")[0].classification).toBe("desconhecida");
    expect(find("peça")[0].classification).toBe("desconhecida");
    expect(find("un")[0].classification).toBe("ambigua");
    expect(find("galões")[0].classification).toBe("ambigua");
    expect(find(null)[0].classification).toBe("ausente");
    expect(find("KG")[0].classification).toBe("canonica");
    expect(find("unidades")[0].classification).toBe("alias");
    expect(find("KG")[0].canonicalLabel).toBe("kg");
    expect(find("x")[0].canonicalId).toBeNull();
    expect(result.summary.pendingReviewValues).toBe(result.summary.byClassification.ambigua.distinctValues + result.summary.byClassification.desconhecida.distinctValues);
    expect(result.summary.pendingReviewValues).toBeGreaterThan(0);
  });

  it("16: filtro por origem", async () => {
    const { owner, org } = await seedOrg({ units: DEFAULTS });
    const result = await inventory(owner, org.id, { source: "needs" });
    expect(result.rows.length).toBe(2);
    expect(new Set(result.rows.map((r) => r.source))).toEqual(new Set(["needs"]));
    // Os totais não dependem do filtro.
    const all = await inventory(owner, org.id);
    expect(result.summary).toEqual(all.summary);
  });

  it("17: filtro por classificação e por valor", async () => {
    const { owner, org } = await seedOrg({ units: DEFAULTS });
    const unknown = await inventory(owner, org.id, { classification: "desconhecida" });
    expect(unknown.rows.length).toBeGreaterThan(0);
    expect(new Set(unknown.rows.map((r) => r.classification))).toEqual(new Set(["desconhecida"]));
    const absent = await inventory(owner, org.id, { classification: "ausente" });
    expect(absent.rows.map((r) => r.rawValue)).toEqual([null]);
    const byValue = await inventory(owner, org.id, { value: "kg" });
    expect(byValue.rows.map((r) => r.rawValue?.trim().toLowerCase())).toEqual(["kg", "kg", "kg"]);
    const combined = await inventory(owner, org.id, { source: "inventory_items", classification: "canonica", value: "KG" });
    expect(combined.rows.length).toBe(3);
    const none = await inventory(owner, org.id, { value: "inexistente-xyz" });
    expect(none.rows).toEqual([]);
    expect(none.summary.distinctValues).toBeGreaterThan(0);
  });

  it("16b: parâmetros inválidos são recusados com 400, sem detalhes internos", async () => {
    const { owner, org } = await seedOrg({ units: DEFAULTS });
    for (const q of [{ source: "stock_transactions" }, { classification: "qualquer" }, { value: "a".repeat(101) }]) {
      const res = await call(owner, org.id, q);
      expect(res.status).toBe(400);
      expect(await res.text()).not.toMatch(/select |from |sql|stack/i);
    }
    const noOrg = await handle(buildRequest("unit-inventory", { cookie: owner.cookie }));
    expect(noOrg.status).toBe(400);
  });

  it("organização sem dados devolve listas vazias e totais zerados", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const result = await inventory(owner, org.id);
    expect(result.rows).toEqual([]);
    expect(result.summary.distinctValues).toBe(0);
    expect(result.summary.totalOccurrences).toBe(0);
    expect(result.summary.pendingReviewValues).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("24: o resultado é estável em execuções repetidas sem mudança nos dados", async () => {
    const { owner, org } = await seedOrg({ units: DEFAULTS });
    const a = await inventory(owner, org.id);
    const b = await inventory(owner, org.id);
    expect(b).toEqual(a);
  });
});

describe("unit-inventory_GET — autorização e isolamento", () => {
  it("19 e 21: uma organização não vê os valores de outra, nem pelo filtro", async () => {
    const a = await seedOrg({ units: DEFAULTS });
    const b = await seedOrg({ units: { item: ["SEGREDO-B"], need: ["SEGREDO-B-NEC"], capacity: "SEGREDO-B-CAP", donation: ["SEGREDO-B-DOA"], registry: "SEGREDO-B-REG", ledgerItem: "SEGREDO-B-LED" } });

    const asA = await inventory(a.owner, a.org.id);
    expect(JSON.stringify(asA)).not.toContain("SEGREDO-B");
    const asB = await inventory(b.owner, b.org.id);
    expect(JSON.stringify(asB)).toContain("SEGREDO-B-REG");
    expect(JSON.stringify(asB)).not.toContain("kg");

    const filtered = await inventory(a.owner, a.org.id, { value: "SEGREDO" });
    expect(filtered.rows).toEqual([]);

    // O dono de A não consulta B informando o id de B.
    const cross = await call(a.owner, b.org.id);
    expect(cross.status).toBe(403);
    expect(await cross.text()).not.toContain("SEGREDO-B");
  });

  it("20: sem permissão, o servidor recusa (anônimo 401; não-membro, operador, voluntário e inativo 403)", async () => {
    const { owner, org } = await seedOrg({ units: DEFAULTS });
    const anon = await call({}, org.id);
    expect(anon.status).toBe(401);

    const stranger = await createAuthenticatedUser();
    expect((await call(stranger, org.id)).status).toBe(403);

    const operator = await createAuthenticatedUser();
    await addMembership(org.id, operator.userId, "operador");
    expect((await call(operator, org.id)).status).toBe(403);

    const volunteer = await createAuthenticatedUser();
    await addMembership(org.id, volunteer.userId, "voluntario");
    expect((await call(volunteer, org.id)).status).toBe(403);

    const inactive = await createAuthenticatedUser();
    await addMembership(org.id, inactive.userId, "administrador", "inativo");
    expect((await call(inactive, org.id)).status).toBe(403);

    // Admin da plataforma sem vínculo com a organização não ganha acesso transversal.
    const platformAdmin = await createPlatformAdmin();
    expect((await call(platformAdmin, org.id)).status).toBe(403);

    expect((await call(owner, org.id)).status).toBe(200);
  });

  it("21: proprietário e administrador veem somente o escopo da própria organização", async () => {
    const { owner, org } = await seedOrg({ units: DEFAULTS });
    const admin = await createAuthenticatedUser();
    await addMembership(org.id, admin.userId, "administrador");
    const other = await seedOrg({ units: { ...DEFAULTS, item: ["OUTRA-ORG"] } });
    const viaOwner = await inventory(owner, org.id);
    const viaAdmin = await inventory(admin, org.id);
    expect(viaAdmin).toEqual(viaOwner);
    expect(JSON.stringify(viaAdmin)).not.toContain("OUTRA-ORG");
    expect(other.org.id).not.toBe(org.id);
  });

  it("organização em análise continua podendo ver o próprio diagnóstico (leitura)", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { status: "em_analise" });
    await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
    const result = await inventory(owner, org.id);
    expect(result.rows.length).toBe(1);
  });

  it("25: o payload não revela dados de registros individuais (sem IDs, títulos, nomes, contatos)", async () => {
    const { owner, org } = await seedOrg({ units: DEFAULTS });
    const result = await inventory(owner, org.id);
    const allowedRowKeys = ["candidates", "canonicalId", "canonicalLabel", "classification", "dimension", "explanation", "occurrences", "rawValue", "source", "sourceLabel"];
    for (const row of result.rows) expect(Object.keys(row).sort()).toEqual(allowedRowKeys);
    const text = JSON.stringify(result);
    for (const forbidden of ["Doador", "Necessidade 0", "Doação 0", "Item 0", "Oferta sigilosa", "Item do ledger", "organizationId", "createdBy", "userId"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });
});

describe("unit-inventory_GET — somente leitura", () => {
  it("22 e 23: não modifica estoque, necessidades, ofertas, ledger nem os valores históricos", async () => {
    const { owner, org } = await seedOrg({ units: DEFAULTS });
    const before = await snapshot(org.id);
    for (const q of [{}, { source: "needs" }, { classification: "desconhecida" }, { value: "kg" }]) {
      expect((await call(owner, org.id, q)).status).toBe(200);
    }
    const after = await snapshot(org.id);
    expect(after).toEqual(before);
    // Os valores brutos (incluindo grafias diferentes) continuam exatamente como foram gravados.
    const units = (await db.selectFrom("inventoryItems").select("unit").where("organizationId", "=", org.id).execute()).map((r) => r.unit);
    expect(units).toEqual(expect.arrayContaining(["kg", "KG", " KG ", "x"]));
  });

  it("22b: o endpoint não declara nenhuma escrita (só SELECT) e só aceita GET pelo nome do arquivo", () => {
    for (const file of ["src/endpoints/unit-inventory_GET.ts", "src/helpers/unitInventory.ts"]) {
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/\b(insertInto|updateTable|deleteFrom|INSERT\s+INTO|UPDATE\s|DELETE\s+FROM|TRUNCATE)\b/i);
    }
  });
});
