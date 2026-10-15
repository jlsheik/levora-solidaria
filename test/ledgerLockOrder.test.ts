/**
 * Fase 81 — revisão formal da ordem de locks do ledger físico.
 *
 * Ordem do ciclo encontrado na Fase 80 (e o mesmo desenho em needs-status):
 *   Fluxo A: need (lock forte) → item → ledger
 *   Fluxo B (recebimento): item (FOR UPDATE) → FK do ledger → needs (FOR KEY SHARE)
 * Com `needs FOR UPDATE` em A, A espera o item de B e B espera a need de A: 40P01.
 * `FOR NO KEY UPDATE` continua conflitando com qualquer UPDATE/outro NO KEY UPDATE da
 * need (é o nível que um UPDATE comum toma), mas NÃO conflita com FOR KEY SHARE.
 *
 * Postgres real; transações explícitas e deterministas (sem depender de sorte de timing).
 */
import { describe, it, expect } from "vitest";
import { sql } from "kysely";
import { db } from "../src/helpers/db";
import { handle as postCorrect } from "../src/endpoints/allocations-receipt-correct_POST";
import { handle as postReverse } from "../src/endpoints/allocations-receipt-reverse_POST";
import { handle as postReceive } from "../src/endpoints/allocations-receive_POST";
import { handle as postDecide } from "../src/endpoints/approval-requests-decide_POST";
import { handle as postNeedsStatus } from "../src/endpoints/needs-status_POST";
import { handle as getHistory } from "../src/endpoints/allocations-receipt-history_GET";
import { getItemStockBalance } from "../src/helpers/stockBalance";
import {
  createAuthenticatedUser,
  createTestOrganization,
  createTestSource,
  createTestOpportunityRegistry,
  createTestInventoryItem,
  addMembership,
  buildRequest,
  parseJson,
  type AuthenticatedTestUser,
} from "./helpers";
import type { OutputType as HistoryOutput } from "../src/endpoints/allocations-receipt-history_GET.schema";

interface Env {
  owner: AuthenticatedTestUser;
  operador: AuthenticatedTestUser;
  admin: AuthenticatedTestUser;
  orgId: number;
  itemId: number;
  needId: number;
}

async function setupEnv(needItemLinked = false): Promise<Env> {
  const owner = await createAuthenticatedUser();
  const org = await createTestOrganization(owner.userId);
  const operador = await createAuthenticatedUser();
  const admin = await createAuthenticatedUser();
  await addMembership(org.id, operador.userId, "operador");
  await addMembership(org.id, admin.userId, "administrador");
  const item = await createTestInventoryItem(org.id, owner.userId, { unit: "kg" });
  const [need] = await db
    .insertInto("needs")
    .values({ organizationId: org.id, title: "Cestas", quantityNeeded: "50", unit: "kg", priority: "media", status: "aberta", createdByUserId: owner.userId, itemId: needItemLinked ? item.id : null })
    .returning(["id"])
    .execute();
  return { owner, operador, admin, orgId: org.id, itemId: item.id, needId: need.id };
}

async function receive(e: Env, quantity = 100): Promise<number> {
  const platform = await createAuthenticatedUser();
  const source = await createTestSource(platform.userId);
  const opp = await createTestOpportunityRegistry(source.id, platform.userId, { unit: "kg", status: "reservada" });
  const [al] = await db
    .insertInto("opportunityAllocations")
    .values({ opportunityRegistryId: opp.id, organizationId: e.orgId, quantityAllocated: "100", status: "aceita", needId: e.needId })
    .returning(["id"])
    .execute();
  const res = await postReceive(
    buildRequest("allocations-receive", { method: "POST", cookie: e.owner.cookie, body: { organizationId: e.orgId, allocationId: al.id, itemId: e.itemId, quantityReceived: quantity } })
  );
  expect(res.status).toBe(200);
  return al.id;
}
const token = async (e: Env, allocationId: number) => {
  const res = await getHistory(buildRequest(`allocations-receipt-history?organizationId=${e.orgId}&allocationId=${allocationId}`, { cookie: e.owner.cookie }));
  return (await parseJson<HistoryOutput>(res)).vigenteFulfillmentId as string;
};
const correct = (e: Env, allocationId: number, user: AuthenticatedTestUser, body: Record<string, unknown>) =>
  postCorrect(buildRequest("allocations-receipt-correct", { method: "POST", cookie: user.cookie, body: { organizationId: e.orgId, allocationId, reason: "Conferência", ...body } }));
