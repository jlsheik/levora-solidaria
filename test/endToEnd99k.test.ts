/**
 * Fase 99K — validação de PONTA A PONTA do ciclo de destinação (PostgreSQL real, banco `_test`, armazenamento local descartável). Cada jornada percorre os endpoints REAIS na ordem do
 * produto (sem inserir registros artificiais para "avançar" etapas) e, depois de cada passo, um ORÁCULO calcula os mesmos números por SQL independente e os compara com a API de necessidades,
 * o histórico de destinações (99I), o relatório de impacto (99H) e o saldo do estoque. Matriz de rastreabilidade: docs/DESTINACAO_VALIDACAO_99K.md.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { businessDateOf } from "../src/helpers/businessDate";
import { runMatchingForOpportunity } from "../src/helpers/opportunityMatching";
import { buildImpactReport } from "../src/helpers/impactReport";
import { storageAdapter } from "../src/helpers/storageAdapter";
import { handle as stockTx } from "../src/endpoints/stock-transactions_POST";
import { handle as decideAlloc } from "../src/endpoints/allocations-decide_POST";
import { handle as logistics } from "../src/endpoints/allocations-logistics_POST";
import { handle as receiveAlloc } from "../src/endpoints/allocations-receive_POST";
import { handle as postOpportunity } from "../src/endpoints/opportunities_POST";
import { handle as receiveLocal } from "../src/endpoints/opportunities-receive_POST";
import { handle as destPost } from "../src/endpoints/stock-destinations_POST";
import { handle as destList } from "../src/endpoints/stock-destinations_GET";
import { handle as reversePost } from "../src/endpoints/stock-destination-reversal_POST";
import { handle as correctPost } from "../src/endpoints/stock-destination-correction_POST";
import { handle as proofPost } from "../src/endpoints/stock-destination-proof_POST";
import { handle as uploadPost } from "../src/endpoints/files-upload_POST";
import { handle as downloadGet } from "../src/endpoints/files-download_GET";
import { handle as reconGet } from "../src/endpoints/destination-proofs-reconciliation_GET";
import { handle as needsGet } from "../src/endpoints/needs_GET";
import { handle as decideApproval } from "../src/endpoints/approval-requests-decide_POST";
import { handle as closurePost } from "../src/endpoints/need-closure_POST";
import { addMembership, buildRequest, createAuthenticatedUser, createTestOrganization, createTestSource, createTestOpportunityRegistry, createTestInventoryItem, parseJson } from "./helpers";
import type { OutputType as NeedsOut } from "../src/endpoints/needs_GET.schema";
import type { OutputType as ListOut } from "../src/endpoints/stock-destinations_GET.schema";

type Auth = Awaited<ReturnType<typeof createAuthenticatedUser>>;
const TEST_STORAGE_DIR = path.resolve(process.cwd(), process.env.STORAGE_LOCAL_DIR || "storage/uploads-test");
afterAll(async () => rm(TEST_STORAGE_DIR, { recursive: true, force: true }));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const post = (p: string, cookie: string, body: unknown) => buildRequest(p, { method: "POST", cookie, body });
const get = (p: string, cookie: string) => buildRequest(p, { method: "GET", cookie });
const key = () => `k-${randomBytes(8).toString("hex")}`;
const today = () => businessDateOf(new Date());
const round = (n: number) => Math.round(n * 1000) / 1000;

interface World { owner: Auth; admin: Auth; operator: Auth; operator2: Auth; volunteer: Auth; orgId: number; itemId: number; needId: number }

/** Organização completa para o matching (BH/MG, Alimentos em kg, coleta) + item em kg + necessidade de `needQty` kg vinculada ao item. */
async function world(needQty = 100, openingStock = 1000): Promise<World> {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId, { city: "Belo Horizonte", state: "MG" });
  const admin = await createAuthenticatedUser();
  await addMembership(org.id, admin.userId, "administrador");
  const operator = await createAuthenticatedUser();
  await addMembership(org.id, operator.userId, "operador");
  const operator2 = await createAuthenticatedUser();
  await addMembership(org.id, operator2.userId, "operador");
  const volunteer = await createAuthenticatedUser();
  await addMembership(org.id, volunteer.userId, "voluntario");
  const item = await createTestInventoryItem(org.id, owner.userId, { name: "Arroz", unit: "kg" });
  const [need] = await db
    .insertInto("needs")
    .values({ organizationId: org.id, itemId: item.id, title: "Alimentos não perecíveis para doação", quantityNeeded: String(needQty), unit: "kg", priority: "critica", createdByUserId: owner.userId })
    .returning("id")
    .execute();
  await db.insertInto("organizationCapacities").values({ organizationId: org.id, category: "Alimentos", unit: "kg", maxCapacity: "999999", createdByUserId: owner.userId }).execute();
  await db.insertInto("organizationMatchingSettings").values({ organizationId: org.id, realizaColeta: true }).execute();
  await db.insertInto("organizationServiceAreas").values({ organizationId: org.id, city: "Belo Horizonte", state: "MG" }).execute();
  if (openingStock > 0) {
    const r = await stockTx(post("stock-transactions", owner.cookie, { organizationId: org.id, itemId: item.id, type: "entrada", quantity: openingStock, reason: "estoque inicial" }));
    expect(r.status).toBe(200);
  }
  return { owner, admin, operator, operator2, volunteer, orgId: org.id, itemId: item.id, needId: need.id };
}

