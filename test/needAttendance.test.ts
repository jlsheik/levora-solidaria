/**
 * Fase 99F — atendimento da necessidade DERIVADO das destinações válidas (PostgreSQL real, banco `_test`): atendimento parcial, `atendida` automática, excedente com
 * autorização estruturada, unidade incompatível, encerramento/reabertura atômicos sem movimento de estoque, histórico, isolamento e concorrência.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { businessDateOf } from "../src/helpers/businessDate";
import { computeAttendanceProgress, getNeedAttendance, remainingToAttend } from "../src/helpers/needAttendance";
import { handle as destHandle } from "../src/endpoints/stock-destinations_POST";
import { handle as closureHandle } from "../src/endpoints/need-closure_POST";
import { addMembership, buildRequest, createAuthenticatedUser, createTestInventoryItem, createTestOrganization, parseJson } from "./helpers";

const post = (p: string, cookie: string, body: unknown) => buildRequest(p, { method: "POST", cookie, body });
const key = () => `k-${randomBytes(8).toString("hex")}`;

async function world(opts: { needQuantity?: number; needUnit?: string; itemUnit?: string; linkItem?: boolean } = {}) {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const admin = await createAuthenticatedUser();
  await addMembership(org.id, admin.userId, "administrador");
  const operator = await createAuthenticatedUser();
  await addMembership(org.id, operator.userId, "operador");
  const volunteer = await createAuthenticatedUser();
  await addMembership(org.id, volunteer.userId, "voluntario");
  const item = await createTestInventoryItem(org.id, owner.userId, { name: "Arroz", unit: opts.itemUnit ?? "kg" });
  await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: item.id, type: "entrada", delta: "10000", reason: "saldo inicial", createdByUserId: owner.userId }).execute();
  const [need] = await db
    .insertInto("needs")
    .values({ organizationId: org.id, itemId: opts.linkItem === false ? null : item.id, title: "Cestas", quantityNeeded: String(opts.needQuantity ?? 40), unit: opts.needUnit ?? "kg", priority: "alta", createdByUserId: owner.userId })
    .returning("id")
    .execute();
  return { owner, admin, operator, volunteer, org, item, needId: need.id };
}
type W = Awaited<ReturnType<typeof world>>;
type Auth = W["owner"];

const dest = (w: W, quantity: number, over: Record<string, unknown> = {}, user: Auth = w.operator) =>
  destHandle(post("stock-destinations", user.cookie, { organizationId: w.org.id, itemId: w.item.id, quantity, destinationType: "distribuicao_familias", needId: w.needId, deliveredOn: businessDateOf(new Date()), idempotencyKey: key(), ...over }));
const closure = (w: W, body: Record<string, unknown>, user: Auth = w.operator) => closureHandle(post("need-closure", user.cookie, { organizationId: w.org.id, needId: w.needId, ...body }));
const needStatus = async (w: W) => (await db.selectFrom("needs").select("status").where("id", "=", w.needId).executeTakeFirstOrThrow()).status;
const exitCount = async (w: W) => Number((await db.selectFrom("stockTransactions").select((eb) => eb.fn.countAll().as("c")).where("itemId", "=", w.item.id).where("type", "=", "saida").executeTakeFirstOrThrow()).c);
const balance = async (w: W) => Number((await db.selectFrom("stockTransactions").select(sql<string>`COALESCE(SUM(delta),0)`.as("t")).where("itemId", "=", w.item.id).executeTakeFirstOrThrow()).t);
const code = async (r: Response) => (await parseJson<{ code?: string }>(r)).code;

describe("A. atendimento derivado das destinações", () => {
  it("parcial: soma só destinações válidas de atendimento, mantém a necessidade aberta e não cria status novo", async () => {
    const w = await world();
    expect((await dest(w, 10)).status).toBe(200);
    expect((await dest(w, 15)).status).toBe(200);
    const a = await getNeedAttendance(db, w.needId);
    expect(a).toMatchObject({ appliedNet: 25, physicalNet: 25, surplusNet: 0, unitIncompatiblePhysical: 0, destinationCount: 2 });
    expect(computeAttendanceProgress(40, a, "aberta")).toMatchObject({ attended: 25, remaining: 15, percent: 62.5, state: "parcial" });
    expect(await needStatus(w)).toBe("aberta");
    expect(remainingToAttend(40, a)).toBe(15);
  });

  it("a destinação que completa a quantidade leva a necessidade a 'atendida' na mesma transação; depois disso nenhuma outra é aceita", async () => {
    const w = await world();
    expect((await dest(w, 15)).status).toBe(200);
    expect((await dest(w, 25)).status).toBe(200);
    expect(await needStatus(w)).toBe("atendida");
    expect(computeAttendanceProgress(40, await getNeedAttendance(db, w.needId), "atendida")).toMatchObject({ attended: 40, remaining: 0, percent: 100, state: "atendida" });
    const again = await dest(w, 1);
    expect(again.status).toBe(409);
    expect(await code(again)).toBe("necessidade_nao_aberta");
    expect(await exitCount(w)).toBe(2); // a recusa não deixou saída
    const auto = await db.selectFrom("auditLog").select("id").where("action", "=", "necessidade.atendida_automaticamente").execute();
    expect(auto).toHaveLength(1);
  });

  it("finalidades que não são de atendimento não podem se vincular à necessidade (400) e não contam", async () => {
    const w = await world();
    const r = await dest(w, 5, { destinationType: "perda", notes: "Validade vencida do lote" });
    expect(r.status).toBe(400);
    expect(await exitCount(w)).toBe(0);
  });

  it("unidade incompatível: a saída física existe, mas NÃO conta como atendimento (nada é convertido)", async () => {
    const w = await world({ needUnit: "caixas", linkItem: false });
    const r = await dest(w, 5);
    expect(r.status).toBe(200);
    expect((await parseJson<{ destination: { isCountable: boolean } }>(r)).destination.isCountable).toBe(false);
    const a = await getNeedAttendance(db, w.needId);
    expect(a).toMatchObject({ appliedNet: 0, unitIncompatiblePhysical: 5, physicalNet: 5 });
    expect(computeAttendanceProgress(40, a, "aberta")).toMatchObject({ attended: 0, unitIncompatibleDestined: 5, state: "sem_atendimento" });
    expect(await needStatus(w)).toBe("aberta");
  });

  it("registro histórico: 'atendida' sem destinação é sinalizado como histórico, sem inventar destinação", async () => {
    const w = await world();
    await db.updateTable("needs").set({ status: "atendida" }).where("id", "=", w.needId).execute();
    const a = await getNeedAttendance(db, w.needId);
    expect(a.destinationCount).toBe(0);
    expect(computeAttendanceProgress(40, a, "atendida")).toMatchObject({ attended: 0, remaining: 40, state: "atendida_historica" });
    expect(await db.selectFrom("stockDestinations").select("id").execute()).toHaveLength(0);
  });
});

describe("B. excedente", () => {
  it("sem autorização: 409 com o máximo aplicável, sem saída; operador não autoriza (403); motivo curto (422); administrador com motivo registra aplicado + excedente", async () => {
    const w = await world({ needQuantity: 10 });
    const blocked = await dest(w, 15);
    expect(blocked.status).toBe(409);
    expect(await parseJson<{ code: string; maxAplicavel: number }>(blocked)).toMatchObject({ code: "excedente_nao_autorizado", maxAplicavel: 10 });
    expect(await exitCount(w)).toBe(0);

    const op = await dest(w, 15, { authorizeSurplus: true, surplusReason: "Embalagens fechadas de 5 kg" });
    expect(op.status).toBe(403);
    expect(await code(op)).toBe("excedente_exige_permissao");

    const shortReason = await dest(w, 15, { authorizeSurplus: true, surplusReason: "curto" }, w.admin);
    expect(shortReason.status).toBe(422);
    expect(await exitCount(w)).toBe(0);

    const ok = await dest(w, 15, { authorizeSurplus: true, surplusReason: "Embalagens fechadas de 5 kg" }, w.admin);
    expect(ok.status).toBe(200);
    const [d] = await db.selectFrom("stockDestinations").selectAll().where("needId", "=", w.needId).execute();
    expect(Number(d.quantity)).toBe(15);
    expect(Number(d.appliedQuantity)).toBe(10);
    expect(Number(d.surplusQuantity)).toBe(5);
    expect(d.authorizedByUserId).toBe(w.admin.userId);
    expect(await balance(w)).toBe(10000 - 15); // a quantidade física real nunca é cortada
    expect(await needStatus(w)).toBe("atendida");
    expect(await getNeedAttendance(db, w.needId)).toMatchObject({ appliedNet: 10, surplusNet: 5 });
  });

  it("restrição do banco: aplicada não pode exceder a quantidade, e o total aplicado de uma necessidade não passa da quantidade solicitada", async () => {
    const w = await world({ needQuantity: 10 });
    expect((await dest(w, 8)).status).toBe(200);
    const [tx] = await db.insertInto("stockTransactions").values({ organizationId: w.org.id, itemId: w.item.id, type: "saida", delta: "-5", createdByUserId: w.owner.userId }).returning("id").execute();
    const base = { organizationId: w.org.id, entryType: "original", itemId: w.item.id, stockTransactionId: tx.id, needId: w.needId, destinationType: "distribuicao_familias", quantity: "5", unit: "kg", isCountable: true, deliveredOn: businessDateOf(new Date()), createdByUserId: w.owner.userId };
    await expect(db.insertInto("stockDestinations").values({ ...base, appliedQuantity: "6" } as never).execute()).rejects.toThrow();
    await expect(db.insertInto("stockDestinations").values({ ...base, appliedQuantity: "5" } as never).execute()).rejects.toThrow(/aplicad|atend|necessidade/i); // 8 + 5 > 10
    await expect(db.insertInto("stockDestinations").values({ ...base, appliedQuantity: "2" } as never).execute()).resolves.toBeDefined(); // 8 + 2 = 10
  });
});

describe("C. encerramento e reabertura", () => {
  it("encerrar com atendimento parcial exige descrição, vira 'cancelada' com instantâneo, preserva destinações e NÃO move estoque", async () => {
    const w = await world();
    expect((await dest(w, 15)).status).toBe(200);
    const stockBefore = await balance(w);
    const exitsBefore = await exitCount(w);

    expect((await closure(w, { action: "encerrar", reasonCode: "recursos_insuficientes" })).status).toBe(422);
    expect(await needStatus(w)).toBe("aberta");
    const ok = await closure(w, { action: "encerrar", reasonCode: "recursos_insuficientes", reasonText: "Sem mais estoque para esta campanha" });
    expect(ok.status).toBe(200);
    expect((await parseJson<{ snapshot: unknown }>(ok)).snapshot).toEqual({ requested: 40, attended: 15, remaining: 25 });
    expect(await needStatus(w)).toBe("cancelada");
    expect(await balance(w)).toBe(stockBefore);
    expect(await exitCount(w)).toBe(exitsBefore);
    expect(await db.selectFrom("stockDestinations").select("id").where("needId", "=", w.needId).execute()).toHaveLength(1);
    const [c] = await db.selectFrom("needClosures").selectAll().where("needId", "=", w.needId).execute();
    expect(c).toMatchObject({ entryType: "encerramento", reasonCode: "recursos_insuficientes", createdByUserId: w.operator.userId });
    expect(Number(c.attendedSnapshot)).toBe(15);

    // necessidade encerrada não recebe novas destinações
    const after = await dest(w, 5);
    expect(after.status).toBe(409);
    expect(await code(after)).toBe("necessidade_nao_aberta");
  });

  it("reabrir exige motivo, cria o evento de reabertura (o encerramento continua no histórico) e recalcula o progresso, sem reiniciá-lo", async () => {
    const w = await world();
    await dest(w, 15);
    await closure(w, { action: "encerrar", reasonCode: "duplicidade", reasonText: "Duplicada com outra necessidade" });
    expect((await closure(w, { action: "reabrir", reasonText: "x" })).status).toBe(400);
    expect((await closure(w, { action: "reabrir", reasonText: "Doação inesperada chegou" })).status).toBe(200);
    expect(await needStatus(w)).toBe("aberta");
    const events = await db.selectFrom("needClosures").select("entryType").where("needId", "=", w.needId).orderBy("id").execute();
    expect(events.map((e) => e.entryType)).toEqual(["encerramento", "reabertura"]);
    expect((await getNeedAttendance(db, w.needId)).appliedNet).toBe(15);
    expect((await dest(w, 25)).status).toBe(200);
    expect(await needStatus(w)).toBe("atendida");
    // pode encerrar de novo? não: já atendida
    expect((await closure(w, { action: "encerrar", reasonCode: "duplicidade" })).status).toBe(409);
  });

  it("regras: 'outro' exige descrição; reabrir necessidade que não está encerrada é 409; encerrar duas vezes é 409", async () => {
    const w = await world();
    expect((await closure(w, { action: "encerrar", reasonCode: "outro", reasonText: "curto" })).status).toBe(422);
    expect((await closure(w, { action: "reabrir", reasonText: "Reabrir sem encerrar" })).status).toBe(409);
    expect((await closure(w, { action: "encerrar", reasonCode: "necessidade_superada" })).status).toBe(200);
    expect((await closure(w, { action: "encerrar", reasonCode: "necessidade_superada" })).status).toBe(409);
  });

  it("falha na auditoria desfaz o encerramento inteiro (status e evento)", async () => {
    const w = await world();
    await sql.raw(`CREATE OR REPLACE FUNCTION test_fail_closure() RETURNS trigger AS $f$ BEGIN IF NEW.action = 'necessidade.encerrada' THEN RAISE EXCEPTION 'falha injetada'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`).execute(db);
    await sql.raw(`CREATE TRIGGER test_fail_closure_trg BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_fail_closure()`).execute(db);
    try {
      expect((await closure(w, { action: "encerrar", reasonCode: "duplicidade" })).status).toBeGreaterThanOrEqual(500);
    } finally {
      await sql.raw("DROP TRIGGER IF EXISTS test_fail_closure_trg ON audit_log").execute(db);
      await sql.raw("DROP FUNCTION IF EXISTS test_fail_closure()").execute(db);
    }
    expect(await needStatus(w)).toBe("aberta");
    expect(await db.selectFrom("needClosures").select("id").where("needId", "=", w.needId).execute()).toHaveLength(0);
  });

  it("permissão e isolamento: voluntário não encerra (403); outra organização não enxerga a necessidade (404)", async () => {
    const w = await world();
    expect((await closure(w, { action: "encerrar", reasonCode: "duplicidade" }, w.volunteer)).status).toBe(403);
    const other = await world();
    const cross = await closureHandle(post("need-closure", other.owner.cookie, { action: "encerrar", organizationId: other.org.id, needId: w.needId, reasonCode: "duplicidade" }));
    expect(cross.status).toBe(404);
    expect(await needStatus(w)).toBe("aberta");
  });
});

describe("D. concorrência (Promise.all, PostgreSQL real)", () => {
  it("seis destinações simultâneas de 5 sobre uma necessidade de 10: no máximo 10 aplicados, nunca saída sem destinação, sem 5xx", async () => {
    const w = await world({ needQuantity: 10 });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => dest(w, 5, {}, i % 2 ? w.admin : w.operator)));
    for (const r of results) expect(r.status).toBeLessThan(500);
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBe(2);
    expect(await exitCount(w)).toBe(2);
    expect(await getNeedAttendance(db, w.needId)).toMatchObject({ appliedNet: 10, surplusNet: 0 });
    expect(await needStatus(w)).toBe("atendida");
  });

  it("destinação × encerramento simultâneos: resultado coerente (saída ⇔ destinação) e nenhuma destinação em necessidade já encerrada", async () => {
    for (let round = 0; round < 5; round++) {
      const w = await world();
      const [d, c] = await Promise.all([dest(w, 10), closure(w, { action: "encerrar", reasonCode: "duplicidade" })]);
      expect(d.status).toBeLessThan(500);
      expect(c.status).toBeLessThan(500);
      const destinations = await db.selectFrom("stockDestinations").select("id").where("needId", "=", w.needId).execute();
      expect(destinations.length).toBe(await exitCount(w));
      if (d.status !== 200) expect(await needStatus(w)).toBe("cancelada");
    }
  });
});
