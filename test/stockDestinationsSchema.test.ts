/**
 * Fase 99D — contrato ESTRUTURAL de stock_destinations (PostgreSQL real, banco `_test`). Nenhum fluxo de aplicação grava aqui nesta fase: os testes inserem direto no banco para
 * provar o que o schema GARANTE (isolamento por organização, forma de cada espécie, finalidade, unidade canônica, quantidade, vínculo de correções/reversões, imutabilidade) e deixam
 * explícito o que fica para a transação da aplicação (99E em diante).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { UNIT_WRITE_OPTIONS } from "../src/helpers/unitVocabulary";
import { createAuthenticatedUser, createTestInventoryItem, createTestOrganization } from "./helpers";

async function world(unit = "kg") {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const item = await createTestInventoryItem(org.id, owner.userId, { name: "Arroz", unit });
  return { owner, org, item };
}
type W = Awaited<ReturnType<typeof world>>;

async function tx(w: W, type: "entrada" | "saida" | "ajuste", delta: number, itemId = w.item.id, orgId = w.org.id) {
  const [row] = await db.insertInto("stockTransactions").values({ organizationId: orgId, itemId, type, delta: String(delta), reason: "movimento de teste", createdByUserId: w.owner.userId }).returning("id").execute();
  return row.id;
}
const exit5 = (w: W) => tx(w, "saida", -5);

const original = (w: W, stockTransactionId: string | number, over: Record<string, unknown> = {}) => ({
  organizationId: w.org.id,
  entryType: "original" as const,
  itemId: w.item.id,
  stockTransactionId,
  destinationType: "distribuicao_familias",
  quantity: "5",
  unit: "kg",
  isCountable: false,
  deliveredOn: sql`current_date`,
  createdByUserId: w.owner.userId,
  ...over,
});
const insert = (values: Record<string, unknown>) => db.insertInto("stockDestinations").values(values as never).returning(["id"]).executeTakeFirstOrThrow();
const row = (id: string | number) => db.selectFrom("stockDestinations").selectAll().where("id", "=", String(id) as never).executeTakeFirstOrThrow();

describe("stock_destinations — destinação original", () => {
  it("1: aceita uma destinação válida ligada a uma saída da mesma organização, com autoria e data de registro do servidor", async () => {
    const w = await world();
    const d = await insert(original(w, await exit5(w), { peopleServed: 12, peopleUnit: "familias", notes: "entrega no bairro" }));
    const r = await row(d.id);
    expect(r.entryType).toBe("original");
    expect(Number(r.quantity)).toBe(5);
    expect(r.createdAt).toBeInstanceOf(Date); // registro do servidor (DEFAULT now()), distinto de delivered_on
    expect(r.createdByUserId).toBe(w.owner.userId);
    expect(r.peopleServed).toBe(12);
  });

  it("2: entrada e ajuste positivo NÃO são saída normal; ajuste negativo só como perda/descarte", async () => {
    const w = await world();
    await expect(insert(original(w, await tx(w, "entrada", 5)))).rejects.toThrow(/exige uma saída física/);
    await expect(insert(original(w, await tx(w, "ajuste", 5)))).rejects.toThrow(/exige uma saída física/);
    const negAdjust = await tx(w, "ajuste", -5);
    await expect(insert(original(w, negAdjust))).rejects.toThrow(/exige uma saída física/); // finalidade de atendimento: não
    const d = await insert(original(w, negAdjust, { destinationType: "perda", notes: "avaria por umidade no depósito" }));
    expect(d.id).toBeDefined();
  });

  it("3/4/14: referência a outra organização é rejeitada pelas chaves compostas (movimento, item, necessidade e comprovante)", async () => {
    const a = await world();
    const b = await world();
    const exitB = await exit5(b);
    await expect(insert(original(a, exitB))).rejects.toThrow(/stock_org_fkey|foreign key|não é do item/); // o gatilho ou a FK composta: nunca aceita
    await expect(insert(original(a, await exit5(a), { itemId: b.item.id }))).rejects.toThrow(/item_org_fkey|foreign key|não é do item/);
    const [needB] = await db.insertInto("needs").values({ organizationId: b.org.id, title: "Necessidade de B", quantityNeeded: "10", unit: "kg", priority: "media", status: "aberta", createdByUserId: b.owner.userId }).returning("id").execute();
    await expect(insert(original(a, await exit5(a), { needId: needB.id }))).rejects.toThrow(/need_org_fkey|foreign key/);
    const [fileB] = await db.insertInto("files").values({ organizationId: b.org.id, uploadedByUserId: b.owner.userId, storageProvider: "local", storageKey: "k-b", originalFilename: "c.png", contentType: "image/png", sizeBytes: "10", purpose: "comprovante_entrega" }).returning("id").execute();
    await expect(insert(original(a, await exit5(a), { proofFileId: fileB.id }))).rejects.toThrow(/proof_org_fkey|foreign key/);
    // o mesmo comprovante da PRÓPRIA organização é aceito
    const [fileA] = await db.insertInto("files").values({ organizationId: a.org.id, uploadedByUserId: a.owner.userId, storageProvider: "local", storageKey: "k-a", originalFilename: "c.png", contentType: "image/png", sizeBytes: "10", purpose: "comprovante_entrega" }).returning("id").execute();
    expect((await insert(original(a, await exit5(a), { proofFileId: fileA.id }))).id).toBeDefined();
  });

  it("5/6/7: finalidade inexistente, quantidade inválida, quantidade diferente da saída e unidade não canônica ou diferente da do item são rejeitadas", async () => {
    const w = await world();
    const bad = (over: Record<string, unknown>) => insert(original(w, undefined as never, over));
    await expect(insert(original(w, await exit5(w), { destinationType: "venda" }))).rejects.toThrow(/destination_type|type_chk|check/i);
    for (const q of ["0", "-5"]) await expect(insert(original(w, await exit5(w), { quantity: q })), q).rejects.toThrow();
    await expect(insert(original(w, await exit5(w), { quantity: "4" }))).rejects.toThrow(/igual à da saída/);
    await expect(insert(original(w, await exit5(w), { unit: "cestas" }))).rejects.toThrow(/unit_chk|unidade canônica/); // fora do vocabulário (gatilho ou CHECK: nunca aceita)
    await expect(insert(original(w, await exit5(w), { unit: "litro" }))).rejects.toThrow(/unidade canônica do item/); // canônica, mas não a do item
    void bad;
  });

  it("7b: item com unidade histórica fora do vocabulário NÃO recebe destinação normal (sem unidade confiável, sem destinação)", async () => {
    const w = await world("cestas");
    await expect(insert(original(w, await exit5(w), { unit: "cestas" }))).rejects.toThrow(/unit_chk|unidade canônica/);
  });

  it("8: segunda destinação normal para a mesma saída é rejeitada; depois de estorno TOTAL a mesma saída pode ser redestinada", async () => {
    const w = await world();
    const exit = await exit5(w);
    const first = await insert(original(w, exit));
    await expect(insert(original(w, exit, { destinationType: "perda", notes: "tentativa de segunda destinação" }))).rejects.toThrow(/já tem uma destinação ativa/);
    // estorno PARCIAL não libera
    await insert({ organizationId: w.org.id, entryType: "reversal", itemId: w.item.id, reversesDestinationId: first.id, reversalKind: "estorno_documental", quantity: "2", unit: "kg", reason: "registro errado (parcial)", createdByUserId: w.owner.userId });
    await expect(insert(original(w, exit))).rejects.toThrow(/já tem uma destinação ativa/);
    await insert({ organizationId: w.org.id, entryType: "reversal", itemId: w.item.id, reversesDestinationId: first.id, reversalKind: "estorno_documental", quantity: "3", unit: "kg", reason: "registro errado (restante)", createdByUserId: w.owner.userId });
    expect((await insert(original(w, exit, { destinationType: "atendimento_coletivo" }))).id).toBeDefined();
  });

  it("finalidade × atendimento: necessidade, contagem e pessoas atendidas só nas três finalidades de atendimento; pessoas sem unidade (e vice-versa) é inválido", async () => {
    const w = await world();
    const [need] = await db.insertInto("needs").values({ organizationId: w.org.id, title: "Cestas", quantityNeeded: "100", unit: "kg", priority: "media", status: "aberta", createdByUserId: w.owner.userId }).returning("id").execute();
    for (const t of ["uso_operacional_instituicao", "doacao_a_terceiro", "devolucao_ao_doador", "perda", "descarte"]) {
      await expect(insert(original(w, await exit5(w), { destinationType: t, needId: need.id, notes: "justificativa operacional" })), t).rejects.toThrow(/need_only_attendance/);
      await expect(insert(original(w, await exit5(w), { destinationType: t, isCountable: true, notes: "justificativa operacional" })), t).rejects.toThrow(/countable_chk/);
      await expect(insert(original(w, await exit5(w), { destinationType: t, peopleServed: 3, peopleUnit: "pessoas", notes: "justificativa operacional" })), t).rejects.toThrow(/people_only_attendance/);
      await expect(insert(original(w, await exit5(w), { destinationType: t, notes: "curta" })), t).rejects.toThrow(/reason_required/); // motivo ≥ 10 caracteres
    }
    for (const t of ["atendimento_coletivo", "distribuicao_familias", "entrega_instituicao_parceira"]) {
      expect((await insert(original(w, await exit5(w), { destinationType: t, needId: need.id, isCountable: true, peopleServed: 4, peopleUnit: "pessoas" }))).id, t).toBeDefined();
    }
    await expect(insert(original(w, await exit5(w), { peopleServed: 4 }))).rejects.toThrow(/people_pair/);
    await expect(insert(original(w, await exit5(w), { peopleUnit: "pessoas" }))).rejects.toThrow(/people_pair/);
    // pessoas atendidas é métrica distinta da quantidade física (nunca preenche zero por padrão)
    expect((await row((await insert(original(w, await exit5(w)))).id)).peopleServed).toBeNull();
  });

  it("a necessidade vinculada precisa ser do mesmo item quando tem item; excedente e retroação exigem quem autorizou", async () => {
    const w = await world();
    const other = await createTestInventoryItem(w.org.id, w.owner.userId, { name: "Feijão", unit: "kg" });
    const [need] = await db.insertInto("needs").values({ organizationId: w.org.id, itemId: other.id, title: "Feijão", quantityNeeded: "10", unit: "kg", priority: "media", status: "aberta", createdByUserId: w.owner.userId }).returning("id").execute();
    await expect(insert(original(w, await exit5(w), { needId: need.id, destinationType: "atendimento_coletivo" }))).rejects.toThrow(/necessidade é de outro item/);
    await expect(insert(original(w, await exit5(w), { surplusReason: "acima do solicitado" }))).rejects.toThrow(/authorization_chk/);
    expect((await insert(original(w, await exit5(w), { lateRegistrationReason: "registro tardio justificado", authorizedByUserId: w.owner.userId }))).id).toBeDefined();
  });

  it("13: autoria e data de registro são obrigatórias; data efetiva é obrigatória na original e não pode ser absurdamente futura", async () => {
    const w = await world();
    await expect(insert(original(w, await exit5(w), { createdByUserId: null }))).rejects.toThrow(/null value|not-null/i);
    await expect(insert(original(w, await exit5(w), { deliveredOn: null }))).rejects.toThrow(/original_shape/);
    await expect(insert(original(w, await exit5(w), { deliveredOn: sql`current_date + 5` }))).rejects.toThrow(/delivered_on_sane/);
    await expect(insert(original(w, await exit5(w), { createdAt: null }))).rejects.toThrow();
  });
});

describe("stock_destinations — correções e reversões como eventos", () => {
  async function withOriginal() {
    const w = await world();
    const exit = await exit5(w);
    const o = await insert(original(w, exit, { peopleServed: 10, peopleUnit: "pessoas" }));
    return { w, exit, o };
  }

  it("9/12: a correção documental referencia a original, não traz campos contábeis e preserva a linha original intacta", async () => {
    const { w, o } = await withOriginal();
    const before = await row(o.id);
    const c = await insert({ organizationId: w.org.id, entryType: "correction", itemId: w.item.id, reversesDestinationId: o.id, reason: "número de pessoas informado errado", peopleServed: 8, peopleUnit: "pessoas", createdByUserId: w.owner.userId });
    expect((await row(c.id)).reversesDestinationId).toBe(String(o.id));
    expect(await row(o.id)).toEqual(before); // a original NÃO foi sobrescrita
    // campos contábeis, sem motivo e sem nenhum campo corrigido são rejeitados
    const bad = (over: Record<string, unknown>) => insert({ organizationId: w.org.id, entryType: "correction", itemId: w.item.id, reversesDestinationId: o.id, reason: "motivo suficiente", notes: "obs", createdByUserId: w.owner.userId, ...over });
    await expect(bad({ quantity: "1" })).rejects.toThrow(/correction_shape/);
    await expect(bad({ destinationType: "perda" })).rejects.toThrow(/correction_shape/);
    await expect(bad({ needId: null, stockTransactionId: o.id })).rejects.toThrow();
    await expect(bad({ reason: null })).rejects.toThrow(/correction_shape/);
    await expect(bad({ reason: "ruim" })).rejects.toThrow(/correction_shape/);
    await expect(bad({ notes: null })).rejects.toThrow(/correction_shape/);
    await expect(bad({ reversesDestinationId: null })).rejects.toThrow(/correction_shape|ORIGINAL/);
  });

  it("correção e reversão só referem a ORIGINAL (nunca a outro evento), do mesmo item e da mesma organização", async () => {
    const { w, o } = await withOriginal();
    const c = await insert({ organizationId: w.org.id, entryType: "correction", itemId: w.item.id, reversesDestinationId: o.id, reason: "observação corrigida", notes: "nova", createdByUserId: w.owner.userId });
    await expect(insert({ organizationId: w.org.id, entryType: "correction", itemId: w.item.id, reversesDestinationId: c.id, reason: "corrigindo a correção", notes: "x", createdByUserId: w.owner.userId })).rejects.toThrow(/ORIGINAL/);
    const other = await createTestInventoryItem(w.org.id, w.owner.userId, { name: "Outro", unit: "kg" });
    await expect(insert({ organizationId: w.org.id, entryType: "correction", itemId: other.id, reversesDestinationId: o.id, reason: "item diferente", notes: "x", createdByUserId: w.owner.userId })).rejects.toThrow(/item deve ser o da destinação original/);
    const b = await world();
    await expect(insert({ organizationId: b.org.id, entryType: "correction", itemId: b.item.id, reversesDestinationId: o.id, reason: "original de outra organização", notes: "x", createdByUserId: b.owner.userId })).rejects.toThrow(/reverses_org_fkey|foreign key|ORIGINAL|item deve ser/);
    // pessoas atendidas só se a original é de atendimento
    const perda = await insert(original(w, await exit5(w), { destinationType: "perda", notes: "avaria no transporte" }));
    await expect(insert({ organizationId: w.org.id, entryType: "correction", itemId: w.item.id, reversesDestinationId: perda.id, reason: "pessoas em perda", peopleServed: 3, peopleUnit: "pessoas", createdByUserId: w.owner.userId })).rejects.toThrow(/só em finalidade de atendimento/);
  });

  it("10/29: os três tipos de reversão são coerentes com o movimento: estorno documental sem movimento, devolução física com ENTRADA, correção de quantidade com AJUSTE positivo", async () => {
    const { w, o } = await withOriginal();
    const rev = (over: Record<string, unknown>) => insert({ organizationId: w.org.id, entryType: "reversal", itemId: w.item.id, reversesDestinationId: o.id, unit: "kg", reason: "reversão de teste coerente", createdByUserId: w.owner.userId, ...over });
    const doc = await rev({ reversalKind: "estorno_documental", quantity: "1" });
    expect((await row(doc.id)).stockTransactionId).toBeNull();
    await expect(rev({ reversalKind: "estorno_documental", quantity: "1", stockTransactionId: await tx(w, "entrada", 1) })).rejects.toThrow(/reversal_shape|compensatório/);
    await expect(rev({ reversalKind: "devolucao_fisica", quantity: "1" })).rejects.toThrow(/reversal_shape|compensatório/); // exige movimento
    await expect(rev({ reversalKind: "devolucao_fisica", quantity: "1", stockTransactionId: await tx(w, "saida", -1) })).rejects.toThrow(/exige uma ENTRADA/);
    await expect(rev({ reversalKind: "devolucao_fisica", quantity: "1", stockTransactionId: await tx(w, "entrada", 2) })).rejects.toThrow(/exige uma ENTRADA/);
    const ret = await rev({ reversalKind: "devolucao_fisica", quantity: "1", stockTransactionId: await tx(w, "entrada", 1) });
    expect((await row(ret.id)).reversalKind).toBe("devolucao_fisica");
    await expect(rev({ reversalKind: "correcao_quantidade", quantity: "1", stockTransactionId: await tx(w, "ajuste", -1) })).rejects.toThrow(/AJUSTE positivo/);
    const fix = await rev({ reversalKind: "correcao_quantidade", quantity: "1", stockTransactionId: await tx(w, "ajuste", 1) });
    expect(fix.id).toBeDefined();
    // um movimento compensatório sustenta UMA reversão
    const moved = await tx(w, "entrada", 1);
    await rev({ reversalKind: "devolucao_fisica", quantity: "1", stockTransactionId: moved });
    await expect(rev({ reversalKind: "devolucao_fisica", quantity: "1", stockTransactionId: moved })).rejects.toThrow(/uq_stock_destinations_reversal_movement|duplicate/);
    // a devolução ao doador é uma FINALIDADE, não uma reversão: a coluna de finalidade é distinta de reversal_kind
    const donorReturn = await insert(original(w, await exit5(w), { destinationType: "devolucao_ao_doador", notes: "devolvido ao doador original" }));
    expect((await row(donorReturn.id)).reversalKind).toBeNull();
  });

  it("a soma das reversões não passa da quantidade da original e unidade/quantidade da reversão são validadas", async () => {
    const { w, o } = await withOriginal();
    const rev = (q: string, over: Record<string, unknown> = {}) => insert({ organizationId: w.org.id, entryType: "reversal", itemId: w.item.id, reversesDestinationId: o.id, reversalKind: "estorno_documental", quantity: q, unit: "kg", reason: "reversão parcial de teste", createdByUserId: w.owner.userId, ...over });
    await rev("3");
    await expect(rev("2.001")).rejects.toThrow(/soma das reversões excede/);
    await expect(rev("0")).rejects.toThrow();
    await expect(rev("-1")).rejects.toThrow();
    await expect(rev("1", { unit: "litro" })).rejects.toThrow(/unidade da reversão/);
    await rev("2"); // completa exatamente
    await expect(rev("0.001")).rejects.toThrow(/soma das reversões excede/);
  });

  it("11/12/13: nenhum evento pode ser alterado ou apagado; o histórico original permanece depois de eventos relacionados", async () => {
    const { w, o } = await withOriginal();
    const before = await row(o.id);
    await insert({ organizationId: w.org.id, entryType: "reversal", itemId: w.item.id, reversesDestinationId: o.id, reversalKind: "estorno_documental", quantity: "1", unit: "kg", reason: "registro com erro", createdByUserId: w.owner.userId });
    expect(await row(o.id)).toEqual(before);
    await expect(db.updateTable("stockDestinations").set({ notes: "adulterado" }).where("id", "=", String(o.id) as never).execute()).rejects.toThrow(/append-only|imutável|não/i);
    await expect(db.updateTable("stockDestinations").set({ quantity: "99" }).where("organizationId", "=", w.org.id).execute()).rejects.toThrow();
    await expect(db.deleteFrom("stockDestinations").where("id", "=", String(o.id) as never).execute()).rejects.toThrow();
    // a saída e a organização referenciadas não podem ser apagadas debaixo da destinação (RESTRICT + imutabilidade)
    await expect(db.deleteFrom("stockTransactions").where("id", "=", String(before.stockTransactionId) as never).execute()).rejects.toThrow();
    await expect(db.deleteFrom("organizations").where("id", "=", w.org.id).execute()).rejects.toThrow();
  });
});

describe("stock_destinations — compatibilidade e histórico", () => {
  it("23/27: o schema não classifica saídas históricas: as saídas antigas continuam sem destinação estruturada (sem backfill) e seguem consultáveis", async () => {
    const w = await world();
    const manual = await exit5(w);
    const automatic = await exit5(w);
    const [need] = await db.insertInto("needs").values({ organizationId: w.org.id, itemId: w.item.id, title: "Baixa automática", quantityNeeded: "5", unit: "kg", priority: "media", status: "aberta", createdByUserId: w.owner.userId }).returning("id").execute();
    await db.insertInto("needResolutions").values({ needId: need.id, stockTransactionId: automatic, createdByUserId: w.owner.userId }).execute();
    const classified = await exit5(w);
    await insert(original(w, classified));
    // consulta documentada na especificação (7.5): saída sem destinação ORIGINAL = "sem destinação estruturada", em duas subclasses
    const hist = await sql<{ id: string; subclass: string }>`
      SELECT s.id::text AS id, CASE WHEN r.id IS NOT NULL THEN 'baixa_automatica_historica' ELSE 'saida_manual_anterior' END AS subclass
      FROM stock_transactions s
      LEFT JOIN need_resolutions r ON r.stock_transaction_id = s.id
      WHERE s.type = 'saida' AND s.organization_id = ${w.org.id}
        AND NOT EXISTS (SELECT 1 FROM stock_destinations d WHERE d.entry_type = 'original' AND d.stock_transaction_id = s.id)
      ORDER BY s.id`.execute(db);
    expect(hist.rows).toEqual([{ id: String(manual), subclass: "saida_manual_anterior" }, { id: String(automatic), subclass: "baixa_automatica_historica" }]);
    expect(await db.selectFrom("stockDestinations").select("id").where("organizationId", "=", w.org.id).execute()).toHaveLength(1); // só a que o teste criou
  });

  it("a migration não grava dados: a tabela nasce vazia e inserir uma destinação não altera stock_transactions nem o ledger", async () => {
    const w = await world();
    const exit = await exit5(w);
    const stockBefore = (await db.selectFrom("stockTransactions").select("id").execute()).length;
    const ledgerBefore = (await db.selectFrom("needFulfillments").select("id").execute()).length;
    await insert(original(w, exit));
    expect((await db.selectFrom("stockTransactions").select("id").execute()).length).toBe(stockBefore);
    expect((await db.selectFrom("needFulfillments").select("id").execute()).length).toBe(ledgerBefore);
  });

  it("a CHECK de unidade espelha o vocabulário canônico (paridade com unitVocabulary.ts)", async () => {
    const def = (await sql<{ d: string }>`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'stock_destinations_unit_chk'`.execute(db)).rows[0].d;
    const inDb = [...def.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(inDb).toEqual(UNIT_WRITE_OPTIONS.map((o) => o.label).sort());
  });

  it("as oito finalidades aprovadas são exatamente as aceitas pelo banco", async () => {
    const def = (await sql<{ d: string }>`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'stock_destinations_type_chk'`.execute(db)).rows[0].d;
    expect([...def.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()).toEqual(
      ["atendimento_coletivo", "descarte", "devolucao_ao_doador", "distribuicao_familias", "doacao_a_terceiro", "entrega_instituicao_parceira", "perda", "uso_operacional_instituicao"].sort()
    );
  });

  it("a migration é aditiva: o arquivo só cria objetos novos e não contém UPDATE/DELETE/INSERT sobre tabelas existentes", () => {
    for (const f of ["0017_item_file_org_keys.sql", "0018_stock_destinations.sql", "0019_need_closures.sql"]) {
      const text = readFileSync(path.join(process.cwd(), "db", "migrations", f), "utf8").replace(/--[^\n]*/g, "");
      expect(text, f).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(TABLE|COLUMN)|TRUNCATE)\b/i);
      if (f !== "0017_item_file_org_keys.sql") expect(text, f).not.toMatch(/\bALTER\s+TABLE\b/i);
    }
  });
});