const dest = async (w: World, quantity: number, over: Record<string, unknown> = {}, user: Auth = w.operator) => {
  const res = await destPost(post("stock-destinations", user.cookie, { organizationId: w.orgId, itemId: w.itemId, quantity, destinationType: "distribuicao_familias", needId: w.needId, deliveredOn: today(), idempotencyKey: key(), ...over }));
  const out = res.status === 200 ? await parseJson<{ destination: { id: string } }>(res) : null;
  return { status: res.status, id: out?.destination.id as string, res };
};
const reverse = (w: World, id: string, kind: string, quantity: number, over: Record<string, unknown> = {}, user: Auth = w.admin) =>
  reversePost(post("stock-destination-reversal", user.cookie, { organizationId: w.orgId, destinationId: id, kind, quantity, reason: "Registro feito por engano", idempotencyKey: key(), ...over }));
const upload = async (w: World, user: Auth = w.operator) => {
  const res = await uploadPost(post("files-upload", user.cookie, { organizationId: w.orgId, purpose: "comprovante_destinacao", fileName: "recibo.png", contentType: "image/png", fileBase64: PNG }));
  return { status: res.status, id: res.status === 200 ? (await parseJson<{ file: { id: number } }>(res)).file.id : (0 as number) };
};
const proof = (w: World, id: string, action: "anexar" | "remover", fileId: number, user: Auth = w.admin, over: Record<string, unknown> = {}) =>
  proofPost(post("stock-destination-proof", user.cookie, { organizationId: w.orgId, destinationId: id, action, fileId, reason: "Comprovante da entrega", idempotencyKey: key(), ...over }));
const dl = (fileId: number, user: Auth) => downloadGet(get(`files-download?fileId=${fileId}`, user.cookie));
const status = async (w: World) => (await db.selectFrom("needs").select("status").where("id", "=", w.needId).executeTakeFirstOrThrow()).status;
const window = () => ({ startDate: new Date(Date.now() - 2 * 86400000), endDate: new Date(Date.now() + 86400000) });

/**
 * ORÁCULO: o mesmo número, por 5 caminhos independentes. `appliedSql` é SQL puro sobre as tabelas; os demais passam pela API/relatório.
 */
async function oracle(w: World) {
  const applied = await sql<{ a: string; p: string }>`
    SELECT coalesce(sum(LEAST(coalesce(d.applied_quantity, d.quantity), d.quantity - coalesce(r.q, 0))) FILTER (WHERE d.is_countable), 0) AS a,
           coalesce(sum(d.quantity - coalesce(r.q, 0)), 0) AS p
      FROM stock_destinations d
      LEFT JOIN (SELECT reverses_destination_id AS id, sum(quantity) AS q FROM stock_destinations WHERE entry_type = 'reversal' GROUP BY 1) r ON r.id = d.id
     WHERE d.organization_id = ${w.orgId} AND d.need_id = ${w.needId} AND d.entry_type = 'original'`.execute(db);
  const appliedSql = round(Number(applied.rows[0].a));
  const physicalSql = round(Number(applied.rows[0].p));
  const needsApi = (await parseJson<NeedsOut>(await needsGet(get(`needs?organizationId=${w.orgId}`, w.owner.cookie)))).needs.find((n) => n.id === w.needId)!;
  const hist = await parseJson<ListOut>(await destList(get(`stock-destinations?organizationId=${w.orgId}&needId=${w.needId}`, w.admin.cookie)));
  const histApplied = round(hist.totals.byUnit.filter((t) => t.unit === "kg").reduce((s, t) => s + t.appliedNet, 0));
  const report = await buildImpactReport(db, { organizationId: w.orgId, ...window(), needId: w.needId } as never);
  const reportApplied = round(report.destination.byPurpose.filter((p) => p.unit === "kg").reduce((s, p) => s + p.appliedNet, 0));
  const reportNeed = report.needs.rows.find((n) => n.id === w.needId);
  const full = await buildImpactReport(db, { organizationId: w.orgId, ...window() } as never);
  const ledger = round(Number((await sql<{ t: string }>`SELECT coalesce(sum(delta), 0) AS t FROM stock_transactions WHERE item_id = ${w.itemId}`.execute(db)).rows[0].t));
  expect(needsApi.attendance.attended, "needs_GET.attendance").toBe(appliedSql);
  expect(histApplied, "histórico (totais)").toBe(appliedSql);
  expect(reportApplied, "relatório (bloco destino)").toBe(appliedSql);
  if (reportNeed) expect(reportNeed.attendance.attended, "relatório (necessidades)").toBe(appliedSql);
  expect(round(hist.totals.byUnit.reduce((s, t) => s + t.physicalNet, 0)), "físico líquido").toBe(physicalSql);
  const m = full.itemMovements.find((x) => x.itemId === w.itemId);
  if (m) expect(m.balanceAtEnd, "saldo do relatório").toBe(ledger);
  for (const r of full.reconciliation) expect(r.balanced && r.exitsBalanced, `conciliação do item ${r.itemName}`).toBe(true);
  expect(ledger).toBeGreaterThanOrEqual(0);
  expect(appliedSql).toBeLessThanOrEqual(Number(needsApi.quantityNeeded));
  return { appliedSql, physicalSql, ledger, needsApi, report: full };
}

