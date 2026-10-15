/**
 * Fase 99D — contrato ESTRUTURAL de need_closures (PostgreSQL real, banco `_test`). Nenhum fluxo de aplicação grava aqui nesta fase (a mudança de needs.status e o cálculo do
 * atendido são da 99F): os testes inserem direto no banco para provar o que o schema garante.
 */
import { describe, it, expect, afterAll } from "vitest";
import postgres from "postgres";
import { db } from "../src/helpers/db";
import { createAuthenticatedUser, createTestOrganization } from "./helpers";

const side = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
afterAll(async () => { await side.end({ timeout: 5 }); });

async function world(needStatus: "aberta" | "atendida" | "cancelada" = "aberta") {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const [need] = await db.insertInto("needs").values({ organizationId: org.id, title: "Cestas básicas", quantityNeeded: "100", unit: "kg", priority: "media", status: needStatus, createdByUserId: owner.userId }).returning("id").execute();
  return { owner, org, need };
}
type W = Awaited<ReturnType<typeof world>>;

const closure = (w: W, over: Record<string, unknown> = {}) => ({
  organizationId: w.org.id,
  needId: w.need.id,
  entryType: "encerramento" as const,
  reasonCode: "recursos_insuficientes",
  quantityNeededSnapshot: "100",
  attendedSnapshot: "0",
  remainingSnapshot: "100",
  createdByUserId: w.owner.userId,
  ...over,
});
const insert = (v: Record<string, unknown>) => db.insertInto("needClosures").values(v as never).returning(["id"]).executeTakeFirstOrThrow();
const setStatus = (w: W, status: string) => db.updateTable("needs").set({ status: status as never }).where("id", "=", w.need.id).execute();
const row = (id: string | number) => db.selectFrom("needClosures").selectAll().where("id", "=", String(id) as never).executeTakeFirstOrThrow();