describe("stock_destinations — concorrência garantida pelo banco (trava na saída e na original)", () => {
  it("duas destinações simultâneas da mesma saída produzem UMA; reversões simultâneas nunca passam da quantidade da original", async () => {
    const w = await world();
    const exit = await exit5(w);
    const firsts = await Promise.allSettled([insert(original(w, exit)), insert(original(w, exit, { destinationType: "atendimento_coletivo" })), insert(original(w, exit, { destinationType: "perda", notes: "avaria no depósito central" }))]);
    expect(firsts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const o = (await db.selectFrom("stockDestinations").select("id").where("stockTransactionId", "=", String(exit) as never).where("entryType", "=", "original").execute())[0];
    expect(o).toBeDefined();
    const rev = () => insert({ organizationId: w.org.id, entryType: "reversal", itemId: w.item.id, reversesDestinationId: o.id, reversalKind: "estorno_documental", quantity: "3", unit: "kg", reason: "estorno concorrente de teste", createdByUserId: w.owner.userId });
    const revs = await Promise.allSettled([rev(), rev(), rev()]);
    expect(revs.filter((r) => r.status === "fulfilled")).toHaveLength(1); // 3 + 3 > 5: só uma cabe
    const total = await db.selectFrom("stockDestinations").select(sql<string>`COALESCE(SUM(quantity), 0)`.as("t")).where("reversesDestinationId", "=", String(o.id) as never).where("entryType", "=", "reversal").executeTakeFirstOrThrow();
    expect(Number(total.t)).toBeLessThanOrEqual(5);
  });
});