const reverse = (e: Env, allocationId: number, user: AuthenticatedTestUser, body: Record<string, unknown>) =>
  postReverse(buildRequest("allocations-receipt-reverse", { method: "POST", cookie: user.cookie, body: { organizationId: e.orgId, allocationId, reason: "Evento inválido", ...body } }));
const decide = (e: Env, user: AuthenticatedTestUser, requestId: number, decision: "aprovada" | "rejeitada" = "aprovada") =>
  postDecide(buildRequest("approval-requests-decide", { method: "POST", cookie: user.cookie, body: { organizationId: e.orgId, requestId, decision } }));
const pendingId = async (res: Response) => {
  expect(res.status).toBe(202);
  return (await parseJson<{ approvalRequestId: number }>(res)).approvalRequestId;
};
const stock = (itemId: number) => db.transaction().execute((trx) => getItemStockBalance(trx, itemId));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera até haver algum lock NÃO concedido (alguém bloqueado esperando). */
async function waitForBlockedBackend(timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await sql<{ n: string }>`SELECT count(*)::text AS n FROM pg_locks WHERE NOT granted`.execute(db);
    if (Number(r.rows[0].n) > 0) return true;
    await sleep(25);
  }
  return false;
}

type Outcome = { ok: true } | { ok: false; code: string | undefined };
const run = async (fn: () => Promise<void>): Promise<Outcome> => {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, code: (err as { code?: string }).code };
  }
};

describe("Fase 81 — o ciclo da Fase 80, reproduzido de forma determinística em SQL puro", () => {
  async function twoFlows(needLock: "update" | "no_key_update") {
    const e = await setupEnv();
    let aHasNeed!: () => void;
    const aGotNeed = new Promise<void>((r) => (aHasNeed = r));
    let bHasItem!: () => void;
    const bGotItem = new Promise<void>((r) => (bHasItem = r));

    // Fluxo A (correção/decisão física): need → item
    const flowA = run(() =>
      db.transaction().execute(async (trx) => {
        const q = trx.selectFrom("needs").select(["id"]).where("id", "=", e.needId);
        await (needLock === "update" ? q.forUpdate() : q.forNoKeyUpdate()).execute();
        aHasNeed();
        await bGotItem;
        await sleep(150); // B passa a esperar a need
        await trx.selectFrom("inventoryItems").select(["id"]).where("id", "=", e.itemId).forUpdate().execute();
      })
    );
    // Fluxo B (recebimento): item (FOR UPDATE) → FK do ledger → need (FOR KEY SHARE)
    const flowB = run(() =>
      db.transaction().execute(async (trx) => {
        await trx.selectFrom("inventoryItems").select(["id"]).where("id", "=", e.itemId).forUpdate().execute();
        bHasItem();
        await aGotNeed;
        await trx.selectFrom("needs").select(["id"]).where("id", "=", e.needId).forKeyShare().execute();
      })
    );
    return Promise.all([flowA, flowB]);
  }

  it("com FOR UPDATE na need ocorre o ciclo: exatamente um dos fluxos recebe 40P01 (deadlock detectado)", async () => {
    const outcomes = await twoFlows("update");
    const failures = outcomes.filter((o) => !o.ok);
    expect(failures).toHaveLength(1);
    expect((failures[0] as { code?: string }).code).toBe("40P01");
  }, 30000);

  it("com FOR NO KEY UPDATE na need NÃO há ciclo: os dois fluxos concluem, sem 40P01", async () => {
    const outcomes = await twoFlows("no_key_update");
    expect(outcomes).toEqual([{ ok: true }, { ok: true }]);
  }, 30000);

  it("a proteção necessária continua: NO KEY UPDATE conflita com outro NO KEY UPDATE, com FOR UPDATE e com um UPDATE comum da need — e só o FOR KEY SHARE (FK) passa", async () => {
    // um holder por tentativa (o pool do app é pequeno: nunca muitas conexões bloqueadas ao mesmo tempo)
    const attempts: Array<[string, (e: Env) => Promise<unknown>, boolean]> = [
      ["outro NO KEY UPDATE", (e) => db.transaction().execute((t) => t.selectFrom("needs").select(["id"]).where("id", "=", e.needId).forNoKeyUpdate().execute()), true],
      ["FOR UPDATE", (e) => db.transaction().execute((t) => t.selectFrom("needs").select(["id"]).where("id", "=", e.needId).forUpdate().execute()), true],
      ["UPDATE comum", (e) => db.updateTable("needs").set({ title: "Editada" }).where("id", "=", e.needId).execute(), true],
      ["FOR KEY SHARE (FK do ledger)", (e) => db.transaction().execute((t) => t.selectFrom("needs").select(["id"]).where("id", "=", e.needId).forKeyShare().execute()), false],
    ];
    for (const [name, attempt, mustBlock] of attempts) {
      const e = await setupEnv();
      let held!: () => void;
      const acquired = new Promise<void>((r) => (held = r));
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const holder = db.transaction().execute(async (trx) => {
        await trx.selectFrom("needs").select(["id"]).where("id", "=", e.needId).forNoKeyUpdate().execute();
        held();
        await released;
      });
      await acquired;
      let finished = false;
      const pending = attempt(e).then(() => (finished = true));
      try {
        await sleep(400);
        expect(finished, name).toBe(!mustBlock);
      } finally {
        release();
        await holder;
        await pending;
      }
    }
  }, 30000);
});

