/**
 * Fase 99I — histórico de destinações com filtros (PostgreSQL real, banco `_test`): período por data de registro (calendário de Brasília, limites inclusivos, conversão no banco) e por data
 * efetiva (com correções), finalidade, situação, item, paginação estável, totais por unidade coerentes com o relatório da 99H, validação, permissões e isolamento.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { businessDateOf } from "../src/helpers/businessDate";
import { buildImpactReport } from "../src/helpers/impactReport";
import { validateDateRange } from "../src/helpers/destinationFilters";
import { handle as listHandle } from "../src/endpoints/stock-destinations_GET";
import { handle as destHandle } from "../src/endpoints/stock-destinations_POST";
import { handle as reverseHandle } from "../src/endpoints/stock-destination-reversal_POST";
import { handle as correctHandle } from "../src/endpoints/stock-destination-correction_POST";
import { addMembership, buildRequest, createAuthenticatedUser, createTestInventoryItem, createTestOrganization, parseJson } from "./helpers";
import type { OutputType } from "../src/endpoints/stock-destinations_GET.schema";

type Auth = Awaited<ReturnType<typeof createAuthenticatedUser>>;
const post = (p: string, cookie: string, body: unknown) => buildRequest(p, { method: "POST", cookie, body });
const key = () => `k-${randomBytes(8).toString("hex")}`;
const today = () => businessDateOf(new Date());

async function world() {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const admin = await createAuthenticatedUser();
  await addMembership(org.id, admin.userId, "administrador");
  const operator = await createAuthenticatedUser();
  await addMembership(org.id, operator.userId, "operador");
  const volunteer = await createAuthenticatedUser();
  await addMembership(org.id, volunteer.userId, "voluntario");
  const rice = await createTestInventoryItem(org.id, owner.userId, { name: "Arroz", unit: "kg" });
  const milk = await createTestInventoryItem(org.id, owner.userId, { name: "Leite", unit: "unidade" });
  for (const it of [rice, milk]) await db.insertInto("stockTransactions").values({ organizationId: org.id, itemId: it.id, type: "entrada", delta: "10000", reason: "saldo inicial", createdByUserId: owner.userId }).execute();
  return { owner, admin, operator, volunteer, org, rice, milk };
}
type W = Awaited<ReturnType<typeof world>>;

/** Insere uma destinação original com `created_at` e `delivered_on` controlados (o endpoint sempre usa agora). */
async function seed(w: W, o: { itemId?: number; unit?: string; qty?: number; type?: string; createdAt: string; deliveredOn: string }) {
  const itemId = o.itemId ?? w.rice.id;
  const qty = o.qty ?? 5;
  const [tx] = await db.insertInto("stockTransactions").values({ organizationId: w.org.id, itemId, type: "saida", delta: String(-qty), reason: "seed", createdByUserId: w.owner.userId } as never).returning("id").execute();
  const [d] = await db
    .insertInto("stockDestinations")
    .values({ organizationId: w.org.id, entryType: "original", itemId, stockTransactionId: tx.id, destinationType: o.type ?? "distribuicao_familias", quantity: String(qty), unit: o.unit ?? (itemId === w.milk.id ? "unidade" : "kg"), isCountable: false, notes: "Registro de teste com motivo", deliveredOn: o.deliveredOn, createdAt: new Date(o.createdAt), createdByUserId: w.owner.userId } as never)
    .returning("id")
    .execute();
  return String(d.id);
}
const list = async (w: W, qs: string, user: Auth = w.operator) => {
  const res = await listHandle(buildRequest(`stock-destinations?organizationId=${w.org.id}${qs}`, { method: "GET", cookie: user.cookie }));
  return { status: res.status, body: res.status === 200 ? await parseJson<OutputType>(res) : await parseJson<{ message: string }>(res) };
};
const ids = (r: { body: unknown }) => (r.body as OutputType).destinations.map((d) => d.id);