describe("need_closures — encerramento", () => {
  it("15: aceita um encerramento válido com motivo estruturado, instantâneos, autoria e data do servidor", async () => {
    const w = await world();
    const c = await insert(closure(w));
    const r = await row(c.id);
    expect(r).toMatchObject({ entryType: "encerramento", reasonCode: "recursos_insuficientes", createdByUserId: w.owner.userId });
    expect(Number(r.quantityNeededSnapshot)).toBe(100);
    expect(Number(r.remainingSnapshot)).toBe(100);
    expect(r.createdAt).toBeInstanceOf(Date);
  });

  it("16: necessidade de outra organização é rejeitada pela chave composta (e a organização do evento precisa ser a da necessidade)", async () => {
    const a = await world();
    const b = await world();
    await expect(insert(closure(a, { needId: b.need.id }))).rejects.toThrow(/need_org_fkey|foreign key/);
    await expect(insert(closure(b, { organizationId: a.org.id }))).rejects.toThrow(/need_org_fkey|foreign key/);
  });

  it("17: motivo inexistente/ausente é rejeitado; 'outro' e atendimento parcial exigem descrição", async () => {
    const w = await world();
    await expect(insert(closure(w, { reasonCode: "porque_sim" }))).rejects.toThrow(/reason_code/);
    await expect(insert(closure(w, { reasonCode: null }))).rejects.toThrow(/closure_shape/);
    await expect(insert(closure(w, { reasonCode: "outro" }))).rejects.toThrow(/closure_shape/);
    await expect(insert(closure(w, { reasonCode: "outro", reasonText: "curto" }))).rejects.toThrow(/closure_shape/);
    await expect(insert(closure(w, { attendedSnapshot: "40", remainingSnapshot: "60" }))).rejects.toThrow(/closure_shape/); // parcial sem descrição
    const ok = await insert(closure(w, { attendedSnapshot: "40", remainingSnapshot: "60", reasonText: "Doações pararam; 40 kg já entregues" }));
    expect(Number((await row(ok.id)).remainingSnapshot)).toBe(60);
  });

  it("instantâneos coerentes: positivos/não negativos e saldo = solicitado − atendido (nunca negativo)", async () => {
    const w = await world();
    await expect(insert(closure(w, { quantityNeededSnapshot: "0", remainingSnapshot: "0" }))).rejects.toThrow(/needed_chk|solicitado menos atendido/);
    await expect(insert(closure(w, { attendedSnapshot: "-1" }))).rejects.toThrow(/attended_chk|solicitado menos atendido/);
    await expect(insert(closure(w, { remainingSnapshot: "-1" }))).rejects.toThrow(/remaining_chk|solicitado menos atendido/);
    await expect(insert(closure(w, { remainingSnapshot: "70" }))).rejects.toThrow(/solicitado menos atendido/);
    await expect(insert(closure(w, { quantityNeededSnapshot: null }))).rejects.toThrow(/closure_shape/);
    // atendido acima do solicitado (excedente): saldo 0
    const ok = await insert(closure(w, { attendedSnapshot: "120", remainingSnapshot: "0", reasonText: "Atendimento acima do pedido registrado" }));
    expect(ok.id).toBeDefined();
  });

  it("encerramento só de necessidade ABERTA: atendida não é desfeita e cancelada já está encerrada", async () => {
    const done = await world("atendida");
    await expect(insert(closure(done))).rejects.toThrow(/só uma necessidade aberta/);
    const cancelled = await world("cancelada");
    await expect(insert(closure(cancelled))).rejects.toThrow(/só uma necessidade aberta/);
  });

  it("21: um encerramento ATIVO por necessidade; um novo só depois de uma reabertura", async () => {
    const w = await world();
    const first = await insert(closure(w));
    await expect(insert(closure(w, { reasonCode: "duplicidade" }))).rejects.toThrow(/já tem um encerramento ativo/);
    await setStatus(w, "cancelada");
    await insert({ organizationId: w.org.id, needId: w.need.id, entryType: "reabertura", correctsClosureId: first.id, reasonText: "Encerramento registrado por engano", createdByUserId: w.owner.userId });
    await setStatus(w, "aberta");
    const second = await insert(closure(w, { reasonCode: "necessidade_superada" }));
    expect(second.id).not.toBe(first.id);
    await expect(insert(closure(w))).rejects.toThrow(/já tem um encerramento ativo/);
  });

  it("21b: dois encerramentos concorrentes da mesma necessidade produzem UM (trava da necessidade)", async () => {
    const w = await world();
    const results = await Promise.allSettled([insert(closure(w)), insert(closure(w, { reasonCode: "duplicidade" })), insert(closure(w, { reasonCode: "necessidade_superada" }))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await db.selectFrom("needClosures").select("id").where("needId", "=", w.need.id).execute())).toHaveLength(1);
  });
});

describe("need_closures — correção (reabertura) sem apagar o original", () => {
  async function closed() {
    const w = await world();
    const c = await insert(closure(w, { attendedSnapshot: "30", remainingSnapshot: "70", reasonText: "Doadores desistiram; 30 kg já entregues" }));
    await setStatus(w, "cancelada");
    return { w, c };
  }

  it("22: a reabertura referencia o encerramento, exige motivo e preserva o original intacto; o encerramento é corrigido no máximo uma vez", async () => {
    const { w, c } = await closed();
    const before = await row(c.id);
    const reopen = (over: Record<string, unknown> = {}) => insert({ organizationId: w.org.id, needId: w.need.id, entryType: "reabertura", correctsClosureId: c.id, reasonText: "Voltaram a doar; necessidade retomada", createdByUserId: w.owner.userId, ...over });
    await expect(reopen({ reasonText: null })).rejects.toThrow(/reopen_shape/);
    await expect(reopen({ reasonText: "ruim" })).rejects.toThrow(/reopen_shape/);
    await expect(reopen({ correctsClosureId: null })).rejects.toThrow(/reopen_shape|reabertura corrige/);
    await expect(reopen({ reasonCode: "outro" })).rejects.toThrow(/reopen_shape/);
    await expect(reopen({ attendedSnapshot: "1" })).rejects.toThrow(/reopen_shape/);
    const r = await reopen();
    expect((await row(r.id)).correctsClosureId).toBe(String(c.id));
    expect(await row(c.id)).toEqual(before);
    await expect(reopen()).rejects.toThrow(/uq_need_closures_corrected_once|duplicate|cancelada/);
  });

  it("a reabertura corrige um ENCERRAMENTO da MESMA necessidade e organização, e só de necessidade cancelada", async () => {
    const { w, c } = await closed();
    const other = await world("cancelada");
    await expect(insert({ organizationId: other.org.id, needId: other.need.id, entryType: "reabertura", correctsClosureId: c.id, reasonText: "encerramento de outra necessidade", createdByUserId: other.owner.userId })).rejects.toThrow(/corrects_org_fkey|foreign key|mesma necessidade/);
    const reopened = await insert({ organizationId: w.org.id, needId: w.need.id, entryType: "reabertura", correctsClosureId: c.id, reasonText: "Necessidade retomada pela organização", createdByUserId: w.owner.userId });
    await expect(insert({ organizationId: w.org.id, needId: w.need.id, entryType: "reabertura", correctsClosureId: reopened.id, reasonText: "corrigindo uma reabertura", createdByUserId: w.owner.userId })).rejects.toThrow(/mesma necessidade|encerramento/);
    const open = await world("aberta");
    const oc = await insert(closure(open));
    await expect(insert({ organizationId: open.org.id, needId: open.need.id, entryType: "reabertura", correctsClosureId: oc.id, reasonText: "reabrir uma necessidade ainda aberta", createdByUserId: open.owner.userId })).rejects.toThrow(/só uma necessidade cancelada/);
  });
});