describe("Jornada A — oferta da rede → matching → decisão → logística → recebimento → destinação → relatório → comprovante", () => {
  it("percorre os endpoints reais e cada etapa é visível na seguinte, com o oráculo fechando em todas", async () => {
    const w = await world(100, 1000);
    const platform = await createAuthenticatedUser();
    const source = await createTestSource(platform.userId);
    const opp = await createTestOpportunityRegistry(source.id, platform.userId, { title: "Doação de alimentos não perecíveis", status: "aguardando_destinacao" });
    await db.updateTable("opportunityRegistry").set({ category: "Alimentos", unit: "kg", quantity: "100", locationCity: "Belo Horizonte", locationState: "MG" }).where("id", "=", opp.id).execute();
    await oracle(w);

    // 1–2) matching real cria a atribuição para a necessidade
    const run = await runMatchingForOpportunity(opp.id, platform.userId);
    expect(run.allocationsCreated.length).toBe(1);
    const alloc = await db.selectFrom("opportunityAllocations").select(["id", "status", "needId", "organizationId"]).where("opportunityRegistryId", "=", opp.id).executeTakeFirstOrThrow();
    expect(alloc.organizationId).toBe(w.orgId);
    // a necessidade da atribuição automática vem da avaliação do matching (allocation.need_id é só das manuais)
    expect((await db.selectFrom("matchEvaluations").select("needId").where("allocationId", "=", alloc.id).executeTakeFirstOrThrow()).needId).toBe(w.needId);

    // 3) decisão, 4) logística, 5–6) recebimento: entrada física + suprimento da rede
    if (alloc.status === "proposta") expect((await decideAlloc(post("allocations-decide", w.owner.cookie, { organizationId: w.orgId, allocationId: alloc.id, decision: "aceita" }))).status).toBe(200);
    expect((await logistics(post("allocations-logistics", w.owner.cookie, { organizationId: w.orgId, allocationId: alloc.id, eventType: "coleta_agendada" }))).status).toBe(200);
    const stockBefore = (await oracle(w)).ledger;
    const rec = await receiveAlloc(post("allocations-receive", w.owner.cookie, { organizationId: w.orgId, allocationId: alloc.id, itemId: w.itemId, quantityReceived: 100 }));
    expect(rec.status).toBe(200);
    const after = await oracle(w);
    expect(after.ledger).toBe(stockBefore + 100); // 7) saldo atualizado
    const fulfilled = await db.selectFrom("needFulfillments").select(["entryType", "quantity", "isCountable"]).where("needId", "=", w.needId).execute();
    expect(fulfilled).toHaveLength(1);
    expect(Number(fulfilled[0].quantity)).toBe(100);
    expect(after.needsApi.fulfilled).toBe(100); // suprimento da rede
    expect(after.needsApi.attendance.attended).toBe(0); // ainda NADA foi destinado: recebido ≠ atendido
    expect(await status(w)).toBe("aberta");

    // 8–10) destinação parcial e total: atendimento SOMENTE das destinações; o ledger da rede não é tocado nem somado
    const d1 = await dest(w, 40, { peopleServed: 12, peopleUnit: "familias" });
    expect(d1.status).toBe(200);
    let o = await oracle(w);
    expect(o.appliedSql).toBe(40);
    expect(o.needsApi.fulfilled).toBe(100);
    expect(o.needsApi.attendance.state).toBe("parcial");
    expect(await status(w)).toBe("aberta");
    const d2 = await dest(w, 60);
    expect(d2.status).toBe(200);
    o = await oracle(w);
    expect(o.appliedSql).toBe(100);
    expect(await status(w)).toBe("atendida");
    expect((await db.selectFrom("needFulfillments").select("id").where("needId", "=", w.needId).execute())).toHaveLength(1); // ledger intacto
    expect(o.ledger).toBe(stockBefore + 100 - 100);

    // 11) relatório: bloco destinação, indicadores, pessoas declaradas, sem alerta de status incoerente
    const rep = o.report;
    const fam = rep.destination.byPurpose.find((p) => p.destinationType === "distribuicao_familias")!;
    expect(fam).toMatchObject({ unit: "kg", physical: 100, physicalNet: 100, appliedNet: 100, surplusNet: 0 });
    expect(fam.declaredPeople).toEqual({ pessoas: 0, familias: 12 });
    expect(rep.needs.rows.find((n) => n.id === w.needId)).toMatchObject({ statusWarning: false, historicalAttended: false });
    expect(rep.destination.proofs).toEqual({ withProof: 0, withoutProof: 2 });

    // 12–13) comprovante: envio, vínculo, download autorizado; relatório conta a referência vigente
    const up = await upload(w, w.operator);
    expect(up.status).toBe(200);
    expect((await proof(w, d1.id, "anexar", up.id, w.operator)).status).toBe(200);
    expect((await dl(up.id, w.operator2)).status).toBe(200);
    expect((await dl(up.id, w.volunteer)).status).toBe(403);
    const o2 = await oracle(w);
    expect(o2.appliedSql).toBe(100); // comprovante não altera atendimento
    expect(o2.ledger).toBe(o.ledger);
    expect(o2.report.destination.proofs).toEqual({ withProof: 1, withoutProof: 1 });
    expect(o2.report.destination.correctedRecords).toBe(0); // evento de comprovante ≠ correção documental

    // 14) a remoção da referência não apaga o objeto; contagem acompanha a referência vigente
    expect((await proof(w, d1.id, "remover", up.id, w.admin, { reason: "Arquivo errado" })).status).toBe(200);
    expect((await oracle(w)).report.destination.proofs).toEqual({ withProof: 0, withoutProof: 2 });
    expect(await db.selectFrom("files").select("id").where("id", "=", up.id).executeTakeFirst()).toBeDefined();
  });
});

