/**
 * Fase 99G — correções documentais, estornos documentais, devoluções físicas e correções de quantidade de destinações (PostgreSQL real, banco `_test`). Prova: o que cada operação
 * move (ou NÃO move) no estoque, o limite reversível, o efeito sobre o atendimento e o estado da necessidade na mesma transação, permissões e isolamento, idempotência,
 * atomicidade (falhas injetadas) e concorrência.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { businessDateOf, parseCivilDate } from "../src/helpers/businessDate";
import { getNeedAttendance, remainingToAttend } from "../src/helpers/needAttendance";
import { overlayCorrections } from "../src/helpers/destinationCorrections";
import { handle as destHandle } from "../src/endpoints/stock-destinations_POST";
import { handle as listHandle } from "../src/endpoints/stock-destinations_GET";
import { handle as reverseHandle } from "../src/endpoints/stock-destination-reversal_POST";
import { handle as correctHandle } from "../src/endpoints/stock-destination-correction_POST";
import { handle as closureHandle } from "../src/endpoints/need-closure_POST";
import { addMembership, buildRequest, createAuthenticatedUser, createTestInventoryItem, createTestOrganization, parseJson } from "./helpers";

type Auth = Awaited<ReturnType<typeof createAuthenticatedUser>>;
const post = (p: string, cookie: string, body: unknown) => buildRequest(p, { method: "POST", cookie, body });
const key = () => `k-${randomBytes(8).toString("hex")}`;
const today = () => businessDateOf(new Date());
const daysAgo = (n: number) => {
  const t = parseCivilDate(today())!;
  return new Date(Date.UTC(t.y, t.m - 1, t.d - n)).toISOString().slice(0, 10);
};

async function world(opts: { needQuantity?: number; balance?: number; needUnit?: string; linkItem?: boolean } = {}) {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const admin = await createAuthenticatedUser();
  await addMembership(org.id, admin.userId, "administrador");
  const operator = await createAuthenticatedUser();
  await addMembership(org.id, operator.userId, "operador");
  const operator2 = await createAuthenticatedUser();
  await addMembership(org.id, operator2.userId, "operador");
  const volunteer = await createAuthenticatedUser();
  await addMembership(org.id, volunteer.userId, "voluntario");
  const item = await createTestInventoryItem(org.id, owner.userId, { name: "Arroz", unit: "kg" });
  await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: item.id, type: "entrada", delta: String(opts.balance ?? 10000), reason: "saldo inicial", createdByUserId: owner.userId }).execute();
  const [need] = await db
    .insertInto("needs")
    .values({ organizationId: org.id, itemId: opts.linkItem === false ? null : item.id, title: "Cestas", quantityNeeded: String(opts.needQuantity ?? 40), unit: opts.needUnit ?? "kg", priority: "alta", createdByUserId: owner.userId })
    .returning("id")
    .execute();
  return { owner, admin, operator, operator2, volunteer, org, item, needId: need.id };
}
type W = Awaited<ReturnType<typeof world>>;

const dest = async (w: W, quantity: number, over: Record<string, unknown> = {}, user: Auth = w.operator) => {
  const res = await destHandle(post("stock-destinations", user.cookie, { organizationId: w.org.id, itemId: w.item.id, quantity, destinationType: "distribuicao_familias", needId: w.needId, deliveredOn: today(), idempotencyKey: key(), ...over }));
  const out = await parseJson<{ destination?: { id: string } }>(res);
  return { status: res.status, id: out.destination?.id as string };
};
const reverse = (w: W, destinationId: string, kind: string, quantity: number, over: Record<string, unknown> = {}, user: Auth = w.admin) =>
  reverseHandle(post("stock-destination-reversal", user.cookie, { organizationId: w.org.id, destinationId, kind, quantity, reason: "Registro feito por engano", idempotencyKey: key(), ...over }));
const correct = (w: W, destinationId: string, over: Record<string, unknown>, user: Auth = w.operator) =>
  correctHandle(post("stock-destination-correction", user.cookie, { organizationId: w.org.id, destinationId, reason: "Corrigindo o registro", idempotencyKey: key(), ...over }));
const balance = async (w: W) => Number((await db.selectFrom("stockTransactions").select(sql<string>`COALESCE(SUM(delta),0)`.as("t")).where("itemId", "=", w.item.id).executeTakeFirstOrThrow()).t);
const needRow = (w: W) => db.selectFrom("needs").select(["status"]).where("id", "=", w.needId).executeTakeFirstOrThrow();
const events = (destId: string, type?: string) => {
  let q = db.selectFrom("stockDestinations").selectAll().where("reversesDestinationId", "=", destId);
  if (type) q = q.where("entryType", "=", type as never);
  return q.orderBy("id").execute();
};
const movements = (w: W, type: string) => db.selectFrom("stockTransactions").selectAll().where("itemId", "=", w.item.id).where("type", "=", type as never).execute();
const audits = (action: string) => db.selectFrom("auditLog").select(["actorUserId", "metadata", "entityId"]).where("action", "=", action).execute();
const code = async (r: Response) => (await parseJson<{ code?: string }>(r)).code;

describe("A. o que cada operação move no estoque", () => {
  it("estorno documental: NENHUM movimento, saldo intacto, original intacta, necessidade reaberta e auditoria completa", async () => {
    const w = await world();
    const d = await dest(w, 40); // completa a necessidade
    expect(d.status).toBe(200);
    expect((await needRow(w)).status).toBe("atendida");
    const stockBefore = await balance(w);
    const txCountBefore = (await db.selectFrom("stockTransactions").select("id").where("itemId", "=", w.item.id).execute()).length;
    const [origBefore] = await db.selectFrom("stockDestinations").selectAll().where("id", "=", d.id).execute();

    const res = await reverse(w, d.id, "estorno_documental", 40, { reason: "Entregue a outra família, registro errado" });
    expect(res.status).toBe(200);
    const out = await parseJson<{ stockMovement: unknown; newStock: unknown; need: { reopened: boolean; attendedBefore: number; attendedAfter: number } }>(res);
    expect(out.stockMovement).toBeNull();
    expect(out.newStock).toBeNull();
    expect(out.need).toMatchObject({ reopened: true, attendedBefore: 40, attendedAfter: 0 });
    expect(await balance(w)).toBe(stockBefore); // nada voltou ao estoque
    expect((await db.selectFrom("stockTransactions").select("id").where("itemId", "=", w.item.id).execute()).length).toBe(txCountBefore);
    const [ev] = await events(d.id, "reversal");
    expect(ev).toMatchObject({ reversalKind: "estorno_documental", stockTransactionId: null, entryType: "reversal" });
    expect(Number(ev.quantity)).toBe(40);
    expect((await db.selectFrom("stockDestinations").selectAll().where("id", "=", d.id).execute())[0]).toEqual(origBefore); // a original nunca muda
    expect((await needRow(w)).status).toBe("aberta");
    expect(await getNeedAttendance(db, w.needId)).toMatchObject({ appliedNet: 0, physicalNet: 0 });
    expect((await audits("destinacao.revertida"))[0]).toMatchObject({ actorUserId: w.admin.userId, entityId: d.id });
    expect((await audits("necessidade.reaberta_automaticamente")).length).toBe(1);
    expect((await audits("inventario.entrada_registrada")).filter((a) => (a.metadata as { motivo?: string }).motivo === "estorno_documental")).toHaveLength(0);
  });

  it("devolução física parcial e total: cria ENTRADAS vinculadas, devolve ao estoque só o que voltou, e a terceira tentativa é recusada", async () => {
    const w = await world({ needQuantity: 100 });
    const d = await dest(w, 10);
    const afterExit = await balance(w);
    const r1 = await reverse(w, d.id, "devolucao_fisica", 4);
    expect(r1.status).toBe(200);
    const o1 = await parseJson<{ stockMovement: { type: string; delta: number }; newStock: number; reversal: { reversibleAfter: number; reversedTotal: number } }>(r1);
    expect(o1.stockMovement).toMatchObject({ type: "entrada", delta: 4 });
    expect(o1.newStock).toBe(afterExit + 4);
    expect(o1.reversal).toMatchObject({ reversedTotal: 4, reversibleAfter: 6 });
    expect((await reverse(w, d.id, "devolucao_fisica", 6)).status).toBe(200);
    expect(await balance(w)).toBe(afterExit + 10);
    const again = await reverse(w, d.id, "devolucao_fisica", 1);
    expect(again.status).toBe(409);
    expect(await code(again)).toBe("excede_reversivel");
    expect(await balance(w)).toBe(afterExit + 10); // nada voltou duas vezes
    const evs = await events(d.id, "reversal");
    expect(evs).toHaveLength(2);
    for (const e of evs) {
      const [tx] = await db.selectFrom("stockTransactions").selectAll().where("id", "=", e.stockTransactionId!).execute();
      expect(tx).toMatchObject({ type: "entrada" });
      expect(Number(tx.delta)).toBe(Number(e.quantity));
    }
    expect(await movements(w, "saida")).toHaveLength(1); // a saída original continua lá, intacta
  });

  it("correção de quantidade: cria um AJUSTE positivo ligado à reversão e reduz o atendimento", async () => {
    const w = await world({ needQuantity: 100 });
    const d = await dest(w, 10);
    const before = await balance(w);
    const res = await reverse(w, d.id, "correcao_quantidade", 3, { reason: "Só saíram 7 kg de fato" });
    expect(res.status).toBe(200);
    expect((await parseJson<{ stockMovement: { type: string } }>(res)).stockMovement.type).toBe("ajuste");
    expect(await balance(w)).toBe(before + 3);
    const [aj] = await movements(w, "ajuste");
    expect(Number(aj.delta)).toBe(3);
    expect((await getNeedAttendance(db, w.needId)).appliedNet).toBe(7);
  });

  it("devolução física de uma destinação que apenas CLASSIFICA um ajuste negativo (sem saída) é recusada; estorno documental é aceito", async () => {
    const w = await world();
    const [tx] = await db.insertInto("stockTransactions").values({ organizationId: w.org.id, itemId: w.item.id, type: "ajuste", delta: "-3", reason: "quebra", createdByUserId: w.owner.userId }).returning("id").execute();
    const [orig] = await db
      .insertInto("stockDestinations")
      .values({ organizationId: w.org.id, entryType: "original", itemId: w.item.id, stockTransactionId: tx.id, destinationType: "perda", quantity: "3", unit: "kg", isCountable: false, deliveredOn: today(), notes: "Quebra de embalagem no transporte", createdByUserId: w.owner.userId } as never)
      .returning("id")
      .execute();
    const r = await reverse(w, String(orig.id), "devolucao_fisica", 3);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe("devolucao_fisica_exige_saida");
    expect((await reverse(w, String(orig.id), "estorno_documental", 3)).status).toBe(200);
  });

  it("validação de entrada: tipo desconhecido, quantidade zero/negativa e motivo curto são 400 e nada é gravado", async () => {
    const w = await world();
    const d = await dest(w, 5);
    for (const bad of [{ kind: "apagar" }, { quantity: 0 }, { quantity: -1 }, { reason: "abc" }, { idempotencyKey: "x" }, { destinationId: "abc" }]) {
      const body = { kind: "estorno_documental", quantity: 1, ...bad };
      expect((await reverse(w, d.id, body.kind as string, body.quantity as number, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await events(d.id)).toHaveLength(0);
  });
});

describe("B. efeito sobre o atendimento e o estado da necessidade", () => {
  it("excedente autorizado: a reversão consome PRIMEIRO o excedente; a necessidade só reabre quando o atendimento cai abaixo do solicitado", async () => {
    const w = await world({ needQuantity: 10 });
    const d = await dest(w, 15, { authorizeSurplus: true, surplusReason: "Embalagens fechadas de 5 kg" }, w.admin);
    expect(d.status).toBe(200);
    expect((await needRow(w)).status).toBe("atendida");
    const r1 = await reverse(w, d.id, "devolucao_fisica", 5);
    expect(await parseJson<{ need: { reopened: boolean; attendedAfter: number } }>(r1)).toMatchObject({ need: { reopened: false, attendedAfter: 10 } });
    expect((await needRow(w)).status).toBe("atendida");
    const r2 = await reverse(w, d.id, "devolucao_fisica", 3);
    expect(await parseJson<{ need: { reopened: boolean; attendedAfter: number; remainingAfter: number } }>(r2)).toMatchObject({ need: { reopened: true, attendedAfter: 7, remainingAfter: 3 } });
    expect((await needRow(w)).status).toBe("aberta");
    expect(remainingToAttend(10, await getNeedAttendance(db, w.needId))).toBe(3); // o matching volta a ver o que falta
  });

  it("reversão parcial de uma destinação entre várias: a necessidade volta ao estado ativo e aceita nova destinação do saldo", async () => {
    const w = await world({ needQuantity: 40 });
    await dest(w, 15);
    const d2 = await dest(w, 25);
    expect((await needRow(w)).status).toBe("atendida");
    const r = await reverse(w, d2.id, "estorno_documental", 10);
    expect((await parseJson<{ need: { reopened: boolean; attendedAfter: number } }>(r)).need).toMatchObject({ reopened: true, attendedAfter: 30 });
    expect((await needRow(w)).status).toBe("aberta");
    expect((await dest(w, 10)).status).toBe(200);
    expect((await needRow(w)).status).toBe("atendida");
    expect(await getNeedAttendance(db, w.needId)).toMatchObject({ appliedNet: 40 });
  });

  it("necessidade CANCELADA (encerrada com motivo) continua cancelada depois da reversão; nenhum evento de reabertura é criado", async () => {
    const w = await world();
    const d = await dest(w, 15);
    expect((await closureHandle(post("need-closure", w.admin.cookie, { action: "encerrar", organizationId: w.org.id, needId: w.needId, reasonCode: "recursos_insuficientes", reasonText: "Sem mais estoque" }))).status).toBe(200);
    const r = await reverse(w, d.id, "estorno_documental", 15);
    expect(r.status).toBe(200);
    expect((await needRow(w)).status).toBe("cancelada");
    expect((await db.selectFrom("needClosures").select("entryType").where("needId", "=", w.needId).execute()).map((c) => c.entryType)).toEqual(["encerramento"]);
    expect((await audits("necessidade.reaberta_automaticamente")).length).toBe(0);
  });

  it("necessidade atendida por RESOLUÇÃO administrativa antiga nunca é reaberta pelo sistema", async () => {
    const w = await world({ needQuantity: 10 });
    const d = await dest(w, 10);
    expect((await needRow(w)).status).toBe("atendida");
    await db.insertInto("needResolutions").values({ needId: w.needId, stockTransactionId: null, createdByUserId: w.owner.userId }).execute();
    const r = await reverse(w, d.id, "estorno_documental", 10);
    expect((await parseJson<{ need: { reopened: boolean } }>(r)).need.reopened).toBe(false);
    expect((await needRow(w)).status).toBe("atendida");
  });

  it("unidade incompatível (não contabilizável): reverter o físico não altera atendimento nem estado da necessidade", async () => {
    const w = await world({ needUnit: "caixas", linkItem: false });
    const d = await dest(w, 5);
    expect(d.status).toBe(200);
    const r = await reverse(w, d.id, "devolucao_fisica", 5);
    expect(r.status).toBe(200);
    expect((await parseJson<{ need: unknown }>(r)).need).toBeNull();
    expect(await getNeedAttendance(db, w.needId)).toMatchObject({ appliedNet: 0, unitIncompatiblePhysical: 0 });
    expect((await needRow(w)).status).toBe("aberta");
  });

  it("o ledger de suprimento (need_fulfillments) não é tocado por nenhuma reversão", async () => {
    const w = await world();
    const d = await dest(w, 40);
    const before = await db.selectFrom("needFulfillments").select("id").execute();
    await reverse(w, d.id, "devolucao_fisica", 40);
    expect(await db.selectFrom("needFulfillments").select("id").execute()).toEqual(before);
  });
});

describe("C. correção documental", () => {
  it("corrige data, pessoas e observações com eventos imutáveis: original intacta, nenhum movimento, visão efetiva sobreposta", async () => {
    const w = await world();
    const d = await dest(w, 5, { notes: "entrega no bairro", peopleServed: 3, peopleUnit: "familias", deliveredOn: daysAgo(2) });
    const stockTx = (await db.selectFrom("stockTransactions").select("id").where("itemId", "=", w.item.id).execute()).length;
    const [origBefore] = await db.selectFrom("stockDestinations").selectAll().where("id", "=", d.id).execute();
    const res = await correct(w, d.id, { deliveredOn: daysAgo(1), peopleServed: 12, peopleUnit: "pessoas", notes: "entrega na escola do bairro" });
    expect(res.status).toBe(200);
    expect((await parseJson<{ correction: { changes: Record<string, unknown> } }>(res)).correction.changes).toHaveProperty("dataEfetiva");
    expect((await db.selectFrom("stockTransactions").select("id").where("itemId", "=", w.item.id).execute()).length).toBe(stockTx);
    expect((await db.selectFrom("stockDestinations").selectAll().where("id", "=", d.id).execute())[0]).toEqual(origBefore);
    const [ev] = await events(d.id, "correction");
    expect(ev).toMatchObject({ entryType: "correction", stockTransactionId: null, quantity: null, needId: null, peopleServed: 12, peopleUnit: "pessoas", notes: "entrega na escola do bairro" });
    expect((await audits("destinacao.corrigida"))[0]).toMatchObject({ entityId: d.id });

    const list = await parseJson<{ destinations: Array<{ id: string; recorded: { notes: string }; effective: { notes: string; peopleServed: number; deliveredOn: string }; events: unknown[] }> }>(
      await listHandle(buildRequest(`stock-destinations?organizationId=${w.org.id}`, { method: "GET", cookie: w.operator.cookie }))
    );
    const view = list.destinations.find((x) => x.id === d.id)!;
    expect(view.recorded.notes).toBe("entrega no bairro");
    expect(view.effective).toMatchObject({ notes: "entrega na escola do bairro", peopleServed: 12, deliveredOn: daysAgo(1) });
    expect(view.events).toHaveLength(1);
  });

  it("recusas: sem alteração (422), data futura, retroativa por operador (403), retroativa por administrador sem justificativa (422) e com justificativa (200)", async () => {
    const w = await world();
    const d = await dest(w, 5, { notes: "entrega no bairro" });
    const same = await correct(w, d.id, { notes: "entrega no bairro" });
    expect(same.status).toBe(422);
    expect(await code(same)).toBe("sem_alteracao");
    expect((await correct(w, d.id, { deliveredOn: daysAgo(-3) })).status).toBe(422);
    const retro = await correct(w, d.id, { deliveredOn: daysAgo(10), lateRegistrationReason: "Entrega ocorreu há mais de uma semana" });
    expect(retro.status).toBe(403);
    expect((await correct(w, d.id, { deliveredOn: daysAgo(10) }, w.admin)).status).toBe(422);
    expect((await correct(w, d.id, { deliveredOn: daysAgo(10), lateRegistrationReason: "Entrega ocorreu há mais de uma semana" }, w.admin)).status).toBe(200);
    const [ev] = await events(d.id, "correction");
    expect(ev.authorizedByUserId).toBe(w.admin.userId);
    expect(ev.lateRegistrationReason).toContain("Entrega ocorreu");
  });

  it("campos que afetam o atendimento NÃO são corrigíveis por esta rota (400) e finalidade sem pessoas atendidas recusa pessoas", async () => {
    const w = await world();
    const d = await dest(w, 5);
    for (const extra of [{ quantity: 1 }, { needId: 1 }, { destinationType: "perda" }, { unit: "caixa" }, { isCountable: false }]) {
      expect((await correct(w, d.id, { notes: "novo texto de observação", ...extra })).status, JSON.stringify(extra)).toBe(400);
    }
    const loss = await dest(w, 2, { destinationType: "uso_operacional_instituicao", needId: null, notes: "Uso na cozinha da instituição" });
    const r = await correct(w, loss.id, { peopleServed: 4, peopleUnit: "pessoas" });
    expect(r.status).toBe(422);
    expect(await code(r)).toBe("campo_nao_aplicavel");
    const short = await correct(w, loss.id, { notes: "curto" });
    expect(short.status).toBe(422);
    expect(await code(short)).toBe("notas_obrigatorias");
    expect(await getNeedAttendance(db, w.needId)).toMatchObject({ appliedNet: 5 });
  });

  it("quem registrou corrige a própria destinação; outro operador não (403); administrador corrige qualquer uma", async () => {
    const w = await world();
    const d = await dest(w, 5, { notes: "entrega no bairro" }, w.operator);
    expect((await correct(w, d.id, { notes: "feita por outro" }, w.operator2)).status).toBe(403);
    expect((await correct(w, d.id, { notes: "entrega na praça do bairro" }, w.operator)).status).toBe(200);
    expect((await correct(w, d.id, { notes: "entrega na praça central" }, w.admin)).status).toBe(200);
    expect(await events(d.id, "correction")).toHaveLength(2);
  });

  it("correções sucessivas: a mais recente de cada campo vence na visão efetiva (função pura)", () => {
    const base = { deliveredOn: "2026-10-01", peopleServed: null, peopleUnit: null, notes: "a" };
    const out = overlayCorrections(base, [
      { id: "3", deliveredOn: null, peopleServed: null, peopleUnit: null, notes: "c" },
      { id: "2", deliveredOn: "2026-10-05", peopleServed: 4, peopleUnit: "pessoas", notes: "b" },
    ]);
    expect(out).toEqual({ deliveredOn: "2026-10-05", peopleServed: 4, peopleUnit: "pessoas", notes: "c" });
    expect(base.notes).toBe("a");
  });
});

describe("D. permissões e isolamento", () => {
  it("só proprietário/administrador reverte; operador e voluntário recebem 403 e nada muda", async () => {
    const w = await world();
    const d = await dest(w, 5);
    for (const u of [w.operator, w.volunteer]) expect((await reverse(w, d.id, "estorno_documental", 5, {}, u)).status).toBe(403);
    expect(await events(d.id)).toHaveLength(0);
    expect((await reverse(w, d.id, "estorno_documental", 5, {}, w.owner)).status).toBe(200);
  });

  it("destinação de OUTRA organização: 404 (reversão e correção) e a lista não a mostra; ator de outra org não tem acesso (403)", async () => {
    const a = await world();
    const b = await world();
    const d = await dest(a, 5);
    expect((await reverse(b, d.id, "estorno_documental", 5, {}, b.admin)).status).toBe(404);
    expect((await correct(b, d.id, { notes: "tentativa cruzada" }, b.owner)).status).toBe(404);
    expect((await reverseHandle(post("stock-destination-reversal", b.admin.cookie, { organizationId: a.org.id, destinationId: d.id, kind: "estorno_documental", quantity: 5, reason: "Tentativa cruzada", idempotencyKey: key() }))).status).toBe(403);
    const list = await parseJson<{ destinations: unknown[] }>(await listHandle(buildRequest(`stock-destinations?organizationId=${b.org.id}`, { method: "GET", cookie: b.owner.cookie })));
    expect(list.destinations).toHaveLength(0);
    expect(await events(d.id)).toHaveLength(0);
  });

  it("leitura: operador vê (canReverse=false), administrador vê (canReverse=true), voluntário não (403)", async () => {
    const w = await world();
    await dest(w, 5);
    const get = (u: Auth) => listHandle(buildRequest(`stock-destinations?organizationId=${w.org.id}`, { method: "GET", cookie: u.cookie }));
    expect((await parseJson<{ canReverse: boolean; destinations: unknown[] }>(await get(w.operator)))).toMatchObject({ canReverse: false });
    expect((await parseJson<{ canReverse: boolean }>(await get(w.admin))).canReverse).toBe(true);
    expect((await get(w.volunteer)).status).toBe(403);
  });

  it("a quantidade aplicada não é manipulável: campos extras do navegador são ignorados e o atendimento vem só do servidor", async () => {
    const w = await world();
    const d = await dest(w, 10);
    const res = await reverse(w, d.id, "estorno_documental", 4, { appliedQuantity: 0, attendedAfter: 999, needId: 123, reopened: false });
    expect(res.status).toBe(200);
    expect(await getNeedAttendance(db, w.needId)).toMatchObject({ appliedNet: 6 });
    expect((await events(d.id, "reversal"))[0].needId).toBeNull();
  });
});

describe("E. idempotência e concorrência", () => {
  it("repetir a MESMA chave não duplica a entrada física nem a reversão; chave com conteúdo diferente é 409", async () => {
    const w = await world();
    const d = await dest(w, 10);
    const k = key();
    const r1 = await reverse(w, d.id, "devolucao_fisica", 4, { idempotencyKey: k });
    const r2 = await reverse(w, d.id, "devolucao_fisica", 4, { idempotencyKey: k });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect((await parseJson<{ replayed: boolean }>(r2)).replayed).toBe(true);
    expect(await events(d.id, "reversal")).toHaveLength(1);
    expect(await movements(w, "entrada")).toHaveLength(2); // saldo inicial + UMA devolução
    const other = await reverse(w, d.id, "devolucao_fisica", 5, { idempotencyKey: k });
    expect(other.status).toBe(409);
    expect(await code(other)).toBe("chave_reutilizada");
    const kind = await reverse(w, d.id, "estorno_documental", 4, { idempotencyKey: k });
    expect(await code(kind)).toBe("chave_reutilizada");
    const corr = await correct(w, d.id, { notes: "outra operação com a mesma chave" }, w.admin);
    void corr;
    const c1 = await correct(w, d.id, { notes: "nota da correção" }, w.admin);
    expect(c1.status).toBe(200);
  });

  it("quatro requisições simultâneas com a mesma chave produzem UM evento e UMA entrada", async () => {
    const w = await world();
    const d = await dest(w, 10);
    const k = key();
    const rs = await Promise.all(Array.from({ length: 4 }, (_, i) => reverse(w, d.id, "devolucao_fisica", 10, { idempotencyKey: k }, i % 2 ? w.admin : w.owner)));
    for (const r of rs) expect(r.status).toBe(200);
    expect(await events(d.id, "reversal")).toHaveLength(1);
    expect(await movements(w, "entrada")).toHaveLength(2);
  });

  it("seis devoluções simultâneas de 5 sobre uma destinação de 10: exatamente duas vencem, o restante é 409, o estoque volta 10 e nada passa do reversível", async () => {
    const w = await world({ needQuantity: 100 });
    const d = await dest(w, 10);
    const before = await balance(w);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => reverse(w, d.id, "devolucao_fisica", 5, {}, i % 2 ? w.admin : w.owner)));
    for (const r of rs) expect(r.status).toBeLessThan(500);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(2);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await balance(w)).toBe(before + 10);
    const sum = (await events(d.id, "reversal")).reduce((s, e) => s + Number(e.quantity), 0);
    expect(sum).toBe(10);
  });

  it("reversão × nova destinação da mesma necessidade, simultâneas: sem 5xx e o atendimento nunca passa do solicitado", async () => {
    for (let round = 0; round < 4; round++) {
      const w = await world({ needQuantity: 10 });
      const d = await dest(w, 10);
      const [rv, nd] = await Promise.all([reverse(w, d.id, "estorno_documental", 10), dest(w, 10)]);
      expect(rv.status).toBe(200);
      expect(nd.status).toBeLessThan(500);
      const a = await getNeedAttendance(db, w.needId);
      expect(a.appliedNet).toBeLessThanOrEqual(10);
      const st = (await needRow(w)).status;
      expect(st === "atendida" ? a.appliedNet === 10 : a.appliedNet < 10).toBe(true); // estado coerente com o atendimento recalculado
      expect((await movements(w, "saida")).length).toBe((await db.selectFrom("stockDestinations").select("id").where("organizationId", "=", w.org.id).where("entryType", "=", "original").execute()).length);
    }
  });
});

describe("F. atomicidade (falhas injetadas)", () => {
  async function install(table: "audit_log" | "stock_destinations", condition: string) {
    await sql.raw(`CREATE OR REPLACE FUNCTION test_fail_insert() RETURNS trigger AS $f$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'falha injetada'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`).execute(db);
    await sql.raw(`CREATE TRIGGER test_fail_insert_trg BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION test_fail_insert()`).execute(db);
  }
  async function remove(table: "audit_log" | "stock_destinations") {
    await sql.raw(`DROP TRIGGER IF EXISTS test_fail_insert_trg ON ${table}`).execute(db);
    await sql.raw("DROP FUNCTION IF EXISTS test_fail_insert()").execute(db);
  }

  it("falha na AUDITORIA desfaz entrada, reversão, pedido idempotente e a reabertura da necessidade; depois a mesma chave funciona", async () => {
    const w = await world();
    const d = await dest(w, 40);
    const k = key();
    const before = { stock: await balance(w), tx: (await db.selectFrom("stockTransactions").select("id").execute()).length };
    await install("audit_log", "NEW.action = 'destinacao.revertida'");
    try {
      expect((await reverse(w, d.id, "devolucao_fisica", 40, { idempotencyKey: k })).status).toBeGreaterThanOrEqual(500);
    } finally {
      await remove("audit_log");
    }
    expect(await balance(w)).toBe(before.stock);
    expect((await db.selectFrom("stockTransactions").select("id").execute()).length).toBe(before.tx);
    expect(await events(d.id)).toHaveLength(0);
    expect((await needRow(w)).status).toBe("atendida");
    expect(await db.selectFrom("destinationCorrectionRequests").select("id").execute()).toHaveLength(0);
    expect((await reverse(w, d.id, "devolucao_fisica", 40, { idempotencyKey: k })).status).toBe(200);
    expect((await needRow(w)).status).toBe("aberta");
  });

  it("falha ao gravar a REVERSÃO desfaz a entrada física que já tinha sido criada", async () => {
    const w = await world();
    const d = await dest(w, 10);
    const before = await balance(w);
    await install("stock_destinations", "NEW.entry_type = 'reversal'");
    try {
      expect((await reverse(w, d.id, "devolucao_fisica", 10)).status).toBeGreaterThanOrEqual(500);
    } finally {
      await remove("stock_destinations");
    }
    expect(await balance(w)).toBe(before);
    expect(await movements(w, "entrada")).toHaveLength(1);
    expect((await needRow(w)).status).not.toBe("cancelada");
  });

  it("falha na auditoria da correção documental desfaz o evento", async () => {
    const w = await world();
    const d = await dest(w, 5);
    await install("audit_log", "NEW.action = 'destinacao.corrigida'");
    try {
      expect((await correct(w, d.id, { notes: "nota que será desfeita" })).status).toBeGreaterThanOrEqual(500);
    } finally {
      await remove("audit_log");
    }
    expect(await events(d.id)).toHaveLength(0);
    expect(await db.selectFrom("destinationCorrectionRequests").select("id").execute()).toHaveLength(0);
  });
});

describe("G. garantias do banco (independentes da aplicação)", () => {
  it("o banco recusa reversão acima da original, movimento de tipo errado, evento sem motivo e alteração/remoção de eventos", async () => {
    const w = await world();
    const d = await dest(w, 10);
    const base = { organizationId: w.org.id, entryType: "reversal", itemId: w.item.id, quantity: "6", unit: "kg", reversesDestinationId: d.id, reversalKind: "estorno_documental", reason: "Motivo válido", createdByUserId: w.owner.userId };
    await expect(db.insertInto("stockDestinations").values({ ...base, quantity: "11" } as never).execute()).rejects.toThrow(/excede|soma/i);
    await expect(db.insertInto("stockDestinations").values({ ...base, reason: "abc" } as never).execute()).rejects.toThrow();
    const [saida] = await db.insertInto("stockTransactions").values({ organizationId: w.org.id, itemId: w.item.id, type: "saida", delta: "-6", createdByUserId: w.owner.userId } as never).returning("id").execute();
    await expect(db.insertInto("stockDestinations").values({ ...base, reversalKind: "devolucao_fisica", stockTransactionId: saida.id } as never).execute()).rejects.toThrow(/ENTRADA|entrada/);
    await expect(db.insertInto("stockDestinations").values({ ...base, reversalKind: "estorno_documental", stockTransactionId: saida.id } as never).execute()).rejects.toThrow();
    await db.insertInto("stockDestinations").values(base as never).execute();
    await expect(db.insertInto("stockDestinations").values({ ...base, quantity: "5" } as never).execute()).rejects.toThrow(/excede|soma/i); // 6 + 5 > 10
    const [ev] = await events(d.id, "reversal");
    await expect(db.updateTable("stockDestinations").set({ reason: "alterado depois" }).where("id", "=", ev.id).execute()).rejects.toThrow();
    await expect(db.deleteFrom("stockDestinations").where("id", "=", ev.id).execute()).rejects.toThrow();
  });

  it("uma correção não pode trazer campos contábeis (necessidade, quantidade, finalidade) nem apontar para outro evento", async () => {
    const w = await world();
    const d = await dest(w, 10);
    const base = { organizationId: w.org.id, entryType: "correction", itemId: w.item.id, reversesDestinationId: d.id, reason: "Motivo válido", notes: "novo", createdByUserId: w.owner.userId };
    await expect(db.insertInto("stockDestinations").values({ ...base, quantity: "3" } as never).execute()).rejects.toThrow();
    await expect(db.insertInto("stockDestinations").values({ ...base, needId: w.needId } as never).execute()).rejects.toThrow();
    await expect(db.insertInto("stockDestinations").values({ ...base, destinationType: "perda" } as never).execute()).rejects.toThrow();
    await db.insertInto("stockDestinations").values(base as never).execute();
    const [c] = await events(d.id, "correction");
    await expect(db.insertInto("stockDestinations").values({ ...base, reversesDestinationId: c.id } as never).execute()).rejects.toThrow(/ORIGINAL/);
  });

  it("destination_correction_requests: chave única por organização, evento único e imutável", async () => {
    const w = await world();
    const d = await dest(w, 10);
    const k = key();
    await reverse(w, d.id, "estorno_documental", 2, { idempotencyKey: k });
    const [row] = await db.selectFrom("destinationCorrectionRequests").selectAll().execute();
    await expect(db.insertInto("destinationCorrectionRequests").values({ organizationId: w.org.id, idempotencyKey: k, payloadHash: "x", stockDestinationId: d.id, eventDestinationId: row.eventDestinationId, requestedByUserId: w.owner.userId } as never).execute()).rejects.toThrow();
    await expect(db.updateTable("destinationCorrectionRequests").set({ payloadHash: "y" }).where("id", "=", row.id).execute()).rejects.toThrow();
    await expect(db.deleteFrom("destinationCorrectionRequests").where("id", "=", row.id).execute()).rejects.toThrow();
  });
});