describe("need_closures — imutabilidade e ausência de efeito colateral", () => {
  it("20: encerramentos e reaberturas não podem ser alterados nem apagados", async () => {
    const w = await world();
    const c = await insert(closure(w));
    await expect(db.updateTable("needClosures").set({ reasonCode: "duplicidade" }).where("id", "=", String(c.id) as never).execute()).rejects.toThrow(/append-only|imutável|não/i);
    await expect(db.updateTable("needClosures").set({ remainingSnapshot: "0" }).where("needId", "=", w.need.id).execute()).rejects.toThrow();
    await expect(db.deleteFrom("needClosures").where("id", "=", String(c.id) as never).execute()).rejects.toThrow();
    await expect(db.deleteFrom("needs").where("id", "=", w.need.id).execute()).rejects.toThrow(); // RESTRICT: a necessidade com histórico não some
  });

  it("18/19: inserir um encerramento não gera movimento de estoque, não altera a necessidade (solicitado e status) nem registros de atendimento", async () => {
    const w = await world();
    const [item] = await db.insertInto("inventoryItems").values({ organizationId: w.org.id, name: "Arroz", unit: "kg", createdByUserId: w.owner.userId }).returning("id").execute();
    await db.insertInto("stockTransactions").values({ organizationId: w.org.id, itemId: item.id, type: "entrada", delta: "50", reason: "saldo", createdByUserId: w.owner.userId }).execute();
    await db.insertInto("needResolutions").values({ needId: (await db.insertInto("needs").values({ organizationId: w.org.id, title: "Outra", quantityNeeded: "5", unit: "kg", priority: "media", status: "aberta", createdByUserId: w.owner.userId }).returning("id").executeTakeFirstOrThrow()).id, createdByUserId: w.owner.userId }).execute();
    const snap = async () => ({
      stock: (await db.selectFrom("stockTransactions").selectAll().execute()).length,
      ledger: (await db.selectFrom("needFulfillments").selectAll().execute()).length,
      resolutions: (await db.selectFrom("needResolutions").selectAll().execute()).length,
      need: await db.selectFrom("needs").selectAll().where("id", "=", w.need.id).executeTakeFirstOrThrow(),
    });
    const before = await snap();
    await insert(closure(w));
    const after = await snap();
    expect(after).toEqual(before); // nada mudou: a necessidade segue com a quantidade original e o status que a aplicação definir depois
    expect(Number(after.need.quantityNeeded)).toBe(100);
  });

  it("a tabela não tem referência a movimento de estoque (encerrar nunca baixa estoque)", async () => {
    const cols = (await db.introspection.getTables()).find((t) => t.name === "need_closures")!.columns.map((c) => c.name);
    expect(cols).not.toContain("stock_transaction_id");
    expect(cols).not.toContain("delta");
  });
});