describe("Jornada A2 — doação local → recebimento → destinação → relatório", () => {
  it("doação local gera entrada física uma vez, não cria ledger da rede e o atendimento vem só da destinação", async () => {
    const w = await world(50, 0);
    const created = await postOpportunity(post("opportunities", w.owner.cookie, { organizationId: w.orgId, title: "Cestas da padaria vizinha", donorName: "Padaria Vizinha", quantityOffered: 50, unit: "kg", linkedNeedId: w.needId }));
    expect(created.status).toBe(200);
    const opportunityId = (await parseJson<{ opportunity: { id: number } }>(created)).opportunity.id;
    const rec = await receiveLocal(post("opportunities-receive", w.owner.cookie, { organizationId: w.orgId, opportunityId, itemId: w.itemId, quantityReceived: 50 }));
    if (rec.status !== 200) throw new Error("recebimento local: " + rec.status + " " + (await rec.text()));
    let o = await oracle(w);
    expect(o.ledger).toBe(50);
    expect(await db.selectFrom("needFulfillments").select("id").where("needId", "=", w.needId).execute()).toHaveLength(0); // doação local não entra no ledger da rede
    expect(o.needsApi.attendance.attended).toBe(0);
    expect((await dest(w, 10)).status).toBe(200); // 20% do saldo: abaixo do limiar de segunda aprovação
    o = await oracle(w);
    expect(o.appliedSql).toBe(10);
    expect(o.ledger).toBe(40);
    // reenvio do recebimento da MESMA doação não duplica a entrada
    const again = await receiveLocal(post("opportunities-receive", w.owner.cookie, { organizationId: w.orgId, opportunityId, itemId: w.itemId, quantityReceived: 50 }));
    expect([200, 409, 422]).toContain(again.status);
    expect((await oracle(w)).ledger).toBe(40);
  });
});

describe("Jornada B — atendimento parcial, total, excedente, unidade, encerramento e matching", () => {
  it("parcial → matching vê só o que falta → completo → matching não vê → reversão reabre → matching volta a ver", async () => {
    const w = await world(100, 1000);
    const platform = await createAuthenticatedUser();
    const source = await createTestSource(platform.userId);
    const mkOpp = async (qty: number) => {
      const o = await createTestOpportunityRegistry(source.id, platform.userId, { title: "Doação de alimentos não perecíveis", status: "aguardando_destinacao" });
      await db.updateTable("opportunityRegistry").set({ category: "Alimentos", unit: "kg", quantity: String(qty), locationCity: "Belo Horizonte", locationState: "MG" }).where("id", "=", o.id).execute();
      return o.id;
    };
    const evalOf = (oppId: number) => db.selectFrom("matchEvaluations").select(["criteria"]).where("opportunityRegistryId", "=", oppId).where("organizationId", "=", w.orgId).executeTakeFirst();
    const d1 = await dest(w, 40);
    await oracle(w);
    const o1 = await mkOpp(60);
    await runMatchingForOpportunity(o1, platform.userId);
    const e1 = await evalOf(o1);
    expect(JSON.stringify(e1?.criteria)).toContain("restante 60"); // saldo remanescente real, não 100
    const d2 = await dest(w, 60);
    expect(d2.status).toBe(200);
    expect(await status(w)).toBe("atendida");
    const o2 = await mkOpp(60);
    await runMatchingForOpportunity(o2, platform.userId);
    expect(await evalOf(o2)).toBeUndefined(); // necessidade atendida não é candidata
    expect((await reverse(w, d2.id, "estorno_documental", 30)).status).toBe(200);
    expect(await status(w)).toBe("aberta");
    const o3 = await mkOpp(30);
    await runMatchingForOpportunity(o3, platform.userId);
    expect(JSON.stringify((await evalOf(o3))?.criteria)).toContain("restante 30");
    await oracle(w);
    expect(d1.status).toBe(200);
  });

  it("exceder sem autorização é recusado sem efeito; excedente autorizado não infla o atendimento; unidade incompatível não conta", async () => {
    const w = await world(10, 1000);
    const blocked = await dest(w, 15);
    expect(blocked.status).toBe(409);
    expect((await oracle(w)).physicalSql).toBe(0);
    expect((await dest(w, 15, { authorizeSurplus: true, surplusReason: "Embalagens fechadas de 5 kg" }, w.operator)).status).toBe(403);
    const ok = await dest(w, 15, { authorizeSurplus: true, surplusReason: "Embalagens fechadas de 5 kg" }, w.admin);
    expect(ok.status).toBe(200);
    const o = await oracle(w);
    expect(o).toMatchObject({ appliedSql: 10, physicalSql: 15 });
    expect(o.report.destination.byPurpose[0].surplusNet).toBe(5);
    // necessidade em outra unidade: físico registrado, atendimento 0, nada convertido
    const [other] = await db.insertInto("needs").values({ organizationId: w.orgId, title: "Caixas", quantityNeeded: "10", unit: "caixas", priority: "alta", createdByUserId: w.owner.userId }).returning("id").execute();
    const inc = await destPost(post("stock-destinations", w.admin.cookie, { organizationId: w.orgId, itemId: w.itemId, quantity: 3, destinationType: "distribuicao_familias", needId: other.id, deliveredOn: today(), idempotencyKey: key() }));
    expect(inc.status).toBe(200);
    const row = (await buildImpactReport(db, { organizationId: w.orgId, ...window(), needId: other.id } as never)).needs.rows.find((n) => n.id === other.id)!;
    expect(row.attendance).toMatchObject({ attended: 0, unitIncompatibleDestined: 3 });
  });

  it("cancelada preserva entregas parciais e NÃO reabre por reversão; reabertura é explícita; atendida histórica não é inventada nem reaberta", async () => {
    const w = await world(100, 1000);
    const d = await dest(w, 30);
    expect((await closurePost(post("need-closure", w.admin.cookie, { action: "encerrar", organizationId: w.orgId, needId: w.needId, reasonCode: "recursos_insuficientes", reasonText: "Sem mais estoque" }))).status).toBe(200);
    expect((await oracle(w)).appliedSql).toBe(30); // entrega parcial preservada
    expect((await reverse(w, d.id, "estorno_documental", 30)).status).toBe(200);
    expect(await status(w)).toBe("cancelada"); // reversão não reabre cancelada
    expect((await oracle(w)).appliedSql).toBe(0);
    expect((await closurePost(post("need-closure", w.admin.cookie, { action: "reabrir", organizationId: w.orgId, needId: w.needId, reasonText: "Nova doação prevista" }))).status).toBe(200);
    expect(await status(w)).toBe("aberta");

    const hist = await world(10, 100);
    await db.updateTable("needs").set({ status: "atendida" }).where("id", "=", hist.needId).execute(); // registro anterior ao controle
    const o = await oracle(hist);
    expect(o.needsApi.attendance.state).toBe("atendida_historica");
    expect(await db.selectFrom("stockDestinations").select("id").where("organizationId", "=", hist.orgId).execute()).toHaveLength(0);
    expect(o.report.needs.rows.find((n) => n.id === hist.needId)?.historicalAttended ?? true).toBe(true);
  });
});