describe("A. período por data de REGISTRO (calendário de Brasília, limites inclusivos)", () => {
  it("00:00:00 BRT entra; 23:59:59 BRT do dia anterior e 00:00:00 BRT do dia seguinte ficam de fora", async () => {
    const w = await world();
    const before = await seed(w, { createdAt: "2026-03-10T02:59:59Z", deliveredOn: "2026-03-09" }); // 23:59:59 BRT de 09/03
    const first = await seed(w, { createdAt: "2026-03-10T03:00:00Z", deliveredOn: "2026-03-10" }); // 00:00:00 BRT de 10/03
    const last = await seed(w, { createdAt: "2026-03-11T02:59:59Z", deliveredOn: "2026-03-10" }); // 23:59:59 BRT de 10/03
    const next = await seed(w, { createdAt: "2026-03-11T03:00:00Z", deliveredOn: "2026-03-11" }); // 00:00:00 BRT de 11/03
    const r = await list(w, "&from=2026-03-10&to=2026-03-10");
    expect(r.status).toBe(200);
    expect(ids(r).sort()).toEqual([first, last].sort());
    expect(ids(r)).not.toContain(before);
    expect(ids(r)).not.toContain(next);
    expect((await list(w, "&from=2026-03-10")).body).toMatchObject({ filters: { basis: "registro", from: "2026-03-10", to: null } });
    expect(ids(await list(w, "&from=2026-03-10")).sort()).toEqual([first, last, next].sort());
    expect(ids(await list(w, "&to=2026-03-09"))).toEqual([before]);
  });

  it("evento registrado DEPOIS da data efetiva: a base escolhida decide, e cada resposta diz qual usou", async () => {
    const w = await world();
    const late = await seed(w, { createdAt: "2026-03-20T15:00:00Z", deliveredOn: "2026-03-12" });
    expect(ids(await list(w, "&from=2026-03-20&to=2026-03-20&basis=registro"))).toEqual([late]);
    expect(ids(await list(w, "&from=2026-03-20&to=2026-03-20&basis=efetiva"))).toEqual([]);
    expect(ids(await list(w, "&from=2026-03-12&to=2026-03-12&basis=efetiva"))).toEqual([late]);
    expect(ids(await list(w, "&from=2026-03-12&to=2026-03-12&basis=registro"))).toEqual([]);
    expect(((await list(w, "&basis=efetiva")).body as OutputType).filters.basis).toBe("efetiva");
  });

  it("data efetiva usa a CORREÇÃO documental mais recente; a original permanece intacta", async () => {
    const w = await world();
    const res = await destHandle(post("stock-destinations", w.admin.cookie, { organizationId: w.org.id, itemId: w.rice.id, quantity: 5, destinationType: "distribuicao_familias", deliveredOn: today(), idempotencyKey: key() }));
    const id = (await parseJson<{ destination: { id: string } }>(res)).destination.id;
    const d = new Date(Date.now() - 2 * 86400000);
    const twoDaysAgo = businessDateOf(d);
    expect((await correctHandle(post("stock-destination-correction", w.admin.cookie, { organizationId: w.org.id, destinationId: id, deliveredOn: twoDaysAgo, reason: "Data corrigida", idempotencyKey: key() }))).status).toBe(200);
    expect(ids(await list(w, `&basis=efetiva&from=${twoDaysAgo}&to=${twoDaysAgo}`))).toEqual([id]);
    expect(ids(await list(w, `&basis=efetiva&from=${today()}&to=${today()}`))).toEqual([]);
    const row = await sql<{ d: string }>`SELECT delivered_on::text AS d FROM stock_destinations WHERE id = ${id}`.execute(db);
    expect(row.rows[0].d).toBe(today()); // a original não mudou
  });
});