describe("Fase 81 — fluxos REAIS contra um recebimento 'no meio' (item travado; depois a FK pede a need)", () => {
  /**
   * `holder` imita o recebimento: trava o item e, QUANDO o fluxo real já estiver bloqueado esperando esse item
   * (com a need nas mãos), pede a need em KEY SHARE (o que a FK do ledger faz).
   */
  async function against(e: Env, runFlow: () => Promise<Response>) {
    let held!: () => void;
    const acquired = new Promise<void>((r) => (held = r));
    let holderOutcome!: Outcome;
    const holder = run(() =>
      db.transaction().execute(async (trx) => {
        await trx.selectFrom("inventoryItems").select(["id"]).where("id", "=", e.itemId).forUpdate().execute();
        held();
        await waitForBlockedBackend();
        await sleep(150);
        await trx.selectFrom("needs").select(["id"]).where("id", "=", e.needId).forKeyShare().execute();
      })
    ).then((o) => (holderOutcome = o));
    await acquired;
    const flow = runFlow();
    await holder;
    const res = await flow;
    return { status: res.status, holderOutcome };
  }

  it("decisão de correção física (need NO KEY UPDATE → item) não entra em deadlock com o recebimento", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const id = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await token(e, a), quantity: 80 }));
    const out = await against(e, () => decide(e, e.admin, id));
    expect(out.holderOutcome).toEqual({ ok: true });
    expect(out.status).toBe(200);
    expect(await stock(e.itemId)).toBe(80);
  }, 30000);

  it("correção direta física (+20) e estorno físico também não", async () => {
    const e = await setupEnv();
    const a = await receive(e);
    const direct = await against(e, () => correct(e, a, e.operador, { expectedVigenteFulfillmentId: "0", quantity: 120 }).then(async (r) => r));
    // a primeira chamada usa token inválido de propósito (409): só prova que o caminho não deadlocka; a real vem abaixo
    expect(direct.holderOutcome).toEqual({ ok: true });
    expect([200, 409]).toContain(direct.status);

    const t = await token(e, a);
    const out = await against(e, () => correct(e, a, e.operador, { expectedVigenteFulfillmentId: t, quantity: 130 }));
    expect(out.holderOutcome).toEqual({ ok: true });
    expect(out.status).toBe(200);
    expect(await stock(e.itemId)).toBe(130);

    const id = await pendingId(await reverse(e, a, e.operador, { expectedVigenteFulfillmentId: await token(e, a), withdrawStock: true }));
    const rev = await against(e, () => decide(e, e.admin, id));
    expect(rev.holderOutcome).toEqual({ ok: true });
    expect(rev.status).toBe(200);
    expect(await stock(e.itemId)).toBe(0);
  }, 40000);

  it("needs-status 'atendida' (need FOR UPDATE; desde a 99E sem baixa de estoque) contra o recebimento no meio: sem 40P01", async () => {
    const e = await setupEnv(true);
    await receive(e, 100); // estoque (need de 50 kg ligada ao item; 'atendida' não baixa mais)
    const out = await against(e, () =>
      postNeedsStatus(buildRequest("needs-status", { method: "POST", cookie: e.owner.cookie, body: { organizationId: e.orgId, needId: e.needId, status: "atendida" } }))
    );
    expect(out.holderOutcome).toEqual({ ok: true });
    expect(out.status).toBe(200);
    expect(await stock(e.itemId)).toBe(100); // sem baixa automática (Fase 99E);
  }, 30000);
});