describe("Jornada C — correções, estornos, devoluções e concorrência", () => {
  it("cada operação tem o efeito físico/documental correto e o oráculo fecha após cada uma", async () => {
    const w = await world(100, 1000);
    const d = await dest(w, 50, { peopleServed: 10, peopleUnit: "pessoas", notes: "entrega no bairro" });
    let o = await oracle(w);
    const base = o.ledger;
    const txCount = async () => (await db.selectFrom("stockTransactions").select("id").where("itemId", "=", w.itemId).execute()).length;
    const n0 = await txCount();
    // correção documental: sem movimento e sem efeito no atendimento; campos proibidos recusados
    expect((await correctPost(post("stock-destination-correction", w.admin.cookie, { organizationId: w.orgId, destinationId: d.id, notes: "entrega na escola", peopleServed: 14, peopleUnit: "pessoas", reason: "Dados corrigidos", idempotencyKey: key() }))).status).toBe(200);
    expect((await correctPost(post("stock-destination-correction", w.admin.cookie, { organizationId: w.orgId, destinationId: d.id, quantity: 1, reason: "Tentativa proibida", idempotencyKey: key() }))).status).toBe(400);
    expect(await txCount()).toBe(n0);
    o = await oracle(w);
    expect(o).toMatchObject({ appliedSql: 50, ledger: base });
    // estorno documental: SEM entrada fictícia
    expect((await reverse(w, d.id, "estorno_documental", 5)).status).toBe(200);
    expect(await txCount()).toBe(n0);
    o = await oracle(w);
    expect(o).toMatchObject({ appliedSql: 45, ledger: base });
    // devolução física parcial e total do restante reversível; correção de quantidade
    expect((await reverse(w, d.id, "devolucao_fisica", 10)).status).toBe(200);
    o = await oracle(w);
    expect(o).toMatchObject({ appliedSql: 35, ledger: base + 10 });
    expect((await reverse(w, d.id, "correcao_quantidade", 5)).status).toBe(200);
    expect((await oracle(w)).ledger).toBe(base + 15);
    const over = await reverse(w, d.id, "devolucao_fisica", 31);
    expect(over.status).toBe(409);
    expect((await reverse(w, d.id, "devolucao_fisica", 30)).status).toBe(200);
    o = await oracle(w);
    expect(o).toMatchObject({ appliedSql: 0, ledger: base + 45 });
    expect((await reverse(w, d.id, "devolucao_fisica", 1)).status).toBe(409);
    // o histórico preserva TUDO (append-only) e a original nunca mudou
    const events = await db.selectFrom("stockDestinations").select(["entryType", "reversalKind"]).where("reversesDestinationId", "=", d.id).orderBy("id").execute();
    expect(events.map((e) => e.reversalKind ?? e.entryType)).toEqual(["correction", "estorno_documental", "devolucao_fisica", "correcao_quantidade", "devolucao_fisica"]);
    const [orig] = await db.selectFrom("stockDestinations").select(["quantity", "appliedQuantity"]).where("id", "=", d.id).execute();
    expect(Number(orig.quantity)).toBe(50);
  });

  it("data efetiva: a aba e o relatório interpretam a correção de data do mesmo jeito", async () => {
    const w = await world(100, 1000);
    const d = await dest(w, 20);
    const day = businessDateOf(new Date(Date.now() - 2 * 86400000));
    expect((await correctPost(post("stock-destination-correction", w.admin.cookie, { organizationId: w.orgId, destinationId: d.id, deliveredOn: day, reason: "Data corrigida", idempotencyKey: key() }))).status).toBe(200);
    const listed = (await parseJson<ListOut>(await destList(get(`stock-destinations?organizationId=${w.orgId}&basis=efetiva&from=${day}&to=${day}`, w.admin.cookie)))).totals.records;
    const rep = await buildImpactReport(db, { organizationId: w.orgId, startDate: new Date(`${day}T03:00:00Z`), endDate: new Date(new Date(`${day}T03:00:00Z`).getTime() + 86400000), destinationDateBasis: "efetiva" } as never);
    expect([listed, rep.destination.records]).toEqual([1, 1]);
    const byReg = (await parseJson<ListOut>(await destList(get(`stock-destinations?organizationId=${w.orgId}&basis=registro&from=${day}&to=${day}`, w.admin.cookie)))).totals.records;
    expect(byReg).toBe(0); // o filtro de registro continua usando a data de registro original
  });

  it("concorrência: destinações no mesmo item, atendimento disputado e saldo reversível disputado", async () => {
    const w = await world(10, 1000);
    // 8 destinações simultâneas de 5 kg para um item de 1000 kg (sem risco): todas entram, o saldo é exato
    const free = await Promise.all(Array.from({ length: 8 }, () => dest(w, 5, { needId: null, destinationType: "uso_operacional_instituicao", notes: "Uso na cozinha da instituição" })));
    expect(free.every((r) => r.status === 200)).toBe(true);
    expect((await oracle(w)).ledger).toBe(960);
    // 4 tentativas simultâneas de completar a MESMA necessidade (faltam 10): exatamente uma vence
    const race = await Promise.all(Array.from({ length: 4 }, (_, i) => dest(w, 10, {}, i % 2 ? w.admin : w.operator)));
    expect(race.filter((r) => r.status === 200)).toHaveLength(1);
    expect(race.every((r) => r.status < 500)).toBe(true);
    const o = await oracle(w);
    expect(o.appliedSql).toBe(10);
    expect(await status(w)).toBe("atendida");
    const winner = race.find((r) => r.status === 200)!;
    // saldo reversível de 10 disputado por 4 pedidos de 5 (2 devoluções físicas + 2 correções): exatamente 2 vencem
    const rs = await Promise.all([reverse(w, winner.id, "devolucao_fisica", 5), reverse(w, winner.id, "devolucao_fisica", 5), reverse(w, winner.id, "correcao_quantidade", 5), reverse(w, winner.id, "estorno_documental", 5)]);
    expect(rs.every((r) => r.status < 500)).toBe(true);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(2);
    const sumRev = Number((await sql<{ t: string }>`SELECT coalesce(sum(quantity), 0) AS t FROM stock_destinations WHERE reverses_destination_id = ${winner.id} AND entry_type = 'reversal'`.execute(db)).rows[0].t);
    expect(sumRev).toBe(10);
    await oracle(w);
    expect(await status(w)).toBe("aberta"); // atendimento caiu a zero: reaberta na mesma transação
  });

  it("atomicidade: falha de auditoria desfaz entrada física, reversão e reabertura; a mesma chave funciona depois", async () => {
    const w = await world(10, 1000);
    const d = await dest(w, 10);
    expect(await status(w)).toBe("atendida");
    const before = await oracle(w);
    const k = key();
    await sql.raw(`CREATE OR REPLACE FUNCTION test_fail_audit() RETURNS trigger AS $f$ BEGIN IF NEW.action = 'destinacao.revertida' THEN RAISE EXCEPTION 'falha injetada'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`).execute(db);
    await sql.raw(`CREATE TRIGGER test_fail_audit_trg BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_fail_audit()`).execute(db);
    try {
      expect((await reverse(w, d.id, "devolucao_fisica", 10, { idempotencyKey: k })).status).toBeGreaterThanOrEqual(500);
    } finally {
      await sql.raw("DROP TRIGGER IF EXISTS test_fail_audit_trg ON audit_log").execute(db);
      await sql.raw("DROP FUNCTION IF EXISTS test_fail_audit()").execute(db);
    }
    const mid = await oracle(w);
    expect([mid.ledger, mid.appliedSql, await status(w)]).toEqual([before.ledger, before.appliedSql, "atendida"]);
    expect((await reverse(w, d.id, "devolucao_fisica", 10, { idempotencyKey: k })).status).toBe(200);
    expect(await status(w)).toBe("aberta");
    await oracle(w);
  });
});