describe("A2. coerência 99H–99I da data efetiva com várias correções", () => {
  it("listagem e relatório usam a MESMA data efetiva (a correção mais recente vence), inclusive com mais de uma correção", async () => {
    const w = await world();
    const res = await destHandle(post("stock-destinations", w.admin.cookie, { organizationId: w.org.id, itemId: w.rice.id, quantity: 5, destinationType: "distribuicao_familias", deliveredOn: today(), idempotencyKey: key() }));
    const id = (await parseJson<{ destination: { id: string } }>(res)).destination.id;
    const day = (n: number) => businessDateOf(new Date(Date.now() - n * 86400000));
    for (const n of [3, 1]) expect((await correctHandle(post("stock-destination-correction", w.admin.cookie, { organizationId: w.org.id, destinationId: id, deliveredOn: day(n), reason: "Data corrigida", idempotencyKey: key() }))).status).toBe(200);
    const win = (d: string) => ({ startDate: new Date(d + "T03:00:00Z"), endDate: new Date(new Date(d + "T03:00:00Z").getTime() + 86400000) });
    for (const [d, expected] of [[day(3), 0], [day(1), 1], [today(), 0]] as const) {
      const listed = ((await list(w, "&basis=efetiva&from=" + d + "&to=" + d)).body as OutputType).totals.records;
      const reported = (await buildImpactReport(db, { organizationId: w.org.id, ...win(d), destinationDateBasis: "efetiva" } as never)).destination.records;
      expect([listed, reported]).toEqual([expected, expected]);
    }
  });
});

describe("B. finalidade, situação, item e combinações", () => {
  it("filtra por finalidade, por item e combina filtros; vazio devolve lista vazia com totais vazios", async () => {
    const w = await world();
    const a = await seed(w, { createdAt: "2026-04-01T15:00:00Z", deliveredOn: "2026-04-01", type: "distribuicao_familias" });
    const b = await seed(w, { createdAt: "2026-04-01T16:00:00Z", deliveredOn: "2026-04-01", type: "perda", itemId: w.milk.id });
    expect(ids(await list(w, "&destinationType=perda"))).toEqual([b]);
    expect(ids(await list(w, `&itemId=${w.rice.id}`))).toEqual([a]);
    expect(ids(await list(w, `&itemId=${w.milk.id}&destinationType=distribuicao_familias`))).toEqual([]);
    const empty = await list(w, "&destinationType=descarte");
    expect(empty.body).toMatchObject({ destinations: [], hasMore: false, totals: { records: 0, byUnit: [] } });
  });

  it("situação: ativa, parcialmente revertida, revertida e com correção (calculadas no servidor)", async () => {
    const w = await world();
    const mk = async (qty: number) => (await parseJson<{ destination: { id: string } }>(await destHandle(post("stock-destinations", w.admin.cookie, { organizationId: w.org.id, itemId: w.rice.id, quantity: qty, destinationType: "distribuicao_familias", deliveredOn: today(), idempotencyKey: key() })))).destination.id;
    const active = await mk(1);
    const partial = await mk(2);
    const full = await mk(3);
    const corrected = await mk(4);
    const rev = (id: string, q: number) => reverseHandle(post("stock-destination-reversal", w.admin.cookie, { organizationId: w.org.id, destinationId: id, kind: "estorno_documental", quantity: q, reason: "Registro por engano", idempotencyKey: key() }));
    await rev(partial, 1);
    await rev(full, 3);
    await correctHandle(post("stock-destination-correction", w.admin.cookie, { organizationId: w.org.id, destinationId: corrected, notes: "observação corrigida", reason: "Texto corrigido", idempotencyKey: key() }));
    expect(ids(await list(w, "&state=ativa")).sort()).toEqual([active, corrected].sort());
    expect(ids(await list(w, "&state=parcialmente_revertida"))).toEqual([partial]);
    expect(ids(await list(w, "&state=revertida"))).toEqual([full]);
    expect(ids(await list(w, "&state=com_correcao"))).toEqual([corrected]);
  });
});