describe("Fase 81 — rajada (a ordem de locks não depende de acidente)", () => {
  it("12 rodadas: aprovação física × recebimento do mesmo item (concorrentes) — sem deadlock, sem 5xx, sem saldo negativo", async () => {
    for (let i = 0; i < 12; i++) {
      const e = await setupEnv();
      const a = await receive(e);
      const id = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await token(e, a), quantity: 80 }));
      const platform = await createAuthenticatedUser();
      const source = await createTestSource(platform.userId);
      const opp = await createTestOpportunityRegistry(source.id, platform.userId, { unit: "kg", status: "reservada" });
      const [al2] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: opp.id, organizationId: e.orgId, quantityAllocated: "30", status: "aceita", needId: e.needId }).returning(["id"]).execute();
      const [dec, rec] = await Promise.all([
        decide(e, e.admin, id),
        postReceive(buildRequest("allocations-receive", { method: "POST", cookie: e.owner.cookie, body: { organizationId: e.orgId, allocationId: al2.id, itemId: e.itemId, quantityReceived: 30 } })),
      ]);
      expect([dec.status, rec.status]).toEqual([200, 200]);
      expect(await stock(e.itemId)).toBe(100 - 20 + 30);
    }
  }, 120000);

  it("12 rodadas: needs-status 'atendida' × recebimento × aprovação física (item e need em comum) — sem deadlock, sem 5xx, sem negativo", async () => {
    for (let i = 0; i < 12; i++) {
      const e = await setupEnv(true);
      const a = await receive(e);
      const id = await pendingId(await correct(e, a, e.operador, { expectedVigenteFulfillmentId: await token(e, a), quantity: 80 }));
      const platform = await createAuthenticatedUser();
      const source = await createTestSource(platform.userId);
      const opp = await createTestOpportunityRegistry(source.id, platform.userId, { unit: "kg", status: "reservada" });
      const [al2] = await db.insertInto("opportunityAllocations").values({ opportunityRegistryId: opp.id, organizationId: e.orgId, quantityAllocated: "30", status: "aceita", needId: e.needId }).returning(["id"]).execute();
      const results = await Promise.all([
        decide(e, e.admin, id),
        postReceive(buildRequest("allocations-receive", { method: "POST", cookie: e.owner.cookie, body: { organizationId: e.orgId, allocationId: al2.id, itemId: e.itemId, quantityReceived: 30 } })),
        postNeedsStatus(buildRequest("needs-status", { method: "POST", cookie: e.owner.cookie, body: { organizationId: e.orgId, needId: e.needId, status: "atendida" } })),
      ]);
      for (const r of results) expect(r.status).toBeLessThan(500);
      expect(await stock(e.itemId)).toBeGreaterThanOrEqual(0);
    }
  }, 180000);
});