describe("Jornada E — comprovantes: armazenamento, falhas, concorrência e reconciliação somente leitura", () => {
  it("falha do armazenamento no envio não deixa registro; objeto ausente no download não vaza caminho; arquivo removido não volta; vínculo duplicado e concorrência", async () => {
    const w = await world(100, 1000);
    const d = await dest(w, 20);
    const filesBefore = (await db.selectFrom("files").select("id").execute()).length;
    const spy = vi.spyOn(storageAdapter, "upload").mockRejectedValueOnce(new Error("armazenamento indisponível"));
    const failed = await uploadPost(post("files-upload", w.operator.cookie, { organizationId: w.orgId, purpose: "comprovante_destinacao", fileName: "x.png", contentType: "image/png", fileBase64: PNG }));
    spy.mockRestore();
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect((await db.selectFrom("files").select("id").execute()).length).toBe(filesBefore);

    const up = await upload(w);
    expect((await proof(w, d.id, "anexar", up.id, w.operator)).status).toBe(200);
    // objeto sumiu do armazenamento: erro controlado, sem caminho/chave na resposta
    const row = await db.selectFrom("files").select(["storageKey"]).where("id", "=", up.id).executeTakeFirstOrThrow();
    await storageAdapter.delete(row.storageKey);
    const lost = await dl(up.id, w.operator);
    expect(lost.status).not.toBe(200);
    expect(await lost.text()).not.toContain(row.storageKey);
    // removido não volta; arquivo vinculado não vincula a outra destinação
    expect((await proof(w, d.id, "remover", up.id, w.admin)).status).toBe(200);
    expect((await proof(w, d.id, "anexar", up.id, w.admin)).status).toBe(409);
    const d2 = await dest(w, 5);
    expect((await proof(w, d2.id, "anexar", up.id, w.admin)).status).toBe(409);
    // duas requisições idempotentes (mesma chave) e duas disputando o mesmo arquivo
    const fresh = await upload(w);
    const k = key();
    const same = await Promise.all([proof(w, d2.id, "anexar", fresh.id, w.admin, { idempotencyKey: k }), proof(w, d2.id, "anexar", fresh.id, w.admin, { idempotencyKey: k })]);
    expect(same.map((r) => r.status)).toEqual([200, 200]);
    expect((await db.selectFrom("stockDestinations").select("id").where("proofFileId", "=", fresh.id).execute())).toHaveLength(1);
    // remover × remover simultâneos
    const rr = await Promise.all([proof(w, d2.id, "remover", fresh.id, w.admin), proof(w, d2.id, "remover", fresh.id, w.owner)]);
    expect(rr.filter((r) => r.status === 200)).toHaveLength(1);
    await oracle(w);
  });

  it("reconciliação: lista pendentes e removidos sem alterar nada; só proprietário/administrador; isolada por organização", async () => {
    const a = await world(100, 1000);
    const b = await world(100, 1000);
    const d = await dest(a, 10);
    const pending = await upload(a);
    const removed = await upload(a);
    await proof(a, d.id, "anexar", removed.id, a.admin);
    await proof(a, d.id, "remover", removed.id, a.admin);
    const linked = await upload(a);
    const d2 = await dest(a, 5);
    await proof(a, d2.id, "anexar", linked.id, a.admin);
    await upload(b);
    const snapshot = async () => [(await db.selectFrom("files").select("id").execute()).length, (await db.selectFrom("stockDestinations").select("id").execute()).length, (await db.selectFrom("auditLog").select("id").execute()).length];
    const before = await snapshot();
    const res = await reconGet(get(`destination-proofs-reconciliation?organizationId=${a.orgId}`, a.admin.cookie));
    expect(res.status).toBe(200);
    const body = await parseJson<{ pendentes: Array<{ id: number }>; removidos: Array<{ id: number }> }>(res);
    expect(body.pendentes.map((p) => p.id)).toEqual([pending.id]);
    expect(body.removidos.map((p) => p.id)).toEqual([removed.id]);
    expect(JSON.stringify(body)).not.toMatch(/storageKey|storage_key/);
    expect(await snapshot()).toEqual(before); // somente leitura
    expect((await reconGet(get(`destination-proofs-reconciliation?organizationId=${a.orgId}`, a.operator.cookie))).status).toBe(403);
    expect((await reconGet(get(`destination-proofs-reconciliation?organizationId=${a.orgId}`, b.owner.cookie))).status).toBe(403);
    expect((await parseJson<{ pendentes: unknown[] }>(await reconGet(get(`destination-proofs-reconciliation?organizationId=${b.orgId}`, b.owner.cookie)))).pendentes).toHaveLength(1);
  });
});