describe("C0. filtro por necessidade", () => {
  it("needId restringe a lista e os totais ao conjunto da necessidade; combina com outros filtros; necessidade de outra organização não revela nada", async () => {
    const w = await world();
    const other = await world();
    const mkNeed = async (x: W, title: string) => (await db.insertInto("needs").values({ organizationId: x.org.id, itemId: x.rice.id, title, quantityNeeded: "100", unit: "kg", priority: "alta", createdByUserId: x.owner.userId }).returning("id").execute())[0].id;
    const n1 = await mkNeed(w, "A");
    const n2 = await mkNeed(w, "B");
    const foreign = await mkNeed(other, "X");
    const dest = async (needId: number, qty: number, type = "distribuicao_familias") => (await parseJson<{ destination: { id: string } }>(await destHandle(post("stock-destinations", w.admin.cookie, { organizationId: w.org.id, itemId: w.rice.id, quantity: qty, destinationType: type, needId, deliveredOn: today(), idempotencyKey: key() })))).destination.id;
    const a = await dest(n1, 4);
    const b = await dest(n2, 6);
    const c = await dest(n1, 3, "atendimento_coletivo");
    expect(ids(await list(w, `&needId=${n1}`)).sort()).toEqual([a, c].sort());
    expect((await list(w, `&needId=${n1}`)).body as OutputType).toMatchObject({ totals: { records: 2, byUnit: [{ unit: "kg", physical: 7, appliedNet: 7 }] } });
    expect(ids(await list(w, `&needId=${n2}`))).toEqual([b]);
    expect(ids(await list(w, `&needId=${n1}&destinationType=atendimento_coletivo`))).toEqual([c]);
    const crossed = await list(w, `&needId=${foreign}`);
    expect(ids(crossed)).toEqual([]);
    expect((crossed.body as OutputType).totals.records).toBe(0);
    expect((await list(w, "&needId=abc")).status).toBe(400);
  });
});

