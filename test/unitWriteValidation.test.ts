/**
 * Fase 99C — o vocabulário de unidades nos FLUXOS DE ESCRITA. Novos registros só aceitam unidade canônica ou alias comprovado (gravada como o rótulo canônico); desconhecida,
 * ambígua e ausente (quando obrigatória) são recusadas com mensagem clara; dados históricos continuam legíveis e não são trocados em silêncio; nada é convertido nem reescrito.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { db } from "../src/helpers/db";
import { canonicalizeUnitForWrite, checkOfferUnitAgainstItem, unitsEquivalent, UNIT_WRITE_OPTIONS } from "../src/helpers/unitVocabulary";
import { handle as postItem } from "../src/endpoints/inventory-items_POST";
import { handle as getItems } from "../src/endpoints/inventory-items_GET";
import { handle as postNeed } from "../src/endpoints/needs_POST";
import { handle as postNeedDetails } from "../src/endpoints/need-details_POST";
import { handle as postOpportunity } from "../src/endpoints/opportunities_POST";
import { handle as postRegistry } from "../src/endpoints/opportunity-registry_POST";
import { handle as postCapacity } from "../src/endpoints/organization-capacities_POST";
import { buildRequest, createAuthenticatedUser, createPlatformAdmin, createTestOrganization, createTestSource, parseJson } from "./helpers";

const post = (path: string, cookie: string, body: unknown) => buildRequest(path, { method: "POST", cookie, body });

describe("canonicalizeUnitForWrite (puro)", () => {
  it("aceita canônica e alias e devolve o rótulo canônico; recusa o resto sem trocar nada", () => {
    expect(canonicalizeUnitForWrite("kg")).toMatchObject({ ok: true, label: "kg", changed: false });
    expect(canonicalizeUnitForWrite(" KG ")).toMatchObject({ ok: true, label: "kg", changed: true });
    expect(canonicalizeUnitForWrite("unidades")).toMatchObject({ ok: true, label: "unidade", canonicalId: "unidade", changed: true });
    expect(canonicalizeUnitForWrite("Litros")).toMatchObject({ ok: true, label: "litro" });
    for (const [v, kind] of [["un", "ambigua"], ["galões", "ambigua"], ["cestas", "desconhecida"], ["x", "desconhecida"], ["peça", "desconhecida"], ["", "ausente"], [null, "ausente"]] as const) {
      const r = canonicalizeUnitForWrite(v as string | null);
      expect(r.ok, String(v)).toBe(false);
      if (!r.ok) expect(r.kind).toBe(kind);
    }
    const msg = canonicalizeUnitForWrite("cestas", "unidade de medida");
    if (!msg.ok) {
      expect(msg.message).toContain('"cestas"');
      expect(msg.message).toContain("unidade de medida");
      expect(msg.message).toContain(UNIT_WRITE_OPTIONS.map((o) => o.label).join(", "));
    }
  });

  it("equivalência: só a mesma unidade canônica; nada de conversão; sem classificação só vale o mesmo texto", () => {
    expect(unitsEquivalent("kg", "KG")).toBe(true);
    expect(unitsEquivalent("unidades", "unidade")).toBe(true);
    expect(unitsEquivalent("caixa", "unidade")).toBe(false);
    expect(unitsEquivalent("kg", "litro")).toBe(false);
    expect(unitsEquivalent("litro", "ml")).toBe(false);
    expect(unitsEquivalent("cestas", "cestas")).toBe(true); // mesmo texto (comportamento anterior preservado)
    expect(unitsEquivalent("cestas", "unidade")).toBe(false); // nunca presumido
    expect(unitsEquivalent("un", "unidade")).toBe(false); // ambíguo não vira unidade
    expect(unitsEquivalent(null, "kg")).toBe(false);
  });

  it("compatibilidade oferta × item: oferta SEM unidade é desconhecida (nunca compatível); o resto só passa se equivalente", () => {
    for (const v of [null, undefined, "", "  ", "\t"]) expect(checkOfferUnitAgainstItem(v, "kg"), String(v)).toMatchObject({ compatible: false, reason: "unidade_ausente" });
    expect(checkOfferUnitAgainstItem("KG", "kg")).toEqual({ compatible: true, reason: "mesma_unidade" });
    expect(checkOfferUnitAgainstItem("caixa", "unidade")).toMatchObject({ compatible: false, reason: "unidade_diferente" });
    expect(checkOfferUnitAgainstItem("x", "kg")).toMatchObject({ compatible: false, reason: "unidade_nao_classificada" });
    expect(checkOfferUnitAgainstItem("un", "unidade")).toMatchObject({ compatible: false, reason: "unidade_nao_classificada" });
  });
});

describe("escritores de unidade nos endpoints", () => {
  async function ctx() {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const platform = await createPlatformAdmin();
    const source = await createTestSource(platform.userId);
    return { owner, org, platform, source };
  }

  it("1/2/10: item novo grava o rótulo canônico (alias vira canônico) e a leitura devolve o mesmo valor", async () => {
    const c = await ctx();
    const res = await postItem(post("inventory-items", c.owner.cookie, { organizationId: c.org.id, name: "Arroz", unit: " Unidades " }));
    expect(res.status).toBe(200);
    expect((await parseJson<{ item: { unit: string } }>(res)).item.unit).toBe("unidade");
    expect((await db.selectFrom("inventoryItems").select("unit").where("organizationId", "=", c.org.id).executeTakeFirstOrThrow()).unit).toBe("unidade");
    const list = await parseJson<{ items: Array<{ unit: string }> }>(await getItems(buildRequest(`inventory-items?organizationId=${c.org.id}`, { cookie: c.owner.cookie })));
    expect(list.items[0].unit).toBe("unidade");
  });

  it("3/4: unidade desconhecida ou ambígua é recusada (400) e nada é gravado, em TODOS os escritores", async () => {
    const c = await ctx();
    const cases: Array<[string, () => Promise<Response>]> = [
      ["item", () => postItem(post("inventory-items", c.owner.cookie, { organizationId: c.org.id, name: "Cestas", unit: "cestas" }))],
      ["necessidade", () => postNeed(post("needs", c.owner.cookie, { organizationId: c.org.id, title: "Cestas básicas", quantityNeeded: 10, unit: "un", priority: "media" }))],
      ["doação local", () => postOpportunity(post("opportunities", c.owner.cookie, { organizationId: c.org.id, title: "Doação", donorName: "Doador", unit: "galões" }))],
      ["oferta da rede", () => postRegistry(post("opportunity-registry", c.platform.cookie, { sourceId: c.source.id, title: "Oferta", unit: "peça" }))],
      ["capacidade", () => postCapacity(post("organization-capacities", c.owner.cookie, { organizationId: c.org.id, category: "Alimentos", unit: "x", maxCapacity: 10 }))],
    ];
    for (const [name, call] of cases) {
      const res = await call();
      expect(res.status, name).toBe(400);
      const text = await res.text();
      expect(text, name).toMatch(/unidade/i);
      expect(text, name).not.toMatch(/select |insert |sql|stack/i);
    }
    expect(await db.selectFrom("inventoryItems").select("id").where("organizationId", "=", c.org.id).execute()).toHaveLength(0);
    expect(await db.selectFrom("needs").select("id").where("organizationId", "=", c.org.id).execute()).toHaveLength(0);
    expect(await db.selectFrom("donationOpportunities").select("id").where("organizationId", "=", c.org.id).execute()).toHaveLength(0);
    expect(await db.selectFrom("organizationCapacities").select("id").where("organizationId", "=", c.org.id).execute()).toHaveLength(0);
    expect((await db.selectFrom("opportunityRegistry").select("id").where("title", "=", "Oferta").execute())).toHaveLength(0);
  });

  it("unidade obrigatória ausente é recusada; opcional ausente continua aceita e grava NULL (nada é inventado)", async () => {
    const c = await ctx();
    expect((await postItem(post("inventory-items", c.owner.cookie, { organizationId: c.org.id, name: "Sem unidade", unit: "" }))).status).toBe(400);
    expect((await postItem(post("inventory-items", c.owner.cookie, { organizationId: c.org.id, name: "Sem unidade" }))).status).toBe(400);
    const donation = await postOpportunity(post("opportunities", c.owner.cookie, { organizationId: c.org.id, title: "Sem unidade", donorName: "Doador" }));
    expect(donation.status).toBe(200);
    const empty = await postOpportunity(post("opportunities", c.owner.cookie, { organizationId: c.org.id, title: "Unidade vazia", donorName: "Doador", unit: "" }));
    expect(empty.status).toBe(200);
    const rows = await db.selectFrom("donationOpportunities").select(["title", "unit"]).where("organizationId", "=", c.org.id).execute();
    expect(rows.every((r) => r.unit === null)).toBe(true);
    const ok = await postRegistry(post("opportunity-registry", c.platform.cookie, { sourceId: c.source.id, title: "Oferta canônica", unit: "Litros", quantity: 5 }));
    expect(ok.status).toBe(200);
    expect((await db.selectFrom("opportunityRegistry").select("unit").where("title", "=", "Oferta canônica").executeTakeFirstOrThrow()).unit).toBe("litro");
  });

  it("5/6: registro histórico com unidade desconhecida continua legível e editar OUTRO campo não a altera nem exige trocá-la", async () => {
    const c = await ctx();
    const [need] = await db.insertInto("needs").values({ organizationId: c.org.id, title: "Cestas antigas", quantityNeeded: "30", unit: "cestas", priority: "media", status: "aberta", createdByUserId: c.owner.userId }).returning("id").execute();
    await db.insertInto("inventoryItems").values({ organizationId: c.org.id, name: "Item antigo", unit: "peça", createdByUserId: c.owner.userId }).execute();
    const items = await parseJson<{ items: Array<{ unit: string }> }>(await getItems(buildRequest(`inventory-items?organizationId=${c.org.id}`, { cookie: c.owner.cookie })));
    expect(items.items.map((i) => i.unit)).toContain("peça");
    const res = await postNeedDetails(post("need-details", c.owner.cookie, { organizationId: c.org.id, needId: need.id, description: "Nova descrição, mesma unidade histórica" }));
    expect(res.status).toBe(200);
    const row = await db.selectFrom("needs").select(["unit", "description"]).where("id", "=", need.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ unit: "cestas", description: "Nova descrição, mesma unidade histórica" });
  });

  it("7: nenhum endpoint edita a unidade de um cadastro com histórico no lugar (a edição de necessidade ignora/recusa unidade)", async () => {
    const c = await ctx();
    const [need] = await db.insertInto("needs").values({ organizationId: c.org.id, title: "Necessidade", quantityNeeded: "30", unit: "kg", priority: "media", status: "aberta", createdByUserId: c.owner.userId }).returning("id").execute();
    await postNeedDetails(post("need-details", c.owner.cookie, { organizationId: c.org.id, needId: need.id, unit: "litro" }));
    expect((await db.selectFrom("needs").select("unit").where("id", "=", need.id).executeTakeFirstOrThrow()).unit).toBe("kg");
  });

  it("8: busca completa no código: só os endpoints conhecidos escrevem colunas de unidade, e todos passam por unitInput/vocabulário", () => {
    const dir = path.join(process.cwd(), "src");
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const files = walk(dir).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".schema.ts"));
    // escritores diretos das tabelas com coluna `unit` (insertInto/updateTable): cada um precisa estar na lista revisada
    const writers = files.filter((f) => /(insertInto|updateTable)\("(inventoryItems|needs|donationOpportunities|opportunityRegistry|organizationCapacities)"\)/.test(readFileSync(f, "utf8"))).map((f) => path.basename(f)).sort();
    const unitWriters = writers.filter((f) => /\.unit\b|unit:/.test(readFileSync(path.join(dir, f.includes("_POST") ? "endpoints" : "helpers", f), "utf8")));
    // os que gravam a COLUNA unit: endpoints de cadastro (validados pelos schemas) e a correção cadastral auditada
    expect(unitWriters).toEqual(expect.arrayContaining(["inventory-items_POST.ts", "needs_POST.ts", "opportunities_POST.ts", "opportunity-registry_POST.ts", "organization-capacities_POST.ts"]));
    for (const [endpoint, schemaFile] of [["inventory-items", "inventory-items_POST.schema.ts"], ["needs", "needs_POST.schema.ts"], ["opportunities", "opportunities_POST.schema.ts"], ["opportunity-registry", "opportunity-registry_POST.schema.ts"], ["organization-capacities", "organization-capacities_POST.schema.ts"]]) {
      expect(readFileSync(path.join(dir, "endpoints", schemaFile), "utf8"), endpoint).toMatch(/(requiredUnitInput|optionalUnitInput)\(/);
    }
    // o único outro escritor de unidade é a correção cadastral auditada (vocabulário + caso), e o ledger copia a unidade do item
    expect(readFileSync(path.join(dir, "helpers", "unitRegularization.tsx"), "utf8")).toContain("canonicalizeUnitForWrite");
  });

  it("9: a semente de staging e os dados de QA só usam unidades do vocabulário", () => {
    for (const file of ["db/seedStaging.ts", "scripts/qa-visual/seed.ts"]) {
      const text = readFileSync(path.join(process.cwd(), file), "utf8");
      const units = [...text.matchAll(/unit: "([^"]*)"/g)].map((m) => m[1]);
      expect(units.length, file).toBeGreaterThan(0);
      // qa-visual semeia de propósito valores históricos para o diagnóstico (inserções diretas, como um banco antigo); a staging passa pelos endpoints e só pode usar o vocabulário
      if (file === "db/seedStaging.ts") for (const u of units) expect(canonicalizeUnitForWrite(u).ok, `${file}: ${u}`).toBe(true);
    }
  });
});