describe("Isolamento entre organizações no ciclo inteiro", () => {
  it("nada de uma organização aparece em histórico, relatório, necessidades ou comprovantes de outra", async () => {
    const a = await world(100, 1000);
    const b = await world(100, 1000);
    const d = await dest(a, 25);
    const up = await upload(a);
    await proof(a, d.id, "anexar", up.id, a.admin);
    await dest(b, 7);
    const ob = await oracle(b);
    expect(ob.physicalSql).toBe(7);
    expect((await parseJson<ListOut>(await destList(get(`stock-destinations?organizationId=${b.orgId}`, b.owner.cookie)))).destinations.map((x) => x.id)).not.toContain(d.id);
    expect((await dl(up.id, b.owner)).status).toBe(403);
    expect((await reverse(b, d.id, "estorno_documental", 5, {}, b.owner)).status).toBe(404);
    expect((await oracle(a)).physicalSql).toBe(25);
  });
});

describe("Jornada G — segunda aprovação de risco integrada ao atendimento e à unidade desconhecida", () => {
  it("saída de alto risco fica pendente (nada baixa), a aprovação executa saída + destinação + atendimento numa só transação e o oráculo fecha", async () => {
    const w = await world(100, 100);
    const pending = await destPost(post("stock-destinations", w.operator.cookie, { organizationId: w.orgId, itemId: w.itemId, quantity: 40, destinationType: "distribuicao_familias", needId: w.needId, deliveredOn: today(), idempotencyKey: key() }));
    expect(pending.status).toBe(202);
    const approvalId = (await parseJson<{ approvalRequestId: number }>(pending)).approvalRequestId;
    let o = await oracle(w);
    expect([o.ledger, o.appliedSql]).toEqual([100, 0]); // nada baixou nem atendeu antes da aprovação
    expect((await decideApproval(post("approval-requests-decide", w.operator.cookie, { organizationId: w.orgId, requestId: approvalId, decision: "aprovada" }))).status).toBe(403);
    expect((await decideApproval(post("approval-requests-decide", w.admin.cookie, { organizationId: w.orgId, requestId: approvalId, decision: "aprovada" }))).status).toBe(200);
    o = await oracle(w);
    expect([o.ledger, o.appliedSql]).toEqual([60, 40]);
    expect((await decideApproval(post("approval-requests-decide", w.owner.cookie, { organizationId: w.orgId, requestId: approvalId, decision: "aprovada" }))).status).toBeGreaterThanOrEqual(400); // não decide duas vezes
    expect((await oracle(w)).ledger).toBe(60);
  });

  it("item com unidade fora do vocabulário não recebe destinação (nenhuma conversão por suposição)", async () => {
    const w = await world(10, 0);
    const odd = await createTestInventoryItem(w.orgId, w.owner.userId, { name: "Coisa", unit: "pacotão" });
    await db.insertInto("stockTransactions").values({ organizationId: w.orgId, itemId: odd.id, type: "entrada", delta: "100", createdByUserId: w.owner.userId }).execute();
    const r = await destPost(post("stock-destinations", w.admin.cookie, { organizationId: w.orgId, itemId: odd.id, quantity: 1, destinationType: "perda", notes: "Perda por validade vencida", deliveredOn: today(), idempotencyKey: key() }));
    expect(r.status).toBe(422);
    expect((await db.selectFrom("stockDestinations").select("id").where("itemId", "=", odd.id).execute())).toHaveLength(0);
  });
});