describe("C. paginação estável e totais", () => {
  it("keyset por id decrescente: percorrer todas as páginas não repete nem pula, com e sem filtro; hasMore correto", async () => {
    const w = await world();
    const created: string[] = [];
    for (let i = 0; i < 5; i++) created.push(await seed(w, { createdAt: `2026-05-0${i + 1}T15:00:00Z`, deliveredOn: `2026-05-0${i + 1}`, type: i % 2 ? "perda" : "distribuicao_familias" }));
    const walk = async (qs: string) => {
      const seen: string[] = [];
      let before = "";
      for (let guard = 0; guard < 10; guard++) {
        const r = await list(w, `${qs}&limit=2${before}`);
        const b = r.body as OutputType;
        seen.push(...b.destinations.map((d) => d.id));
        if (!b.hasMore) break;
        before = `&beforeId=${b.destinations[b.destinations.length - 1].id}`;
      }
      return seen;
    };
    const all = await walk("");
    expect(all).toEqual([...created].reverse());
    const filtered = await walk("&destinationType=perda");
    expect(filtered).toEqual([created[3], created[1]]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("totais cobrem TODO o conjunto filtrado (não só a página), por unidade, e batem com o relatório de impacto da 99H", async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) await seed(w, { createdAt: "2026-06-10T15:00:00Z", deliveredOn: "2026-06-10", qty: 4 });
    await seed(w, { createdAt: "2026-06-10T16:00:00Z", deliveredOn: "2026-06-10", qty: 7, itemId: w.milk.id });
    const r = await list(w, "&from=2026-06-10&to=2026-06-10&limit=1");
    const b = r.body as OutputType;
    expect(b.destinations).toHaveLength(1);
    expect(b.totals.records).toBe(4);
    expect(b.totals.byUnit.map((t) => [t.unit, t.physical, t.physicalNet])).toEqual([["kg", 12, 12], ["unidade", 7, 7]]); // unidades nunca somadas
    const report = await buildImpactReport(db, { organizationId: w.org.id, startDate: new Date("2026-06-10T03:00:00Z"), endDate: new Date("2026-06-11T03:00:00Z"), destinationDateBasis: "registro" } as never);
    for (const t of b.totals.byUnit) {
      const sum = (f: "physical" | "reverted" | "physicalNet" | "appliedNet" | "surplusNet") => Math.round(report.destination.byPurpose.filter((p) => p.unit === t.unit).reduce((s, p) => s + p[f], 0) * 1000) / 1000;
      expect([t.physical, t.reverted, t.physicalNet, t.appliedNet, t.surplusNet]).toEqual([sum("physical"), sum("reverted"), sum("physicalNet"), sum("appliedNet"), sum("surplusNet")]);
    }
    expect(report.destination.records).toBe(b.totals.records);
  });

  it("efetiva: listagem e relatório da 99H concordam (inclusive com correção de data)", async () => {
    const w = await world();
    await seed(w, { createdAt: "2026-07-20T15:00:00Z", deliveredOn: "2026-07-05" });
    const r = await list(w, "&basis=efetiva&from=2026-07-05&to=2026-07-05");
    const report = await buildImpactReport(db, { organizationId: w.org.id, startDate: new Date("2026-07-05T03:00:00Z"), endDate: new Date("2026-07-06T03:00:00Z"), destinationDateBasis: "efetiva" } as never);
    expect((r.body as OutputType).totals.records).toBe(1);
    expect(report.destination.records).toBe(1);
  });
});

describe("D. validação, permissão e isolamento", () => {
  it("intervalos e parâmetros inválidos são 400 com mensagem útil; nada vaza", async () => {
    const w = await world();
    await seed(w, { createdAt: "2026-03-10T15:00:00Z", deliveredOn: "2026-03-10" });
    for (const qs of ["&from=2026-03-12&to=2026-03-10", "&from=2026-02-30", "&from=ontem", "&from=2020-01-01&to=2026-12-31", "&destinationType=inventada", "&state=desconhecida", "&basis=outra", "&beforeId=abc", "&limit=0", "&limit=1000", "&itemId=-1"]) {
      const r = await list(w, qs);
      expect(r.status, qs).toBe(400);
    }
    expect(validateDateRange("2026-01-01", "2026-01-31")).toBeNull();
    expect(validateDateRange("2026-01-31", "2026-01-01")).toMatch(/anterior/);
  });

  it("voluntário não consulta (403); administrador e operador sim; canReverse só para quem pode", async () => {
    const w = await world();
    await seed(w, { createdAt: "2026-03-10T15:00:00Z", deliveredOn: "2026-03-10" });
    expect((await list(w, "", w.volunteer)).status).toBe(403);
    expect(((await list(w, "", w.operator)).body as OutputType).canReverse).toBe(false);
    expect(((await list(w, "", w.admin)).body as OutputType).canReverse).toBe(true);
  });

  it("outra organização: sem acesso (403) e IDs de item/necessidade/beforeId de fora não revelam nada", async () => {
    const a = await world();
    const b = await world();
    await seed(a, { createdAt: "2026-03-10T15:00:00Z", deliveredOn: "2026-03-10" });
    const mine = await seed(b, { createdAt: "2026-03-10T15:00:00Z", deliveredOn: "2026-03-10" });
    expect((await list(a, "", b.owner)).status).toBe(403);
    const crossItem = await list(b, `&itemId=${a.rice.id}`, b.owner);
    expect(ids(crossItem)).toEqual([]);
    expect((crossItem.body as OutputType).totals.records).toBe(0);
    expect(ids(await list(b, "", b.owner))).toEqual([mine]);
  });

  it("a consulta é só leitura: nenhuma tabela muda", async () => {
    const w = await world();
    await seed(w, { createdAt: "2026-03-10T15:00:00Z", deliveredOn: "2026-03-10" });
    const count = async () => [(await db.selectFrom("stockDestinations").select("id").execute()).length, (await db.selectFrom("stockTransactions").select("id").execute()).length, (await db.selectFrom("auditLog").select("id").execute()).length];
    const before = await count();
    await list(w, "&state=ativa&basis=efetiva&from=2026-03-01");
    expect(await count()).toEqual(before);
  });
});