describe("Matriz de permissões do ciclo (servidor)", () => {
  it("cada papel só faz o que a especificação permite, em todas as rotas do ciclo", async () => {
    const w = await world(100, 1000);
    const d = await dest(w, 10, {}, w.operator);
    const up = await upload(w, w.operator);
    const status = async (r: Promise<Response> | Response) => (await r).status;
    const rows: Array<[string, number, number, number, number]> = []; // [rota, proprietário, administrador, operador, voluntário]
    const roles = [w.owner, w.admin, w.operator, w.volunteer];
    const probe = async (name: string, call: (u: Auth) => Promise<Response>) => rows.push([name, ...(await Promise.all(roles.map((u) => status(call(u))))).map((s) => s) as [number, number, number, number]]);
    await probe("listar destinações", (u) => destList(get(`stock-destinations?organizationId=${w.orgId}`, u.cookie)));
    await probe("registrar destinação", (u) => destPost(post("stock-destinations", u.cookie, { organizationId: w.orgId, itemId: w.itemId, quantity: 1, destinationType: "distribuicao_familias", needId: w.needId, deliveredOn: today(), idempotencyKey: key() })));
    await probe("reverter", (u) => reverse(w, d.id, "estorno_documental", 1, {}, u));
    await probe("conciliação de comprovantes", (u) => reconGet(get(`destination-proofs-reconciliation?organizationId=${w.orgId}`, u.cookie)));
    await probe("enviar comprovante", (u) => uploadPost(post("files-upload", u.cookie, { organizationId: w.orgId, purpose: "comprovante_destinacao", fileName: "r.png", contentType: "image/png", fileBase64: PNG })));
    await probe("baixar comprovante pendente (de outro autor)", (u) => dl(up.id, u));
    const ok = (s: number) => s >= 200 && s < 300;
    const by = Object.fromEntries(rows.map((r) => [r[0], r.slice(1).map((s) => (ok(s as number) ? "ok" : String(s)))]));
    expect(by["listar destinações"]).toEqual(["ok", "ok", "ok", "403"]);
    expect(by["registrar destinação"].slice(0, 3)).toEqual(["ok", "ok", "ok"]);
    expect(by["registrar destinação"][3]).toBe("403");
    expect(by["reverter"]).toEqual(["ok", "ok", "403", "403"]);
    expect(by["conciliação de comprovantes"]).toEqual(["ok", "ok", "403", "403"]);
    expect(by["enviar comprovante"]).toEqual(["ok", "ok", "ok", "403"]);
    expect(by["baixar comprovante pendente (de outro autor)"]).toEqual(["ok", "ok", "ok", "403"]); // operador = autor; voluntário sem inventario.lance
  });
});
